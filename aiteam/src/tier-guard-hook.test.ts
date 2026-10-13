import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { floorDenyCulprit } from "./tier-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "..", "hooks", "tier-guard.mjs");

// Os arquivos de que o hook precisa para rodar em node puro, sem node_modules: ele e o fecho
// dos seus imports relativos. Quem copia o hook para outro diretório copia esta lista.
const HOOK_FILES = ["hooks/tier-guard.mjs", "src/tier-core.mjs", "src/frontmatter.mjs", "src/tier-rules-loader.mjs", "src/gate-files-core.mjs"];

// O hook resolve SPEC.md e .claude/tier-rules.json a partir do cwd
// (`REPO = process.cwd()`). Rodá-lo na raiz do repo hospedeiro faria esta suíte
// afirmar o ESTADO daquele repo — um allow_tier3 ligado num break-glass, um
// consumidor sem SPEC.md — o erro que as issues #27 e #36 documentaram. Cada
// rodada usa uma raiz descartável com SPEC.md de gate fechado.
//
// As regras também são um fixture próprio, e não uma cópia das do hospedeiro:
// o tier-rules.json é mesclado à mão em cada consumidor, e quem ainda não
// trouxe os padrões novos veria esta suíte vermelha por uma propriedade do
// repo dele — o mesmo antipadrão. Aqui se testa o MECANISMO do hook (quais
// ferramentas, decisão, razão); o CONTEÚDO do arquivo real é fixado em
// tier-classifier.test.ts ("tier-rules.json real — invariantes do arquivo").
const REBOOT_HINT = "Host control is a human's job (fixture).";
const FIXTURE_RULES = {
  tier3: {
    label: "fixture",
    patterns: [
      "\\bgh\\s+workflow\\s+run\\s+\\S*deploy",
      "\\bremove-item\\b",
      "\\bssh\\b.*\\b(reboot|shutdown|poweroff)\\b",
    ],
    ask_patterns: ["\\bgh\\s+workflow\\s+run\\s+\\S*deploy"],
    deny_hints: [{ match: "\\bssh\\b.*\\b(reboot|shutdown|poweroff)\\b", hint: REBOOT_HINT }],
  },
  tier2: { label: "fixture", patterns: ["\\bgit\\s+commit\\b"] },
};

let root = "";
const roots: string[] = [];

// A throwaway root with the gate closed and the given rules file content.
function makeRoot(rulesJson: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "tier-guard-hook-"));
  roots.push(dir);
  writeFileSync(path.join(dir, "SPEC.md"), "---\ntier_defaults:\n  allow_tier3: false\n---\n\n# fixture\n");
  mkdirSync(path.join(dir, ".claude"));
  writeFileSync(path.join(dir, ".claude", "tier-rules.json"), rulesJson);
  return dir;
}

beforeAll(() => {
  root = makeRoot(JSON.stringify(FIXTURE_RULES));
});

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

type Decision = "allow" | "ask" | "deny";

// O ambiente do hook: o do runner SEM a AITEAM_UPSTREAM (uma sessão do upstream a põe no ambiente de quem roda
// os testes, e o consumidor que se afirma aqui deixaria de ser um), mais o que o teste pedir.
// Um valor null tira a variável do ambiente (o libuv só deixa de procurar no diretório de trabalho quando
// NoDefaultCurrentDirectoryInExePath está posta, e o harness da sessão a põe: o teste do executável plantado a tira).
type EnvPatch = Record<string, string | null>;
function hookEnv(extra: EnvPatch = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!("AITEAM_UPSTREAM" in extra)) delete env.AITEAM_UPSTREAM;
  // O Windows chama a variável de Path: sem tirar a de grafia diferente, as duas iriam no bloco do ambiente.
  const same = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  for (const [name, value] of Object.entries(extra)) {
    for (const key of Object.keys(env)) if (same(key, name)) delete env[key];
    if (value !== null) env[name] = value;
  }
  return env;
}

function run(payload: unknown, cwd = root, extraEnv: EnvPatch = {}): { decision: Decision; reason: string } {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    env: hookEnv(extraEnv),
  });
  expect(r.status, String(r.stderr ?? "")).toBe(0);
  const out = JSON.parse(String(r.stdout || "{}"));
  const hso = out?.hookSpecificOutput;
  return { decision: hso?.permissionDecision ?? "allow", reason: hso?.permissionDecisionReason ?? "" };
}

const DEPLOY = "gh workflow run deploy.yml -f ref=v1 -f confirm=deploy";

describe("tier-guard — a raiz descartável é mesmo a que o hook lê", () => {
  it("o fixture fecha o gate (allow_tier3: false)", () => {
    expect(readFileSync(path.join(root, "SPEC.md"), "utf8")).toMatch(/allow_tier3: false/);
  });

  // Prova de que o hook lê as regras do fixture, e não as do hospedeiro: este
  // padrão só existe aqui.
  it("as regras vêm do fixture", () => {
    const only = makeRoot(
      JSON.stringify({ tier3: { label: "t3", patterns: ["\\bfixture-only-marker\\b"] }, tier2: { label: "t2", patterns: [] } })
    );
    expect(run({ tool_name: "Bash", tool_input: { command: "fixture-only-marker" } }, only).decision).toBe("deny");
  });
});

// Issue #12: o PreToolUse só era registrado para o Bash e o hook liberava
// qualquer outra ferramenta. No Windows a ferramenta PowerShell executa comando
// — e por ela um deploy rodava sem o ASK e um `Remove-Item -Recurse -Force` sem
// deny. O Monitor e o terminal do app desktop também executam `command`.
describe("tier-guard — toda ferramenta que executa comando passa pelo gate", () => {
  it("PowerShell: deploy pela pipeline → ask", () => {
    expect(run({ tool_name: "PowerShell", tool_input: { command: DEPLOY } }).decision).toBe("ask");
  });

  it("PowerShell: Remove-Item recursivo e forçado → deny", () => {
    expect(run({ tool_name: "PowerShell", tool_input: { command: "Remove-Item -Recurse -Force .\\dist" } }).decision).toBe(
      "deny"
    );
  });

  it("PowerShell: comando inofensivo → allow", () => {
    expect(run({ tool_name: "PowerShell", tool_input: { command: "Get-ChildItem" } }).decision).toBe("allow");
  });

  it("Monitor: comando destrutivo → deny", () => {
    const payload = { tool_name: "Monitor", tool_input: { command: "git push --force origin main", description: "x" } };
    expect(run(payload).decision).toBe("deny");
  });

  it("Monitor só com ws (sem command) → allow", () => {
    const payload = {
      tool_name: "Monitor",
      tool_input: { ws: { url: "wss://events.example.test/stream" }, description: "events", timeout_ms: 60_000 },
    };
    expect(run(payload).decision).toBe("allow");
  });

  it("terminal do app desktop: destrutivo → deny", () => {
    const payload = { tool_name: "mcp__terminal__run_in_terminal", tool_input: { command: "Remove-Item -Recurse -Force .\\dist" } };
    expect(run(payload).decision).toBe("deny");
  });

  it("terminal do app desktop: deploy → ask", () => {
    expect(run({ tool_name: "mcp__terminal__run_in_terminal", tool_input: { command: DEPLOY } }).decision).toBe("ask");
  });

  // O despacho é pelo nome da ferramenta, não pela presença de um campo
  // `command`: uma ferramenta que não executa nada não vira comando por
  // acaso de schema.
  it("ferramenta que não executa comando → allow, mesmo com um campo command", () => {
    const payload = { tool_name: "Read", tool_input: { file_path: "README.md", command: "rm -rf build" } };
    expect(run(payload).decision).toBe("allow");
  });

  it("Bash continua igual", () => {
    expect(run({ tool_name: "Bash", tool_input: { command: "ls -la" } }).decision).toBe("allow");
    expect(run({ tool_name: "Bash", tool_input: { command: "rm -rf build" } }).decision).toBe("deny");
    expect(run({ tool_name: "Bash", tool_input: { command: DEPLOY } }).decision).toBe("ask");
  });

  it("payload ilegível não quebra o hook (fail open, como antes)", () => {
    const r = spawnSync(process.execPath, [HOOK], { input: "não é json", cwd: root, encoding: "utf8", timeout: 15_000 });
    expect(r.status).toBe(0);
    expect(String(r.stdout)).toBe("{}");
  });
});

// Issue #12, item 3: a razão do deny cita o trecho que bloqueia e vem por
// classe (`tier3.deny_hints` das regras), com o prefixo estável de antes.
describe("tier-guard — razão do deny", () => {
  const PREFIX = "Tier 3 (critical) command blocked by aiteam/hooks/tier-guard.mjs: ";
  const bash = (command: string) => run({ tool_name: "Bash", tool_input: { command } });

  it("reboot via ssh: cita o trecho e dá a razão da classe, sem sugerir o allow_tier3", () => {
    const { decision, reason } = bash("ssh vps sudo reboot");
    expect(decision).toBe("deny");
    expect(reason).toBe(`${PREFIX}"ssh vps sudo reboot". ${REBOOT_HINT}`);
    expect(reason).not.toMatch(/allow_tier3/);
  });

  it("destrutivo comum: a orientação de sempre", () => {
    const { decision, reason } = bash("rm -rf build");
    expect(decision).toBe("deny");
    expect(reason).toBe(
      `${PREFIX}"rm -rf build". Set tier_defaults.allow_tier3: true in SPEC.md after explicit human approval to permit it.`
    );
  });

  // F15: com um padrão pulado em ask_patterns (typo no arquivo) o deploy fecha para deny, o
  // que está certo — mas a razão mandava ligar o allow_tier3, um break-glass GLOBAL, para
  // consertar um typo. Agora aponta o doctor e diz para não ligar o flag.
  it("deploy negado por um ask_patterns quebrado: a razão aponta o doctor e manda não ligar o flag", () => {
    const dir = makeRoot(
      JSON.stringify({
        tier3: { label: "t3", patterns: ["\\bgh\\s+workflow\\s+run\\s+\\S*deploy", "\\bdrop\\s+table\\b"], ask_patterns: ["[unclosed"] },
        tier2: { label: "t2", patterns: [] },
      })
    );
    const { decision, reason } = run({ tool_name: "Bash", tool_input: { command: DEPLOY } }, dir);
    expect(decision).toBe("deny");
    expect(reason.startsWith(`${PREFIX}"${DEPLOY}". `)).toBe(true);
    expect(reason).toContain("node aiteam/scripts/doctor.mjs");
    expect(reason).toMatch(/do NOT turn on tier_defaults\.allow_tier3 for it/);
    expect(reason).not.toContain("Set tier_defaults.allow_tier3: true in SPEC.md after explicit human approval");
    // O guard não sabe dizer se o comando seria um deploy (o padrão de ask que o pegaria foi
    // pulado), então a razão é condicional: o destrutivo que não é deploy continua liberado só
    // pelo break-glass. O destrutivo do piso (rm -rf) nem entra nisso: orientação de sempre.
    const drop = run({ tool_name: "Bash", tool_input: { command: "psql -c 'drop table users'" } }, dir);
    expect(drop.reason).toMatch(/Otherwise it is a destructive command, released only by that flag after explicit human approval/);
    expect(run({ tool_name: "Bash", tool_input: { command: "rm -rf build" } }, dir).reason).toContain(
      "Set tier_defaults.allow_tier3: true in SPEC.md after explicit human approval"
    );
  });

  it("deploy + destrutivo: cita só o destrutivo e manda separar", () => {
    const { decision, reason } = run({ tool_name: "PowerShell", tool_input: { command: `${DEPLOY}; Remove-Item -Recurse -Force dist` } });
    expect(decision).toBe("deny");
    expect(reason.startsWith(`${PREFIX}"Remove-Item -Recurse -Force dist". `)).toBe(true);
    expect(reason).toMatch(/on its own/);
  });
});

