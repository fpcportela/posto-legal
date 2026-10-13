import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { makeSandbox, SLOW, type Sandbox } from "./beads-sandbox.js";

// O aviso do tier-guard (".claude/tier-rules.json ausente/ilegível: usando a
// cópia canônica") ficava DENTRO do try do brief de beads. Se esse try caía no
// catch — o brief de beads quebrado por um módulo ausente ou com erro, uma
// exceção do buildBrief —, o contexto virava só "brief indisponível" e o aviso
// sumia justamente quando o framework estava mais quebrado. Agora o aviso tem o
// próprio try, fora do brief de beads.
//
// Limite que fica: a linha é montada por tierRulesLine, que mora em
// session-brief-core.mjs; sem esse módulo (ou o vendor/js-yaml.mjs que o
// beads-core dele importa) não há como montá-la. Os cenários abaixo quebram o
// resto do brief, não esse módulo.

const MISSING = "⚠ tier-guard usando a cópia canônica: .claude/tier-rules.json ausente — rode node aiteam/install.mjs";
const UNAVAILABLE = /brief indisponível/;

function brief(setup: (s: Sandbox) => void): { context: string; status: number; stderr: string } {
  const s = makeSandbox({ branch: "main" });
  try {
    s.write("SPEC.md", '---\nproject: "demo"\nbudget_usd: 3.00\n---\n# demo\n');
    s.write(".beads/.gitignore", "/active.yaml\n/index.yaml\n/session.local.json\n");
    setup(s);
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "base");
    const r = spawnSync(process.execPath, [path.join(s.dir, "aiteam", "hooks", "session-brief.mjs")], {
      input: "{}",
      cwd: s.dir,
      env: s.env,
      encoding: "utf8",
      timeout: 30_000,
    });
    const out = r.stdout ? (JSON.parse(r.stdout) as { hookSpecificOutput: { additionalContext: string } }) : null;
    return { context: out?.hookSpecificOutput.additionalContext ?? "", status: r.status ?? 1, stderr: r.stderr };
  } finally {
    s.cleanup();
  }
}

describe("hook fim-a-fim — o aviso do tier-guard sobrevive ao brief de beads quebrado", () => {
  it("controle: brief saudável e sem o arquivo do projeto traz o aviso", SLOW, () => {
    const { context, status, stderr } = brief(() => {});
    expect(status, stderr).toBe(0);
    expect(context).not.toMatch(UNAVAILABLE);
    expect(context).toContain(MISSING);
  });

  it("um módulo do brief ausente derruba o brief de beads, mas o aviso fica", SLOW, () => {
    const { context, status, stderr } = brief((s) => s.remove("aiteam/src/beads-io.mjs"));
    expect(status, stderr).toBe(0);
    expect(context).toMatch(UNAVAILABLE);
    expect(context).toContain(MISSING);
  });

  it("um módulo do brief com erro de sintaxe derruba o brief de beads, mas o aviso fica", SLOW, () => {
    const { context, status, stderr } = brief((s) => s.write("aiteam/src/beads-io.mjs", "export const quebrado = ;\n"));
    expect(status, stderr).toBe(0);
    expect(context).toMatch(UNAVAILABLE);
    expect(context).toContain(MISSING);
  });

  it("o aviso é uma linha própria, depois do texto do brief", SLOW, () => {
    const { context } = brief((s) => s.remove("aiteam/src/beads-io.mjs"));
    const lines = context.split("\n");
    expect(lines[0]).toMatch(UNAVAILABLE);
    expect(lines).toContain(MISSING);
  });

  it("com o arquivo do projeto válido não há aviso nem com o brief quebrado", SLOW, () => {
    const rules = JSON.stringify({ tier3: { patterns: ["\\bmeu-marcador\\b"] }, tier2: { patterns: [] } });
    const { context } = brief((s) => {
      s.write(".claude/tier-rules.json", rules);
      s.remove("aiteam/src/beads-io.mjs");
    });
    expect(context).toMatch(UNAVAILABLE);
    expect(context).not.toMatch(/tier-guard/);
  });

  it("brief e carregador quebrados juntos: o hook sai 0 com o texto do brief indisponível, sem lançar", SLOW, () => {
    const { context, status, stderr } = brief((s) => {
      s.remove("aiteam/src/beads-io.mjs");
      s.remove("aiteam/src/tier-rules-loader.mjs");
    });
    expect(status, stderr).toBe(0);
    expect(context).toMatch(UNAVAILABLE);
    expect(context).not.toMatch(/tier-guard/);
  });
});
