import { afterEach, describe, expect, it } from "vitest";
import { readOptionalFile } from "./install-core.mjs";
import { makeSandbox, SLOW, type Sandbox } from "./beads-sandbox.js";

// O install lia o .claude/tier-rules.json com existsSync + readFileSync: uma
// pasta com esse nome (ou um arquivo sem permissão de leitura) estourava com a
// stack do Node e derrubava o install inteiro. E um consumidor que ignora o
// .claude/ no .gitignore (o rb-content-team ignora a pasta e rastreia só o
// tier-rules.json) semeava o arquivo sem que nada dissesse que ele nunca
// chegaria ao git sem um `git add -f`.

const RULES = ".claude/tier-rules.json";

describe("readOptionalFile — o que o install faz com um arquivo que pode não ser legível", () => {
  const err = (code: string) => Object.assign(new Error(`${code}: boom`), { code });
  const file = { isFile: () => true };
  const folder = { isFile: () => false };

  it("arquivo comum: devolve o texto", () => {
    expect(readOptionalFile("x", { statSync: () => file, readFileSync: () => "{}" })).toEqual({ state: "ok", text: "{}" });
  });

  it.each(["ENOENT", "ENOTDIR"])("%s: o arquivo falta, e só isso", (code) => {
    const fs = { statSync: () => { throw err(code); }, readFileSync: () => "" };
    expect(readOptionalFile("x", fs)).toEqual({ state: "missing" });
  });

  it("pasta: ilegível, com o motivo (não estoura com EISDIR)", () => {
    const r = readOptionalFile("x", { statSync: () => folder, readFileSync: () => { throw err("EISDIR"); } });
    expect(r.state).toBe("unreadable");
    expect(r).toMatchObject({ reason: expect.stringMatching(/pasta|directory/i) });
  });

  it("EACCES ao ler: ilegível, com o código", () => {
    const r = readOptionalFile("x", { statSync: () => file, readFileSync: () => { throw err("EACCES"); } });
    expect(r).toMatchObject({ state: "unreadable", reason: expect.stringContaining("EACCES") });
  });

  it("EACCES já no stat (a pasta-pai sem permissão): ilegível, não 'falta'", () => {
    const r = readOptionalFile("x", { statSync: () => { throw err("EACCES"); }, readFileSync: () => "" });
    expect(r).toMatchObject({ state: "unreadable", reason: expect.stringContaining("EACCES") });
  });

  it("erro sem código: usa a mensagem", () => {
    const r = readOptionalFile("x", { statSync: () => file, readFileSync: () => { throw new Error("inesperado"); } });
    expect(r).toMatchObject({ state: "unreadable", reason: expect.stringContaining("inesperado") });
  });
});

describe("install.mjs — .claude/tier-rules.json", () => {
  let sb: Sandbox | undefined;
  afterEach(() => sb?.cleanup());

  it("pasta com esse nome: avisa, não semeia, não estoura, e o resto do install roda", SLOW, () => {
    sb = makeSandbox();
    const s = sb;
    s.write(`${RULES}/dentro.txt`, "do dono");

    const r = s.node("install.mjs");

    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toMatch(/EISDIR|\n\s+at /);
    expect(r.out).toMatch(/tier-rules\.json/);
    expect(r.out).toMatch(/pasta|directory/i);
    expect(s.read(`${RULES}/dentro.txt`)).toBe("do dono");
    // Os passos depois do tier-rules rodaram (o install não parou no meio).
    expect(s.read("CLAUDE.md")).toContain("@aiteam/CLAUDE.md");
    expect(r.out).toMatch(/install complete/);
  });

  it("--dry-run com a pasta: também só avisa", SLOW, () => {
    sb = makeSandbox();
    const s = sb;
    s.write(`${RULES}/dentro.txt`, "x");
    const r = s.node("install.mjs", ["--dry-run"]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toMatch(/EISDIR/);
  });

  it(".claude/ ignorado no .gitignore: avisa para versionar com git add -f", SLOW, () => {
    sb = makeSandbox();
    const s = sb;
    s.write(".gitignore", ".claude/\n");

    const r = s.node("install.mjs");

    expect(r.status, r.out).toBe(0);
    expect(s.exists(RULES)).toBe(true);
    expect(r.out).toMatch(/git add -f \.claude\/tier-rules\.json/);
    expect(r.out).toMatch(/ignor/i);
  });

  it("o aviso vale também para o arquivo que o projeto já tinha (nunca foi ao git)", SLOW, () => {
    sb = makeSandbox();
    const s = sb;
    s.write(".gitignore", ".claude/\n");
    s.write(RULES, JSON.stringify({ tier3: { patterns: ["\\bmeu-deploy\\b"] }, tier2: { patterns: [] } }));

    const r = s.node("install.mjs");

    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/git add -f \.claude\/tier-rules\.json/);
  });

  it("sem .gitignore sobre o .claude/, não avisa", SLOW, () => {
    sb = makeSandbox();
    const r = sb.node("install.mjs");
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toMatch(/git add -f/);
  });

  it("o rb-content-team ignora a pasta mas já rastreia o tier-rules.json: não avisa", SLOW, () => {
    sb = makeSandbox();
    const s = sb;
    s.write(".gitignore", ".claude/\n");
    s.write(RULES, JSON.stringify({ tier3: { patterns: ["\\bmeu-deploy\\b"] }, tier2: { patterns: [] } }));
    s.git("add", "-f", RULES);

    const r = s.node("install.mjs");

    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toMatch(/git add -f/);
  });

  it("a exceção explícita no .gitignore (.claude/* + !.claude/tier-rules.json) também não avisa", SLOW, () => {
    sb = makeSandbox();
    const s = sb;
    s.write(".gitignore", ".claude/*\n!.claude/tier-rules.json\n");
    const r = s.node("install.mjs");
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toMatch(/git add -f/);
  });
});