// Revisão de segurança da #12, reproduzida com o hook real: o primeiro padrão
// não compilava, `new RegExp` lançava, o hook saía com exit 1 e stdout vazio —
// e o Claude Code trata isso como erro não-bloqueante, então o comando RODAVA.
describe("tier-guard — um padrão inválido não desliga o gate", () => {
  it("primeiro padrão inválido + drop table → deny, com exit 0 e JSON válido", () => {
    const broken = makeRoot(
      JSON.stringify({
        tier3: { label: "t3", patterns: ["unbalanced(paren", "\\bdrop\\s+(table|database)\\b"] },
        tier2: { label: "t2", patterns: ["\\bgit\\s+commit\\b"] },
      })
    );
    const payload = { tool_name: "PowerShell", tool_input: { command: 'psql -c "drop table users"' } };
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), cwd: broken, encoding: "utf8", timeout: 15_000 });
    expect(r.status, String(r.stderr ?? "")).toBe(0);
    const out = JSON.parse(String(r.stdout));
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain(`: "psql -c "drop table users"". `);
    expect(run({ tool_name: "PowerShell", tool_input: { command: "Get-ChildItem" } }, broken).decision).toBe("allow");
  });
});

// O .claude/tier-rules.json fica fora de aiteam/ e não viaja com o vendor. Antes,
// sem ele (adotante novo, arquivo apagado) ou com JSON inválido, o hook liberava
// TUDO: `rm -rf`, `drop` e deploy passavam sem pergunta. Agora ele usa a cópia
// canônica do framework (aiteam/templates/tier-rules.json, resolvida a partir do
// próprio módulo, não do cwd), avisa no motivo e continua protegendo. O hook é
// rodado de verdade, num repo descartável; os comandos só viajam no payload.
describe("tier-guard — sem o mapa de tiers do projeto, protege pela cópia canônica do framework", () => {
  const PREFIX = "Tier 3 (critical) command blocked by aiteam/hooks/tier-guard.mjs: ";
  const ASK_PREFIX = "Tier 3 deploy command — one-shot human approval required: ";
  const MISSING = " (regras do framework: .claude/tier-rules.json ausente — rode node aiteam/install.mjs)";
  const UNREADABLE =
    " (regras do framework: .claude/tier-rules.json ilegível — corrija-o ou apague-o e rode node aiteam/install.mjs)";
  const bash = (command: string, cwd: string) => run({ tool_name: "Bash", tool_input: { command } }, cwd);

  // Um repo com o SPEC.md de gate fechado e SEM o .claude/tier-rules.json.
  function makeBareRoot(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "tier-guard-bare-"));
    roots.push(dir);
    writeFileSync(path.join(dir, "SPEC.md"), "---\ntier_defaults:\n  allow_tier3: false\n---\n\n# fixture\n");
    return dir;
  }

  it("arquivo ausente: rm -rf / → deny e deploy → ask, ambos com o aviso de que são as regras do framework", () => {
    const bare = makeBareRoot();

    const denied = bash("rm -rf /", bare);
    expect(denied.decision).toBe("deny");
    expect(denied.reason.startsWith(`${PREFIX}"rm -rf /". `)).toBe(true);
    expect(denied.reason.endsWith(MISSING)).toBe(true);

    for (const deploy of ["npx prisma migrate deploy", DEPLOY]) {
      const asked = bash(deploy, bare);
      expect(asked.decision, deploy).toBe("ask");
      expect(asked.reason.startsWith(`${ASK_PREFIX}"${deploy}". `), deploy).toBe(true);
      expect(asked.reason.endsWith(MISSING), deploy).toBe(true);
    }
  });

  it("arquivo ausente: o que é inofensivo segue livre, sem aviso nenhum", () => {
    const bare = makeBareRoot();
    for (const command of ["ls -la", "git status", "git commit -m x"]) {
      expect(bash(command, bare), command).toEqual({ decision: "allow", reason: "" });
    }
  });

  it("arquivo ausente: vale para toda ferramenta que executa comando (PowerShell)", () => {
    const bare = makeBareRoot();
    const r = run({ tool_name: "PowerShell", tool_input: { command: "Remove-Item -Recurse -Force .\\dist" } }, bare);
    expect(r.decision).toBe("deny");
    expect(r.reason.endsWith(MISSING)).toBe(true);
  });

  it.each([
    ["JSON inválido", "{ isso não é json"],
    ["arquivo vazio", ""],
    ["estrutura inválida (tier3.patterns não é lista)", JSON.stringify({ tier3: { patterns: "x" }, tier2: { patterns: [] } })],
    ["estrutura inválida (sem tier3)", JSON.stringify({ tier2: { patterns: ["\\bgit\\s+commit\\b"] } })],
    ["tier3.patterns vazio", JSON.stringify({ tier3: { patterns: [] }, tier2: { patterns: [] } })],
    // O guard pula o padrão que não compila e o que não é texto: sem nenhum que
    // compile ele só teria o piso fixo, então o mapa não serve e vale a canônica.
    ["tier3.patterns só com padrões que não compilam", JSON.stringify({ tier3: { patterns: ["(", "[a-"] }, tier2: { patterns: [] } })],
    ["tier3.patterns só com entradas que não são texto", JSON.stringify({ tier3: { patterns: [123] }, tier2: { patterns: [] } })],
    // `""` compila e casa com tudo (negaria até o `ls`): o guard o pula, como ao que não compila.
    ["tier3.patterns só com texto vazio ou só espaço", JSON.stringify({ tier3: { patterns: ["", "  "] }, tier2: { patterns: [] } })],
    ["um valor que não é objeto", "[]"],
  ])("arquivo ilegível — %s: protege pela cópia canônica e avisa", (_label, content) => {
    const dir = makeRoot(content);

    const denied = bash("rm -rf /", dir);
    expect(denied.decision).toBe("deny");
    expect(denied.reason.endsWith(UNREADABLE)).toBe(true);

    const asked = bash("npx prisma migrate deploy", dir);
    expect(asked.decision).toBe("ask");
    expect(asked.reason.endsWith(UNREADABLE)).toBe(true);
  });

  // O mapa do projeto com um `""` ao lado de padrões bons: o hook de verdade segue livre
  // para o que é inofensivo e, em ask_patterns, o destrutivo não vira ask.
  it("um padrão vazio no mapa do projeto não nega tudo nem abre o destrutivo", () => {
    const dir = makeRoot(
      JSON.stringify({
        tier3: {
          patterns: ["", "\\bdrop\\s+table\\b", "\\bgh\\s+workflow\\s+run\\s+\\S*deploy"],
          ask_patterns: ["", "\\bgh\\s+workflow\\s+run\\s+\\S*deploy"],
        },
        tier2: { patterns: ["\\bgit\\s+commit\\b"] },
      })
    );
    expect(bash("ls -la", dir)).toEqual({ decision: "allow", reason: "" });
    expect(bash("psql -c 'drop table users'", dir).decision).toBe("deny");
    expect(bash(DEPLOY, dir).decision).toBe("ask");
  });

  it("um padrão que compila basta: o mapa continua sendo do projeto, sem aviso", () => {
    const dir = makeRoot(
      JSON.stringify({ tier3: { patterns: ["(", "\\bmeu-marcador\\b"] }, tier2: { patterns: [] } })
    );
    const denied = bash("meu-marcador", dir);
    expect(denied.decision).toBe("deny");
    expect(denied.reason).not.toMatch(/regras do framework|sem regras/);
    // A cópia canônica NÃO vale aqui: o que só ela pega passa.
    expect(bash("npx prisma migrate deploy", dir).decision).toBe("allow");
  });

  it("arquivo do projeto válido: usa o do projeto, e o aviso não aparece", () => {
    // O fixture do projeto só conhece o gh workflow run ...deploy; o `prisma migrate
    // deploy` é da cópia canônica e não pode vazar para dentro de um projeto válido.
    expect(bash("npx prisma migrate deploy", root)).toEqual({ decision: "allow", reason: "" });

    const asked = bash(DEPLOY, root);
    expect(asked.decision).toBe("ask");
    expect(asked.reason).not.toMatch(/regras do framework/);
    const denied = bash("ssh vps sudo reboot", root);
    expect(denied.decision).toBe("deny");
    expect(denied.reason).not.toMatch(/regras do framework/);
  });

  it("arquivo ausente + break-glass allow_tier3 ligado → allow (o fallback respeita o SPEC como o arquivo do projeto)", () => {
    const bare = makeBareRoot();
    writeFileSync(path.join(bare, "SPEC.md"), "---\ntier_defaults:\n  allow_tier3: true\n---\n\n# fixture\n");
    expect(bash("rm -rf /", bare).decision).toBe("allow");
  });

  // Último recurso (decisão do PO): se nem o template do framework lê (um vendor
  // incompleto ou corrompido), o hook segue o fluxo normal com regras VAZIAS e o
  // piso fixo do tier-core continua valendo — `rm -rf` e `git push --force` são
  // negados. NÃO nega tudo: isso travaria o conserto (`git checkout`,
  // `node aiteam/install.mjs`). E também não libera tudo. O que só um padrão pega
  // (drop table, deploy) passa; o doctor reprova e o brief da sessão avisa.
  describe("framework quebrado (sem o template canônico legível): só o piso fixo", () => {
    const NO_RULES_MISSING =
      " (sem regras: .claude/tier-rules.json ausente e a cópia canônica do framework também não serve — só vale o piso fixo (rm -rf e force-push); restaure o aiteam/ e rode node aiteam/install.mjs)";
    const NO_RULES_UNREADABLE = NO_RULES_MISSING.replace("ausente", "ilegível");

    // "real" = o template do framework; "absent" = sem o arquivo; { content } = um arquivo qualquer no lugar dele.
    type Template = "real" | "absent" | { content: string };
    // Uma cópia do hook e dos módulos que ele importa, num aiteam/ descartável.
    function copyHook(dir: string, template: Template): string {
      const aiteam = path.join(dir, "aiteam");
      for (const rel of HOOK_FILES) {
        mkdirSync(path.dirname(path.join(aiteam, rel)), { recursive: true });
        copyFileSync(path.join(HERE, "..", rel), path.join(aiteam, rel));
      }
      if (template !== "absent") {
        mkdirSync(path.join(aiteam, "templates"), { recursive: true });
        const dest = path.join(aiteam, "templates", "tier-rules.json");
        if (template === "real") copyFileSync(path.join(HERE, "..", "templates", "tier-rules.json"), dest);
        else writeFileSync(dest, template.content);
      }
      return path.join(aiteam, "hooks", "tier-guard.mjs");
    }
    const runHook = (hook: string, cwd: string, command: string): { decision: Decision; reason: string } => {
      const r = spawnSync(process.execPath, [hook], {
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
        cwd,
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(r.status, String(r.stderr ?? "")).toBe(0);
      const hso = JSON.parse(String(r.stdout || "{}"))?.hookSpecificOutput;
      return { decision: (hso?.permissionDecision ?? "allow") as Decision, reason: hso?.permissionDecisionReason ?? "" };
    };

    it("controle: o mesmo hook copiado COM o template protege (o template vem do módulo, não do cwd)", () => {
      const dir = makeBareRoot();
      const hook = copyHook(dir, "real");
      expect(runHook(hook, dir, "rm -rf /").decision).toBe("deny");
      expect(runHook(hook, dir, "npx prisma migrate deploy").decision).toBe("ask");
    });

    it.each([
      ["ausente", "absent" as Template],
      ["corrompido (JSON inválido)", { content: "{ isso não é json" } as Template],
      ["vazio", { content: "" } as Template],
      ["com estrutura inválida (tier3.patterns vazio)", { content: JSON.stringify({ tier3: { patterns: [] } }) } as Template],
      ["só com padrões que não compilam", { content: JSON.stringify({ tier3: { patterns: ["(", "[a-"] } }) } as Template],
    ])("template %s e sem o arquivo do projeto: rm -rf / e git push --force → deny; ls → allow", (_label, template) => {
      const dir = makeBareRoot();
      const hook = copyHook(dir, template);

      for (const command of ["rm -rf /", "git push --force origin main"]) {
        const denied = runHook(hook, dir, command);
        expect(denied.decision, command).toBe("deny");
        expect(denied.reason.startsWith(`${PREFIX}"${command}". `), command).toBe(true);
        expect(denied.reason.endsWith(NO_RULES_MISSING), command).toBe(true);
      }
      expect(runHook(hook, dir, "ls")).toEqual({ decision: "allow", reason: "" });
    });

    it("não nega tudo: o conserto segue livre (git checkout, node aiteam/install.mjs)", () => {
      const dir = makeBareRoot();
      const hook = copyHook(dir, "absent");
      for (const command of ["git checkout -- aiteam", "node aiteam/install.mjs", "git status", "git push --force-with-lease origin x"]) {
        expect(runHook(hook, dir, command), command).toEqual({ decision: "allow", reason: "" });
      }
    });

    // O limite conhecido e decidido pelo PO: o que só um padrão pega passa.
    it("drop table e deploy passam sem regras: só o piso protege", () => {
      const dir = makeBareRoot();
      const hook = copyHook(dir, "absent");
      expect(runHook(hook, dir, "psql -c 'drop table users'").decision).toBe("allow");
      expect(runHook(hook, dir, "npx prisma migrate deploy").decision).toBe("allow");
      expect(runHook(hook, dir, DEPLOY).decision).toBe("allow");
    });

    it("arquivo do projeto ilegível e sem template: o motivo diz ilegível", () => {
      const dir = makeRoot("{ nope");
      const hook = copyHook(dir, "absent");
      const denied = runHook(hook, dir, "rm -rf /");
      expect(denied.decision).toBe("deny");
      expect(denied.reason.endsWith(NO_RULES_UNREADABLE)).toBe(true);
    });

    it("arquivo do projeto válido e sem template: usa o do projeto, e o template nem é lido", () => {
      const dir = makeRoot(JSON.stringify(FIXTURE_RULES));
      const hook = copyHook(dir, "absent");
      const asked = runHook(hook, dir, DEPLOY);
      expect(asked.decision).toBe("ask");
      expect(asked.reason).not.toMatch(/sem regras|regras do framework/);
    });

    it("break-glass allow_tier3 ligado → allow também no piso", () => {
      const dir = makeBareRoot();
      writeFileSync(path.join(dir, "SPEC.md"), "---\ntier_defaults:\n  allow_tier3: true\n---\n\n# fixture\n");
      const hook = copyHook(dir, "absent");
      expect(runHook(hook, dir, "rm -rf /").decision).toBe("allow");
    });
  });
});

// F14: o cabeçalho do tier-core dizia "dependency-free" e a lista de arquivos que o hook copiado
// precisa ficou desatualizada em silêncio quando o tier-core passou a importar o frontmatter.mjs.
// A lista que o copyHook copia é o fecho dos imports do hook — conferido no código, não de cabeça.
describe("tier-guard — os módulos que o hook copiado leva são o fecho dos seus imports", () => {
  // Os imports relativos (./x.mjs, ../src/x.mjs) de um módulo; `fs`, `path` e `node:*` não entram.
  // O hook carrega o tier-core e o carregador por `import()` (para um módulo quebrado não derrubar
  // o hook antes de o piso rodar), então os imports dinâmicos entram no fecho como os estáticos.
  const relativeImports = (file: string): string[] => {
    const text = readFileSync(file, "utf8");
    const specs = [
      ...text.matchAll(/^\s*import\b[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']/gm),
      ...text.matchAll(/\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g),
    ].map((m) => m[1]!);
    return [...new Set(specs)].map((spec) => path.resolve(path.dirname(file), spec));
  };

  it("o fecho dos imports relativos de hooks/tier-guard.mjs é exatamente HOOK_FILES", () => {
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

  it("nenhum deles importa pacote nem node:* além do fs/path/url/vm do próprio hook e do loader", () => {
    const bare = (file: string): string[] =>
      [...readFileSync(file, "utf8").matchAll(/^\s*import\b[^;]*?from\s+["']([^"'.][^"']*)["']/gm)].map((m) => m[1]!);
    const found: Record<string, string[]> = {};
    for (const rel of HOOK_FILES) found[rel] = bare(path.join(HERE, "..", rel));
    // Só builtins do node, nunca um pacote do npm (o hook roda sem node_modules).
    for (const [rel, specs] of Object.entries(found)) {
      for (const spec of specs) expect(/^(node:)?(fs|path|url|vm|child_process)$/.test(spec), `${rel} importa ${spec}`).toBe(true);
    }
    expect(found["src/tier-core.mjs"]).toEqual([]);
    expect(found["src/frontmatter.mjs"]).toEqual([]);
  });
});

// ReDoS no padrão de ssh: o hook roda cada padrão contra o comando inteiro, e o
// timeout de um hook é falha ABERTA — um comando que o faz estourar o tempo roda
// sem o gate. `ssh` + 36 flags `-a` (111 bytes) já levava 1 s no padrão antigo, e
// o custo dobrava a cada duas flags. Aqui o hook de verdade, com o mapa canônico,
// recebe linhas com centenas de flags; o timeout curto transforma o travamento em
// falha do teste, em vez de pendurar a suíte.
describe("tier-guard — comandos com centenas de flags não estouram o hook", () => {
  const TEMPLATE_JSON = readFileSync(path.join(HERE, "..", "templates", "tier-rules.json"), "utf8");
  const flags = (n: number): string => " -a".repeat(n);

  function timed(command: string, dir: string): { decision: Decision; ms: number; status: number | null } {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
      cwd: dir,
      encoding: "utf8",
      timeout: 5_000,
    });
    const hso = JSON.parse(String(r.stdout || "{}"))?.hookSpecificOutput;
    return { decision: (hso?.permissionDecision ?? "allow") as Decision, ms: Date.now() - t0, status: r.status };
  }

  it.each([
    ["sem script no fim (a falha é o que força o backtracking)", `ssh${flags(300)}`, "allow"],
    ["com o script no fim: continua sendo um deploy a perguntar", `ssh${flags(300)} deploy@vps ./deploy.sh`, "ask"],
    ["flags e um comando remoto que não é deploy", `ssh${flags(300)} vps ls -la`, "allow"],
    ["flags com argumento, ainda sem script", `ssh${" -p 22".repeat(150)} vps`, "allow"],
  ])("%s", (_label, command, expected) => {
    const dir = makeRoot(TEMPLATE_JSON);
    const r = timed(command, dir);
    expect(r.status, `o hook não terminou em 5 s: ${command.slice(0, 40)}...`).toBe(0);
    expect(r.decision).toBe(expected);
    expect(r.ms).toBeLessThan(4_000);
  });
});

// Onda 2, item 1 — prazo na classificação. Reescrever os padrões um a um não
// basta: o QA achou o terceiro padrão cúbico depois de a onda 1 fechar o
// exponencial. O que o hook controla é o PRAZO: a classificação inteira roda com
// 2 s e, estourando, NEGA (fail-closed) e pede para dividir o comando. O timeout
// do próprio hook é falha ABERTA, então o prazo tem de vir antes dele. Os padrões
// patológicos abaixo são um fixture deste teste (o MECANISMO do prazo), e não o
// conteúdo do template, que muda a cada rodada de endurecimento.
describe("tier-guard — a classificação tem prazo e estourar nega", () => {
  const CUBIC = "\\bssh\\b.*\\b(bash|sh|zsh)\\s+[^|;&]*\\.(sh|bash)\\b";
  const QUADRATIC = "\\bssh\\b(?:\\s+-\\w+(?:\\s+(?!-\\w+(?=\\s|$))\\S+)?)*\\s+\\S+\\s+[\"']?[~./]\\S*\\.(?:sh|bash)\\b";
  const REDOS_RULES = JSON.stringify({
    tier3: { label: "fixture", patterns: [CUBIC, QUADRATIC, "\\bdrop\\s+table\\b"], ask_patterns: [] },
    tier2: { label: "fixture", patterns: [] },
  });
  const TEMPLATE_JSON = readFileSync(path.join(HERE, "..", "templates", "tier-rules.json"), "utf8");
  const SPLIT = /split/i;

  type Full = { status: number | null; ms: number; out: Record<string, unknown>; stderr: string };
  // O hook de verdade com o prazo padrão (2 s) ou um menor (só vale para baixo, ver os testes).
  function timedRun(command: string, dir: string, env: Record<string, string> = {}): Full & { decision: Decision; reason: string } {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
      cwd: dir,
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, ...env },
    });
    const out = JSON.parse(String(r.stdout || "{}")) as Record<string, unknown>;
    const hso = out.hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string } | undefined;
    return {
      status: r.status,
      ms: Date.now() - t0,
      out,
      stderr: String(r.stderr ?? ""),
      decision: (hso?.permissionDecision ?? "allow") as Decision,
      reason: hso?.permissionDecisionReason ?? "",
    };
  }

  it("payload cúbico de 64 KB: nega dentro do prazo, com a mensagem de dividir o comando", () => {
    const dir = makeRoot(REDOS_RULES);
    const command = "ssh sh ".repeat(Math.ceil(65_536 / 7)) + "!";
    const r = timedRun(command, dir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(SPLIT);
    expect(r.reason).toMatch(/2000 ms/);
    expect(r.ms).toBeLessThan(6_000);
  });

  it("payload quadrático de 64 KB: nega dentro do prazo, com a mensagem de dividir o comando", () => {
    const dir = makeRoot(REDOS_RULES);
    const command = "rm -" + "-r ssh ".repeat(Math.ceil(65_536 / 7)) + "!";
    const r = timedRun(command, dir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(SPLIT);
    expect(r.ms).toBeLessThan(6_000);
  });

  // O prazo só pode DESCER por ambiente (os testes encurtam a espera); subir enfraqueceria
  // o gate, e o ambiente do hook é o do usuário, que o agente pode influenciar.
  it("o prazo vem de AITEAM_TIER_GUARD_DEADLINE_MS, mas só para baixo", () => {
    const dir = makeRoot(REDOS_RULES);
    const command = "ssh sh ".repeat(Math.ceil(16_384 / 7)) + "!";
    const short = timedRun(command, dir, { AITEAM_TIER_GUARD_DEADLINE_MS: "250" });
    expect(short.decision).toBe("deny");
    expect(short.reason).toMatch(/250 ms/);
    expect(short.ms).toBeLessThan(3_000);
    // Um valor maior que o padrão é ignorado: o prazo segue 2000 ms.
    const long = timedRun(command, dir, { AITEAM_TIER_GUARD_DEADLINE_MS: "60000" });
    expect(long.decision).toBe("deny");
    expect(long.reason).toMatch(/2000 ms/);
    expect(long.ms).toBeLessThan(6_000);
    // Lixo no ambiente também cai no padrão.
    expect(timedRun(command, dir, { AITEAM_TIER_GUARD_DEADLINE_MS: "abc" }).reason).toMatch(/2000 ms/);
  });

  // Os comandos legítimos grandes têm de passar com o mapa de verdade e no prazo.
  describe("comandos legítimos grandes passam com o mapa canônico", () => {
    const prose = (n: number): string => {
      const lines: string[] = [];
      let size = 0;
      for (let i = 0; size < n; i++) {
        const l = `- item ${i}: ajusta o gate de tiers e o doctor (rm de arquivos temporários, ssh de teste), sem mudar o contrato`;
        lines.push(l);
        size += l.length + 1;
      }
      return lines.join("\n");
    };

    it("git commit com heredoc de ~27 KB → allow", () => {
      const dir = makeRoot(TEMPLATE_JSON);
      const command = `git commit -F - <<'EOF'\nfeat(tiers): ajusta o gate\n\n${prose(27_000)}\nEOF`;
      expect(command.length).toBeGreaterThan(27_000);
      const r = timedRun(command, dir);
      expect(r.status, r.stderr).toBe(0);
      expect(r.decision).toBe("allow");
      expect(r.ms).toBeLessThan(4_000);
    });

    it("node -e de ~60 KB → allow", () => {
      const dir = makeRoot(TEMPLATE_JSON);
      const body = Array.from({ length: 1_500 }, (_, i) => `const v${i} = ${i} + 1; if (v${i} < 0) console.log("v${i}");`).join("\n");
      const command = `node -e '${body}'`;
      expect(command.length).toBeGreaterThan(60_000);
      const r = timedRun(command, dir);
      expect(r.status, r.stderr).toBe(0);
      expect(r.decision).toBe("allow");
      expect(r.ms).toBeLessThan(4_000);
    });

    it("um comando comum segue sem a mensagem do prazo", () => {
      const dir = makeRoot(TEMPLATE_JSON);
      const r = timedRun("ls -la", dir);
      expect(r.decision).toBe("allow");
      expect(r.reason).toBe("");
    });
  });

  it("o deny normal continua com o culpado e a orientação de sempre (o prazo não os troca)", () => {
    const dir = makeRoot(REDOS_RULES);
    const r = timedRun("psql -c 'drop table users'", dir);
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/^Tier 3 \(critical\) command blocked by aiteam\/hooks\/tier-guard\.mjs: "psql -c 'drop table users'"\. Set tier_defaults\.allow_tier3/);
    expect(r.reason).not.toMatch(SPLIT);
  });
});

// Onda 2, item 2 (F3) — uma exceção que o hook não esperava (um bug do classificador, do
// carregador, um módulo do vendor corrompido, um throw assíncrono) saía com status 1 e stdout
// vazio, que o Claude Code trata como erro NÃO-bloqueante: o comando rodava com o gate inteiro
// desligado. Agora o hook aplica o piso fixo do tier-core (o mesmo do último recurso do #49):
// nega `rm -rf` e `git push --force`, libera o resto e AVISA. Se nem o piso puder ser avaliado,
// nega (último recurso, decisão registrada no cabeçalho do hook). A falha é forçada numa cópia
// do hook com um módulo quebrado — nenhuma alavanca de teste existe no hook de verdade.
describe("tier-guard — uma exceção inesperada aplica o piso fixo (F3)", () => {
  type Patches = Record<string, (src: string) => string>;
  // Uma cópia do hook e do fecho dos seus imports num diretório descartável, com um patch por
  // módulo (a falha que se quer forçar).
  function brokenHook(dir: string, patches: Patches = {}): string {
    const aiteam = path.join(dir, "aiteam");
    for (const file of HOOK_FILES) {
      mkdirSync(path.dirname(path.join(aiteam, file)), { recursive: true });
      const src = readFileSync(path.join(HERE, "..", file), "utf8");
      writeFileSync(path.join(aiteam, file), patches[file] ? patches[file]!(src) : src);
    }
    return path.join(aiteam, "hooks", "tier-guard.mjs");
  }
  // Insere `code` na primeira linha do corpo da função `signature`.
  const insertIn = (signature: RegExp, code: string) => (src: string): string => {
    expect(src).toMatch(signature);
    return src.replace(signature, (m) => `${m}\n  ${code}`);
  };
  const GUARD_DECISION = /export function guardDecision\(command, rules, allowTier3\) \{/;
  const FLOOR = /export function floorDenyCulprit\(command, \{ split = splitSubCommands \} = \{\}\) \{/;
  const LOADER = /export function loadTierRulesWithFallback\([^)]*\) \{/;
  const throwing = (re: RegExp, msg: string) => insertIn(re, `throw new Error(${JSON.stringify(msg)});`);
  // Um módulo que, ao carregar, deixa um erro assíncrono para trás — e o loader demora 150 ms,
  // para o hook ainda estar vivo (esperando o import) quando o erro dispara.
  const SLOW_LOADER = (src: string): string => `${src}\nawait new Promise((resolve) => setTimeout(resolve, 150));\n`;

  type Out = { decision: Decision; reason: string; systemMessage: string; status: number | null; stderr: string };
  function runBroken(hook: string, cwd: string, command: string, tool = "Bash"): Out {
    const r = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ tool_name: tool, tool_input: { command } }),
      cwd,
      encoding: "utf8",
      timeout: 15_000,
    });
    const out = JSON.parse(String(r.stdout || "{}")) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      systemMessage?: string;
    };
    return {
      status: r.status,
      stderr: String(r.stderr ?? ""),
      decision: (out.hookSpecificOutput?.permissionDecision ?? "allow") as Decision,
      reason: out.hookSpecificOutput?.permissionDecisionReason ?? "",
      systemMessage: out.systemMessage ?? "",
    };
  }
  const PREFIX = "Tier 3 (critical) command blocked by aiteam/hooks/tier-guard.mjs: ";
  const FLOOR_DENY = [["rm -rf /"], ["git push --force origin main"], ["ls && rm -rf build"], ["rm -fr dist"]];
  const FLOOR_ALLOW = [["ls -la"], ["git status"], ["psql -c 'drop table users'"], [DEPLOY], ["git push --force-with-lease origin x"]];

  // Cada falha é uma maneira de o hook cair: dentro da classificação (no vm), fora dela (o
  // carregador de regras), um erro assíncrono depois do import, uma exceção sem captura e o
  // vendor quebrado (o módulo nem carrega). Em todas o resultado é o mesmo piso.
  const FAILURES: Array<[string, Patches]> = [
    ["erro (não-timeout) dentro da classificação", { "src/tier-core.mjs": throwing(GUARD_DECISION, "forced by the test") }],
    ["erro fora da classificação (o carregador de regras)", { "src/tier-rules-loader.mjs": throwing(LOADER, "forced by the test") }],
    [
      "rejeição de promise sem tratamento (throw assíncrono)",
      { "src/tier-core.mjs": (s) => `${s}\nPromise.reject(new Error("forced by the test"));\n`, "src/tier-rules-loader.mjs": SLOW_LOADER },
    ],
    [
      "exceção sem captura num timer",
      { "src/tier-core.mjs": (s) => `${s}\nsetTimeout(() => { throw new Error("forced by the test"); }, 0);\n`, "src/tier-rules-loader.mjs": SLOW_LOADER },
    ],
    ["módulo do vendor que nem carrega (erro de sintaxe)", { "src/tier-core.mjs": () => "export const broken = ;\n// forced by the test\n" }],
  ];

  it("controle: a mesma cópia sem falha decide normalmente", () => {
    const dir = makeRoot(JSON.stringify(FIXTURE_RULES));
    const hook = brokenHook(dir);
    expect(runBroken(hook, dir, "Remove-Item x").decision).toBe("deny");
    expect(runBroken(hook, dir, DEPLOY).decision).toBe("ask");
    expect(runBroken(hook, dir, "ls").systemMessage).toBe("");
  });

  describe.each(FAILURES)("%s", (_label, patches) => {
    it.each(FLOOR_DENY)("%s → deny pelo piso, e o motivo conta a falha", (command) => {
      const dir = makeRoot(JSON.stringify(FIXTURE_RULES));
      const r = runBroken(brokenHook(dir, patches), dir, command);
      expect(r.status, r.stderr).toBe(0);
      expect(r.decision).toBe("deny");
      expect(r.reason.startsWith(PREFIX)).toBe(true);
      expect(r.reason).toMatch(/internal error/);
      expect(r.reason).toMatch(/fixed floor/);
    });

    it.each(FLOOR_ALLOW)("%s → allow (o piso libera o resto) e o aviso sai em systemMessage", (command) => {
      const dir = makeRoot(JSON.stringify(FIXTURE_RULES));
      const r = runBroken(brokenHook(dir, patches), dir, command);
      expect(r.status, r.stderr).toBe(0);
      expect(r.decision).toBe("allow");
      expect(r.systemMessage).toMatch(/internal error/);
      expect(r.systemMessage).toMatch(/fixed floor/);
      expect(r.stderr).toMatch(/internal error/);
    });
  });

  it("a causa vai na mensagem (a exceção forçada)", () => {
    const dir = makeRoot(JSON.stringify(FIXTURE_RULES));
    const hook = brokenHook(dir, { "src/tier-core.mjs": throwing(GUARD_DECISION, "forced by the test") });
    expect(runBroken(hook, dir, "rm -rf /").reason).toMatch(/forced by the test/);
    expect(runBroken(hook, dir, "ls").systemMessage).toMatch(/forced by the test/);
  });

  it("vale para toda ferramenta que executa comando (PowerShell, Monitor, o terminal do app)", () => {
    const dir = makeRoot(JSON.stringify(FIXTURE_RULES));
    const hook = brokenHook(dir, { "src/tier-core.mjs": throwing(GUARD_DECISION, "forced by the test") });
    for (const tool of ["PowerShell", "Monitor", "mcp__terminal__run_in_terminal"]) {
      expect(runBroken(hook, dir, "rm -Recurse -Force .\\dist", tool).decision, tool).toBe("deny");
      expect(runBroken(hook, dir, "Get-ChildItem", tool).decision, tool).toBe("allow");
    }
  });

  it("break-glass allow_tier3 ligado → o piso também libera (como libera qualquer regra), com o aviso", () => {
    const dir = makeRoot(JSON.stringify(FIXTURE_RULES));
    writeFileSync(path.join(dir, "SPEC.md"), "---\ntier_defaults:\n  allow_tier3: true\n---\n\n# fixture\n");
    const hook = brokenHook(dir, { "src/tier-core.mjs": throwing(GUARD_DECISION, "forced by the test") });
    const r = runBroken(hook, dir, "rm -rf /");
    expect(r.decision).toBe("allow");
    expect(r.systemMessage).toMatch(/internal error/);
  });

  // O vendor quebrado: o tier-core nem carrega, então o hook leva o piso grosso dentro de si
  // (as duas regras do tier-core, sobre o texto todo). Este teste o mantém igual ao do tier-core.
  it("vendor quebrado: o piso embutido no hook decide como o piso grosso do tier-core", () => {
    const dir = makeRoot(JSON.stringify(FIXTURE_RULES));
    const hook = brokenHook(dir, { "src/tier-core.mjs": () => "export const broken = ;\n" });
    const broken = () => {
      throw new Error("x");
    };
    for (const command of [
      "rm -rf /", "rm -fr build", "rm -r -f dist", "rm -Recurse -Force dist", "rm --recursive --force x", "git push --force origin main",
      "git push origin main --force", "ls && rm -rf /", "echo rm -rf /", "git push --force-with-lease origin x", "ls -la", "git status",
      "rm -r build", "rm -f a.txt", "git push origin main", "psql -c 'drop table users'",
    ]) {
      const expected = floorDenyCulprit(command, { split: broken }) !== null;
      expect(runBroken(hook, dir, command).decision === "deny", command).toBe(expected);
    }
  });

  // Se nem o piso puder ser avaliado, não há o que o garanta: nega, com a razão clara.
  it("o piso também lança → deny de tudo, com a razão clara (último recurso)", () => {
    const dir = makeRoot(JSON.stringify(FIXTURE_RULES));
    const hook = brokenHook(dir, {
      "src/tier-core.mjs": (src) => throwing(FLOOR, "floor forced by the test")(throwing(GUARD_DECISION, "forced by the test")(src)),
    });
    for (const command of ["ls", "rm -rf /"]) {
      const r = runBroken(hook, dir, command);
      expect(r.status, r.stderr).toBe(0);
      expect(r.decision, command).toBe("deny");
      expect(r.reason).toMatch(/could not even apply its fixed floor/);
      expect(r.reason).toMatch(/floor forced by the test/);
    }
  });

  it("sem command para classificar (payload sem ele), nem o erro nem o aviso aparecem", () => {
    const dir = makeRoot(JSON.stringify(FIXTURE_RULES));
    const hook = brokenHook(dir, { "src/tier-core.mjs": throwing(GUARD_DECISION, "forced by the test") });
    const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: "Bash", tool_input: {} }), cwd: dir, encoding: "utf8", timeout: 15_000 });
    expect(r.status).toBe(0);
    expect(String(r.stdout)).toBe("{}");
  });
});

// Onda 2, item 7 (F13) — o comando de SHELL que grava num arquivo do gate pede confirmação, como a
// edição por Write/Edit (aiteam/hooks/gate-edit-guard.mjs, com os seus testes). O tier-guard vê os
// comandos de Bash, PowerShell, Monitor e do terminal do app: `sed -i`, `>`, `Set-Content`,
// `Out-File`, `cp`/`mv` por cima, `tee`, `node -e … writeFileSync`. O ASK é a aprovação; o break-glass
// não o dispensa (editar o gate é editar o gate), e o deny do Tier 3 continua ganhando.
describe("tier-guard — comando de shell que grava no gate pede confirmação (F13)", () => {
  const PREFIX = "Gate file write — one-shot human approval required: ";
  const bash = (command: string, cwd = root) => run({ tool_name: "Bash", tool_input: { command } }, cwd);

  it.each([
    ["sed -i 's/a/b/' .claude/tier-rules.json"],
    ["sed -i 's/allow_tier3: false/allow_tier3: true/' SPEC.md"],
    // Decisão do PO: toda edição in-place do SPEC.md pede, nomeie ou não a chave do break-glass.
    ["sed -i '4s/false/true/' SPEC.md"],
    ["sed -i.bak 's/a/b/' ./SPEC.md"],
    ["perl -pi -e 's/false/true/ if $. == 4' SPEC.md"],
    ["echo '{}' > .claude/tier-rules.json"],
    ["cat new.json >> .claude/settings.json"],
    ["echo x | tee .claude/settings.json"],
    ["cp /tmp/new.json .claude/tier-rules.json"],
    ["mv /tmp/s.json .claude/settings.json"],
    ["cat template > SPEC.md"],
    ["rm .claude/tier-rules.json"],
    ["node -e \"require('fs').writeFileSync('.claude/tier-rules.json','{}')\""],
    ["python3 -c \"open('.claude/settings.json','w').write('{}')\""],
    ["bash -c \"echo x > .claude/tier-rules.json\""],
    ["git status && echo '{}' > .claude/settings.json"],
  ])("Bash: %s → ask", (command) => {
    const r = bash(command);
    expect(r.decision, command).toBe("ask");
    expect(r.reason.startsWith(PREFIX), r.reason).toBe(true);
    expect(r.reason).toMatch(/\.claude|SPEC\.md/);
  });

  it.each([
    ["PowerShell", "Set-Content -Path .claude\\tier-rules.json -Value '{}'"],
    ["PowerShell", "'{}' | Out-File .claude/settings.json"],
    ["PowerShell", "(Get-Content SPEC.md) -replace 'false','true' | Set-Content SPEC.md"],
    ["PowerShell", "Copy-Item a.json .claude\\tier-rules.json -Force"],
    ["Monitor", "sed -i 's/a/b/' .claude/settings.json"],
    ["mcp__terminal__run_in_terminal", "echo x > .claude/tier-rules.json"],
  ])("%s: %s → ask", (tool, command) => {
    const r = run({ tool_name: tool, tool_input: { command } });
    expect(r.decision, command).toBe("ask");
    expect(r.reason.startsWith(PREFIX)).toBe(true);
  });

  it.each([
    ["cat .claude/tier-rules.json"],
    ["grep allow_tier3 SPEC.md"],
    ["git diff -- .claude/settings.json"],
    ["git add .claude/tier-rules.json"],
    ["cp .claude/tier-rules.json /tmp/backup.json"],
    ["echo 'see .claude/settings.json' > notes.md"],
    ["sed -i 's/a/b/' src/app.ts"],
    // O que NÃO é o gate do SPEC.md: texto acrescentado que não cita a chave, e o que só lê ou imprime.
    ["echo 'mais uma nota' >> SPEC.md"],
    ["sed -n '4p' SPEC.md"],
    ["sed 's/false/true/' SPEC.md"],
    ["sed -i '4s/false/true/' docs/notes.md"],
    ["cat > docs/runbook.md <<'EOF'\nsed -i 's/a/b/' .claude/tier-rules.json\nEOF"],
  ])("Bash: %s → allow", (command) => {
    expect(bash(command), command).toEqual({ decision: "allow", reason: "" });
  });

  it("o deny do Tier 3 ganha: um rm -rf na mesma linha → deny, não ask", () => {
    const r = bash("rm -rf build && echo '{}' > .claude/tier-rules.json");
    expect(r.decision).toBe("deny");
    expect(r.reason).not.toMatch(/Gate file write/);
  });

  it("um deploy na mesma linha continua ask (as duas razões pedem aprovação)", () => {
    expect(bash(`${DEPLOY} && echo '{}' > .claude/tier-rules.json`).decision).toBe("ask");
  });

  it("o break-glass allow_tier3 ligado não dispensa o ASK do gate", () => {
    const dir = makeRoot(JSON.stringify(FIXTURE_RULES));
    writeFileSync(path.join(dir, "SPEC.md"), "---\ntier_defaults:\n  allow_tier3: true\n---\n\n# fixture\n");
    expect(bash("echo '{}' > .claude/tier-rules.json", dir).decision).toBe("ask");
    expect(bash("rm -rf /", dir).decision).toBe("allow"); // o break-glass segue liberando o resto
  });

  it("sem o arquivo do projeto, com as regras do framework: o ASK do gate vale do mesmo jeito", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tier-guard-gate-bare-"));
    roots.push(dir);
    writeFileSync(path.join(dir, "SPEC.md"), "---\ntier_defaults:\n  allow_tier3: false\n---\n\n# fixture\n");
    const r = bash("echo '{}' > .claude/tier-rules.json", dir);
    expect(r.decision).toBe("ask");
    expect(r.reason).toMatch(/regras do framework/);
  });

  it("o gate de uma worktree (outra raiz do framework) também pede", () => {
    const dir = makeRoot(JSON.stringify(FIXTURE_RULES));
    mkdirSync(path.join(dir, ".claude", "worktrees", "wt1", ".claude"), { recursive: true });
    const wt = path.join(dir, ".claude", "worktrees", "wt1", "SPEC.md").replace(/\\/g, "/");
    expect(bash(`echo x > ${wt}`, dir).decision).toBe("ask");
  });

  // Revisão de segurança do F13: as formas que não dão o nome do arquivo como destino.
  it.each([
    ["cp x.json .claude/"],
    ["mv /tmp/new.json .claude/"],
    ["ln -s .claude/tier-rules.json notas.md"],
    ["git checkout abc1234 -- SPEC.md"],
    ["git checkout abc1234 -- ."],
    ["git restore --source=HEAD~2 .claude/settings.json"],
    ["echo x > .mcp.json"],
    ["git apply fix.diff"],
    ["patch -p1 < fix.diff"],
    ["rm -r .claude"],
  ])("Bash (forma de contorno): %s → ask", (command) => {
    const r = bash(command);
    expect(r.decision, command).toBe("ask");
    expect(r.reason.startsWith(PREFIX) || /Tier 3/.test(r.reason), r.reason).toBe(true);
  });

  it("o patch lido do disco: um que toca o gate pede, um que não toca passa", () => {
    const dir = makeRoot(JSON.stringify(FIXTURE_RULES));
    writeFileSync(path.join(dir, "gate.diff"), "diff --git a/SPEC.md b/SPEC.md\n--- a/SPEC.md\n+++ b/SPEC.md\n@@ -1 +1 @@\n-a\n+b\n");
    writeFileSync(path.join(dir, "ok.diff"), "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n");
    expect(bash("git apply gate.diff", dir).decision).toBe("ask");
    expect(bash("patch -p1 < gate.diff", dir).decision).toBe("ask");
    expect(bash("git apply ok.diff", dir)).toEqual({ decision: "allow", reason: "" });
    expect(bash("patch -p1 < ok.diff", dir)).toEqual({ decision: "allow", reason: "" });
    expect(bash("git apply --check gate.diff", dir)).toEqual({ decision: "allow", reason: "" });
  });

  it("uma junction para o .claude não esconde o gate: o caminho real é classificado", () => {
    const dir = makeRoot(JSON.stringify(FIXTURE_RULES));
    symlinkSync(path.join(dir, ".claude"), path.join(dir, "atalho"), "junction");
    expect(bash("echo '{}' > atalho/tier-rules.json", dir).decision).toBe("ask");
    expect(bash("cp x.json atalho/settings.json", dir).decision).toBe("ask");
    expect(bash("echo x > atalho/outro.txt", dir)).toEqual({ decision: "allow", reason: "" });
  });

  it("o que segue livre depois das formas novas", () => {
    for (const command of ["git checkout main", "git checkout -- src/app.ts", "git restore --staged src/app.ts", "git stash list", "cp x.json docs/", "ln -s src/a.ts link.ts", "git diff -- .claude/settings.json"]) {
      expect(bash(command), command).toEqual({ decision: "allow", reason: "" });
    }
  });

  // O módulo do gate que não carrega não derruba o resto: o Tier 3 segue decidido pelos padrões, e o
  // que é permitido leva o aviso de que a detecção do gate não rodou.
  it("o módulo da detecção de gate quebrado: o Tier 3 segue valendo e o aviso aparece", () => {
    const dir = makeRoot(JSON.stringify(FIXTURE_RULES));
    const aiteam = path.join(dir, "aiteam");
    for (const file of HOOK_FILES) {
      mkdirSync(path.dirname(path.join(aiteam, file)), { recursive: true });
      const src = readFileSync(path.join(HERE, "..", file), "utf8");
      writeFileSync(path.join(aiteam, file), file === "src/gate-files-core.mjs" ? "export const broken = ;\n" : src);
    }
    const hook = path.join(aiteam, "hooks", "tier-guard.mjs");
    const go = (command: string) => {
      const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }), cwd: dir, encoding: "utf8", timeout: 15_000 });
      const out = JSON.parse(String(r.stdout || "{}")) as { hookSpecificOutput?: { permissionDecision?: string }; systemMessage?: string };
      return { status: r.status, decision: out.hookSpecificOutput?.permissionDecision ?? "allow", systemMessage: out.systemMessage ?? "" };
    };
    expect(go("Remove-Item -Recurse -Force dist").decision).toBe("deny");
    expect(go(DEPLOY).decision).toBe("ask");
    const free = go("ls -la");
    expect(free.status).toBe(0);
    expect(free.decision).toBe("allow");
    expect(free.systemMessage).toMatch(/gate-file write detection/);
  });
});

// Segunda e terceira rodadas da revisão do F13, com o hook de verdade: o código do próprio gate num consumidor (e a
// isenção do upstream, que vem do ambiente e não de um arquivo), e o git que cita o gate.
describe("tier-guard — código do gate (consumidor × upstream) e git que cita o gate (F13)", () => {
  const UPSTREAM = { AITEAM_UPSTREAM: "1" };
  const bash = (command: string, cwd: string, env: EnvPatch = {}) => run({ tool_name: "Bash", tool_input: { command } }, cwd, env);

  function makeFramework(plantManifest = false): string {
    const dir = makeRoot(JSON.stringify(FIXTURE_RULES));
    mkdirSync(path.join(dir, "aiteam", "hooks"), { recursive: true });
    mkdirSync(path.join(dir, "aiteam", "src"), { recursive: true });
    mkdirSync(path.join(dir, "aiteam", "templates"), { recursive: true });
    writeFileSync(path.join(dir, "aiteam", "hooks", "tier-guard.mjs"), 'import { a } from "../src/mod-a.mjs";\n');
    writeFileSync(path.join(dir, "aiteam", "src", "mod-a.mjs"), "export const a = 1;\n");
    writeFileSync(path.join(dir, "aiteam", "src", "fora.mjs"), "export const z = 1;\n");
    writeFileSync(path.join(dir, "aiteam", "templates", "tier-rules.json"), "{}");
    if (plantManifest) {
      mkdirSync(path.join(dir, "tools", "aiteam-sync"), { recursive: true });
      writeFileSync(path.join(dir, "tools", "aiteam-sync", "manifest.json"), "{}");
    }
    return dir;
  }

  const GUARD_CODE_WRITES = [
    ["echo x > aiteam/src/mod-a.mjs"],
    ["sed -i 's/1/2/' aiteam/hooks/tier-guard.mjs"],
    ["cp /tmp/x.json aiteam/templates/tier-rules.json"],
    ["rm aiteam/src/mod-a.mjs"],
    ["node -e \"require('fs').writeFileSync('aiteam/src/mod-a.mjs','')\""],
  ];

  it.each(GUARD_CODE_WRITES)("consumidor: %s → ask", (command) => {
    const r = bash(command, makeFramework());
    expect(r.decision, command).toBe("ask");
    expect(r.reason).toMatch(/Gate file write/);
  });

  it.each(GUARD_CODE_WRITES)("upstream (AITEAM_UPSTREAM=1 no ambiente do hook): %s → allow, o guard é desenvolvido ali", (command) => {
    expect(bash(command, makeFramework(), UPSTREAM), command).toEqual({ decision: "allow", reason: "" });
  });

  // QA frente B R3: apagar ou mover o diretório que guarda o código do gate (num consumidor).
  // (`rm -rf` e `Remove-Item` ficam de fora: o piso do Tier 3 os nega antes, e aqui se prova o ask do gate.)
  const GUARD_DIR_REMOVALS = [
    ["rm -r aiteam/hooks"],
    ["rm -r aiteam"],
    ["rm -r aiteam/src"],
    ["mv aiteam/hooks /tmp/away"],
    ["mv aiteam aiteam.old"],
    ["Rename-Item aiteam\\hooks hooks.off"],
    ["cd aiteam && rm -r src"],
  ];
  it.each(GUARD_DIR_REMOVALS)("consumidor: %s → ask", (command) => {
    const r = bash(command, makeFramework());
    expect(r.decision, command).toBe("ask");
    expect(r.reason).toMatch(/Gate file write/);
  });
  it.each(GUARD_DIR_REMOVALS)("upstream: %s → allow", (command) => {
    expect(bash(command, makeFramework(), UPSTREAM), command).toEqual({ decision: "allow", reason: "" });
  });
  it.each([["rm -r aiteam/node_modules"], ["rm -r aiteam/docs"], ["mv aiteam/docs aiteam/old"], ["ls aiteam"]])("consumidor: %s → allow", (command) => {
    expect(bash(command, makeFramework()), command).toEqual({ decision: "allow", reason: "" });
  });

  it("um tools/aiteam-sync/manifest.json plantado num consumidor NÃO liga a isenção: segue ask", () => {
    const dir = makeFramework(true);
    for (const command of GUARD_CODE_WRITES.map(([c]) => c as string)) expect(bash(command, dir).decision, command).toBe("ask");
  });

  it("só o valor exato 1 liga a isenção (vazio, 0, true e yes não)", () => {
    const dir = makeFramework();
    for (const value of ["", "0", "true", "yes", "2", " 1"]) {
      expect(bash("echo x > aiteam/src/mod-a.mjs", dir, { AITEAM_UPSTREAM: value }).decision, JSON.stringify(value)).toBe("ask");
    }
  });

  it("a isenção do upstream vale só para o código do gate: SPEC.md e tier-rules.json seguem pedindo", () => {
    const dir = makeFramework();
    for (const command of ["echo 'allow_tier3: true' >> SPEC.md", "sed -i 's/a/b/' .claude/tier-rules.json", "echo '{}' > .claude/settings.json"]) {
      expect(bash(command, dir, UPSTREAM).decision, command).toBe("ask");
    }
  });

  it("consumidor: o que não é código do gate segue livre", () => {
    const dir = makeFramework();
    for (const command of ["echo x > aiteam/src/fora.mjs", "cat aiteam/src/mod-a.mjs", "cp aiteam/src/mod-a.mjs /tmp/x", "echo x > src/app.ts"]) {
      expect(bash(command, dir), command).toEqual({ decision: "allow", reason: "" });
    }
  });

  // Decisão do PO (cortar o excesso): nenhum git roda dentro do hook. O que um merge, um rebase, um cherry-pick ou um pull
  // traz chega revisado por um PR e o guard é um anteparo (ADR 0004); só o git que CITA um arquivo do gate, ou o diretório
  // dele, pede. A prova de que o hook não roda git: um executável `git` plantado que deixa uma marca, no primeiro lugar da
  // busca (o repo no PATH, '.' no PATH, o diretório de trabalho no Windows), nunca roda.
  describe("git: o que um merge traz passa, só o que cita o gate pede, e o hook nunca roda git", () => {
    const WIN = process.platform === "win32";

    // Planta, na raiz, um executável que deixa uma marca quando roda. No Windows, uma cópia do node com o nome git.exe
    // (o libuv acha .exe e .com, não .cmd) mais um git.cmd; no POSIX, um script `git`. A marca vem de um módulo
    // carregado por NODE_OPTIONS que só age quando o executável é o git plantado, e não o node do próprio hook.
    function plant(dir: string): { env: EnvPatch; ran: () => boolean } {
      const marker = path.join(dir, "PLANTED-GIT-RAN");
      const preload = path.join(dir, "marca.cjs");
      writeFileSync(preload, `if (/(^|[\\\\/])git(\\.exe)?$/i.test(process.execPath)) require("fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
      if (WIN) {
        try {
          linkSync(process.execPath, path.join(dir, "git.exe"));
        } catch {
          copyFileSync(process.execPath, path.join(dir, "git.exe"));
        }
        writeFileSync(path.join(dir, "git.cmd"), `@echo off\r\necho ran> "${marker}"\r\n`);
      } else {
        writeFileSync(path.join(dir, "git"), `#!/bin/sh\necho ran > "${marker}"\n`);
        chmodSync(path.join(dir, "git"), 0o755);
      }
      // NoDefaultCurrentDirectoryInExePath: null — o harness da sessão a põe, e com ela o libuv já não procura no
      // diretório de trabalho; o plantio só prova algo com a busca padrão do Windows.
      return { env: { NODE_OPTIONS: `--require=${preload.replace(/\\/g, "/")}`, NoDefaultCurrentDirectoryInExePath: null }, ran: () => existsSync(marker) };
    }

    // Sem isto o teste seguinte não prova nada: o plantio roda de verdade quando um processo com cwd no repo chama `git`.
    it("o plantio funciona: um spawnSync('git') com o repo no PATH (ou '.') roda o executável plantado", () => {
      for (const evil of [(d: string) => d, () => "."]) {
        const dir = makeRoot(JSON.stringify(FIXTURE_RULES));
        const p = plant(dir);
        const code = 'require("child_process").spawnSync("git", ["diff", "--name-only"], { cwd: process.cwd() })';
        spawnSync(process.execPath, ["-e", code], { cwd: dir, encoding: "utf8", windowsHide: true, env: hookEnv({ ...p.env, PATH: [evil(dir), process.env.PATH ?? ""].join(path.delimiter) }) });
        expect(p.ran(), "o git plantado tem de rodar aqui").toBe(true);
      }
    });

    it.each([
      ["git pull"],
      ["git pull --rebase origin main"],
      ["git merge main"],
      ["git merge --no-ff feature"],
      ["git merge a b c"],
      ["git rebase main"],
      ["git rebase -i main"],
      ["git cherry-pick a b c"],
      ["git cherry-pick abc1234..def5678"],
      ["git reset --hard"],
      ["git reset --hard origin/main"],
      ["git stash pop"],
      ["git stash apply stash@{1}"],
      ["git checkout main"],
      ["git switch main"],
      ["git -C ../outro merge b"],
      ["GIT_DIR=.git git merge b"],
      ["cd .. && git merge b"],
    ])("%s → allow, e nenhum git roda dentro do hook", (command) => {
      const dir = makeRoot(JSON.stringify(FIXTURE_RULES));
      const p = plant(dir);
      // o repo e '.' à frente no PATH: o primeiro lugar onde um git plantado seria achado
      for (const front of [dir, "."]) {
        const r = bash(command, dir, { ...p.env, PATH: [front, process.env.PATH ?? ""].join(path.delimiter) });
        expect(r, `${command} (PATH=${front === dir ? "repo" : "."})`).toEqual({ decision: "allow", reason: "" });
        expect(p.ran(), `o hook rodou o git plantado em: ${command}`).toBe(false);
      }
    });

    it.each([
      ["git stash push -- SPEC.md"],
      ["git stash push -- .claude/settings.json"],
      ["git stash push SPEC.md"],
      ["git checkout main -- .claude/settings.json"],
      ["git checkout abc1234 -- SPEC.md"],
      ["git restore SPEC.md"],
      ["git restore --source=HEAD~2 .claude/tier-rules.json"],
      ["git checkout -- .claude/"],
      // só análise de texto, sem processo: o que roda o git (um -c, um alias, um subcomando de fora, o -x do rebase)
      ["git -c alias.x='!sh -c bad' x"],
      ["git -c core.pager=sh log"],
      ["git --nova-global x merge feature"],
      ["git lfs pull"],
      ["git rebase -x 'echo x > .claude/settings.json' main"],
      ["git rebase --exec \"sed -i 's/a/b/' .claude/tier-rules.json\" main"],
    ])("%s → ask: cita um arquivo do gate, ou o diretório dele, ou o que o git roda", (command) => {
      const dir = makeRoot(JSON.stringify(FIXTURE_RULES));
      const p = plant(dir);
      const r = bash(command, dir, { ...p.env, PATH: [dir, process.env.PATH ?? ""].join(path.delimiter) });
      expect(r.decision, command).toBe("ask");
      expect(r.reason).toMatch(/Gate file write/);
      expect(p.ran(), `o hook rodou o git plantado em: ${command}`).toBe(false);
    });

    it.each([["git rebase -x 'make test' main"], ["git -c user.name=x merge feature"], ["git --no-pager -c color.ui=never log"]])(
      "%s → allow: o -x que não escreve no gate e a configuração inofensiva passam",
      (command) => {
        const dir = makeRoot(JSON.stringify(FIXTURE_RULES));
        expect(bash(command, dir)).toEqual({ decision: "allow", reason: "" });
      }
    );

    it("o hook não tem como rodar git: o fonte não importa child_process", () => {
      const source = readFileSync(HOOK, "utf8");
      expect(source).not.toMatch(/child_process/);
      expect(source).not.toMatch(/spawnSync|execFileSync|execSync|\bspawn\(/);
    });
  });
});

// Revisão do QA da frente A, pelo hook de verdade: as sondas que vieram como payload de PreToolUse.
describe("tier-guard — QA frente A: chave de protótipo, aspa do bash, continuação, comentário (R1, R2, R3)", () => {
  const RULES = JSON.stringify({
    tier3: { label: "t3", patterns: ["\\bdrop\\s+table\\b"], ask_patterns: [] },
    tier2: { label: "t2", patterns: [] },
  });
  const DROP = "psql -c 'DROP TABLE users'";
  let dir = "";
  beforeAll(() => {
    dir = makeRoot(RULES);
  });

  // O hook cru: decisão, aviso (systemMessage) e stderr, para provar que a decisão não veio do caminho de exceção.
  function probe(command: string, tool = "Bash"): { decision: Decision; reason: string; warn: string } {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: tool, tool_input: { command } }), cwd: dir, encoding: "utf8", timeout: 15_000, env: hookEnv() });
    expect(r.status, String(r.stderr)).toBe(0);
    const out = JSON.parse(String(r.stdout || "{}"));
    return {
      decision: out?.hookSpecificOutput?.permissionDecision ?? "allow",
      reason: out?.hookSpecificOutput?.permissionDecisionReason ?? "",
      warn: out?.systemMessage ?? "",
    };
  }

  it.each([
    ["git constructor --x <<'EOF'\nhi\nEOF\n" + DROP],
    ["git __proto__ --x <<EOF\nhi\nEOF\n" + DROP],
    ["git hasOwnProperty --x <<EOF\nhi\nEOF\n" + DROP],
    ["git constructor -am <<EOF\nhi\nEOF\n" + DROP],
    ["git toString -F - <<'EOF'\nhi\nEOF\n" + DROP],
    ["git valueOf -m x <<'EOF'\nhi\nEOF\n" + DROP],
  ])("R1: %j → deny, e não pelo caminho de exceção", (command) => {
    const r = probe(command);
    expect(r.decision, command).toBe("deny");
    expect(r.warn, "nenhum aviso de erro interno").toBe("");
    expect(r.reason).toContain("DROP TABLE");
  });

  it.each([
    ["git commit -m @'\n' ; " + DROP + " ; echo '\n'@"],
    ["gh pr create --body @'\n' ; " + DROP + " ; echo '\n'@"],
    ["Set-Content x @'\n' ; " + DROP + " ; echo '\n'@"],
    ["@'\n' ; " + DROP + " ; echo '\n'@"],
    ["@'\n' ; " + DROP + " ; echo '\n'@ | Set-Content x"],
    ['@"\n" ; ' + DROP + ' ; echo "\n"@'],
  ])("R2: %j → deny", (command) => {
    expect(probe(command).decision, command).toBe("deny");
    expect(probe(command, "PowerShell").decision, `${command} (PowerShell)`).toBe("deny");
  });

  it.each([
    ["cat <<'EOF' \\\n| bash\nrm -rf /tmp/x\nEOF"],
    ["cat <<'EOF' \\\n | bash\nrm -rf /tmp/x\nEOF"],
    ["cat <<'EOF' \\\n| bash\n" + DROP + "\nEOF"],
    ["cat <<'EOF' \\\n| bash\nDROP TABLE users;\nEOF"],
  ])("R3: %j → deny", (command) => {
    expect(probe(command).decision, command).toBe("deny");
  });

  it.each([
    ["cat # <<'EOF'\n" + DROP + "\nEOF"],
    ["echo '\ncat <<EOF\n'\n" + DROP + "\nEOF"],
  ])("R3 (comentário e aspa aberta): %j → deny", (command) => {
    expect(probe(command).decision, command).toBe("deny");
  });

  it.each([
    ["cat > f.md <<'EOF' # nota\nrm -rf /srv/app\nEOF"],
    ["cat > $'f.md' <<'EOF'\n" + DROP + "\nEOF"],
    ["git commit -m x # @'\nDROP TABLE users\n'@"],
    ["git commit -m $'x' @'\nDROP TABLE users\n'@"],
    ["Set-Content x # @'\nDROP TABLE users\n'@"],
  ])("R3 (# e $' na abertura): %j → deny", (command) => {
    expect(probe(command).decision, command).toBe("deny");
    expect(probe(command, "PowerShell").decision, `${command} (PowerShell)`).toBe("deny");
  });

});

// Revisão do QA da frente B, R2, pelo hook de verdade: as palavras de controle e o agrupamento do shell antes do programa.
describe("tier-guard — QA frente B R2: palavras de controle e agrupamento antes do programa", () => {
  it.each([
    ["if grep -q 'false' SPEC.md; then sed -i 's/false/true/' SPEC.md; fi"],
    ["for i in 1; do sed -i 's/false/true/' SPEC.md; done"],
    ["while false; do sed -i 's/false/true/' SPEC.md; done"],
    ["{ sed -i 's/false/true/' SPEC.md; }"],
    ["( sed -i 's/false/true/' SPEC.md )"],
    ["(sed -i 's/false/true/' SPEC.md)"],
    ["! sed -i 's/false/true/' SPEC.md"],
    ["if true; then sed -i 's/head/main/' .claude/settings.json; fi"],
    ["for i in 1; do cp /tmp/x.json .claude/settings.json; done"],
    ["for i in 1; do rm .claude/settings.json; done"],
    ["if true; then perl -pi -e 's/false/true/' SPEC.md; fi"],
    ["if false; then echo a; else sed -i 's/false/true/' SPEC.md; fi"],
    ["true && { sed -i 's/false/true/' SPEC.md; }"],
    ["f() { sed -i 's/false/true/' SPEC.md; }; f"],
    ["case x in x) sed -i 's/false/true/' SPEC.md;; esac"],
    ["eval \"sed -i 's/false/true/' SPEC.md\""],
  ])("%s → ask", (command) => {
    const dir = makeRoot(JSON.stringify(FIXTURE_RULES));
    const r = run({ tool_name: "Bash", tool_input: { command } }, dir);
    expect(r.decision, command).toBe("ask");
    expect(r.reason).toMatch(/Gate file write/);
  });

  it.each([["if grep -q false SPEC.md; then echo ok; fi"], ["(cd src && npm test)"], ["for f in a b; do cat SPEC.md; done"], ["case $x in a) echo a;; esac"]])(
    "%s → allow",
    (command) => {
      const dir = makeRoot(JSON.stringify(FIXTURE_RULES));
      expect(run({ tool_name: "Bash", tool_input: { command } }, dir)).toEqual({ decision: "allow", reason: "" });
    }
  );
});

// O `&` simples (comando em segundo plano) é separador de sub-comando: o `echo` da frente deixava a linha inteira inerte.
describe("tier-guard — o `&` simples não esconde o deploy nem o destrutivo", () => {
  const go = (command: string) => run({ tool_name: "Bash", tool_input: { command } }, makeRoot(JSON.stringify(FIXTURE_RULES)));

  it.each([["echo ok & " + DEPLOY], ["true & " + DEPLOY], [DEPLOY + " &"], ["ls & " + DEPLOY + " & echo done"]])("%s → ask (o único gate de deploy)", (command) => {
    const r = go(command);
    expect(r.decision, command).toBe("ask");
    expect(r.reason).toMatch(/approval/i);
  });

  it.each([["echo ok & rm -rf build"], ["ls & rm -rf build"], ["true & git push --force origin main"], ["echo ok & " + DEPLOY + " & rm -rf build"]])(
    "%s → deny",
    (command) => {
      expect(go(command).decision, command).toBe("deny");
    }
  );

  it.each([["echo ok & ls"], ["make 2>&1 | tail"], ["npm test &> out.log"], ["echo 'a & rm -rf build'"]])("%s → allow, nada que era livre passa a negar", (command) => {
    expect(go(command)).toEqual({ decision: "allow", reason: "" });
  });
});

// O `\` fora de aspas torna literal o caractere seguinte: o `\&` de um comando remoto não corta a linha (o `sudo reboot`
// ficaria sem o `ssh` na frente), e o `>` escapado de `\>&` não é um redirecionamento.
describe("tier-guard — o `\\` escapa o separador: a linha não perde o `ssh` nem o `&` que separa de verdade", () => {
  const SSH_RULES = {
    tier3: {
      label: "fixture",
      patterns: ["\\bssh\\b.*\\b(reboot|shutdown|poweroff)\\b", "\\bssh\\b.*\\b(npm|pnpm|yarn|make)\\s+(run\\s+)?\\S*deploy", "\\bgh\\s+workflow\\s+run\\s+\\S*deploy"],
      ask_patterns: ["\\bssh\\b.*\\b(npm|pnpm|yarn|make)\\s+(run\\s+)?\\S*deploy", "\\bgh\\s+workflow\\s+run\\s+\\S*deploy"],
    },
    tier2: { label: "fixture", patterns: [] },
  };
  const go = (command: string) => run({ tool_name: "Bash", tool_input: { command } }, makeRoot(JSON.stringify(SSH_RULES)));

  it.each([["ssh prod true \\& sudo reboot", "deny"], ["ssh prod cd /srv \\& npm run deploy", "ask"], ["echo \\>& rm -rf build", "deny"], ["true \\<& " + DEPLOY, "ask"]])(
    "%s → %s",
    (command, expected) => {
      expect(go(command).decision, command).toBe(expected);
    }
  );

  it.each([["echo a\\;b"], ["grep a f \\| wc -l"], ["ls C:\\Users\\x\\"], ["find . -name '*.js' -exec echo {} \\;"]])("%s → allow", (command) => {
    expect(go(command)).toEqual({ decision: "allow", reason: "" });
  });
});

// O piso fixo nega o push forçado em qualquer grafia: `-f`, `-uf`/`-fu` e o refspec `+ref`, não só `--force`.
describe("tier-guard — push forçado nas formas curta e +ref", () => {
  const go = (command: string) => run({ tool_name: "Bash", tool_input: { command } }, makeRoot(JSON.stringify(FIXTURE_RULES)));

  it.each([["git push -f origin main"], ["git push -uf origin x"], ["git push -fu origin x"], ["git push origin +main"], ["git push origin +HEAD:main"], ["echo ok & git push -f origin main"]])(
    "%s → deny",
    (command) => {
      expect(go(command).decision, command).toBe("deny");
    }
  );

  it.each([["git push origin main"], ["git push -u origin feat/x"], ["git push --force-with-lease origin x"], ["git push --force-if-includes origin x"], ["git fetch -f origin push-branch"]])(
    "%s → allow",
    (command) => {
      expect(go(command)).toEqual({ decision: "allow", reason: "" });
    }
  );
});
