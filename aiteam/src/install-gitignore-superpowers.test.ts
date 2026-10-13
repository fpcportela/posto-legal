import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeSandbox, SLOW, type Sandbox } from "./beads-sandbox.js";
import {
  GITIGNORE_ENTRIES,
  SUPERPOWERS_IGNORE,
  SUPERPOWERS_IGNORE_COMMENT,
  TRELLO_CACHE_IGNORE,
  TRELLO_CACHE_IGNORE_COMMENT,
  WORKTREES_IGNORE,
  WORKTREES_IGNORE_COMMENT,
  ensureGitignoreEntries,
} from "./install-core.mjs";
import { repoRoot } from "./repo-root.js";

// Issue 51, decisão A: o workspace `.superpowers/` do SDD e do executing-plans é
// rascunho do skill, nunca fonte de estado. Um `git add -A` o empacotaria (o
// aiteam-sync carrega o diff do install assim), e então o ledger descartável
// viraria histórico. O install o põe no .gitignore da raiz, junto do
// .claude/worktrees/, no mesmo passo e numa leitura só.
const WT = `${WORKTREES_IGNORE_COMMENT}\n${WORKTREES_IGNORE}\n`;
const TR = `${TRELLO_CACHE_IGNORE_COMMENT}\n${TRELLO_CACHE_IGNORE}\n`;
const SP = `${SUPERPOWERS_IGNORE_COMMENT}\n${SUPERPOWERS_IGNORE}\n`;

describe("ensureGitignoreEntries — .claude/worktrees/, .trello-cache/ e .superpowers/ numa leitura só", () => {
  it("as regras são as três, na ordem", () => {
    expect(SUPERPOWERS_IGNORE).toBe(".superpowers/");
    expect(GITIGNORE_ENTRIES.map((e) => e.line)).toEqual([WORKTREES_IGNORE, TRELLO_CACHE_IGNORE, SUPERPOWERS_IGNORE]);
  });

  it("arquivo vazio ou ausente: cria as três, cada uma com o seu comentário", () => {
    for (const host of ["", undefined, null]) {
      const r = ensureGitignoreEntries(host);
      expect(r.text).toBe(`${WT}\n${TR}\n${SP}`);
      expect(r.added.map((e) => e.line)).toEqual([WORKTREES_IGNORE, TRELLO_CACHE_IGNORE, SUPERPOWERS_IGNORE]);
    }
  });

  it("acrescenta no fim e preserva o que o hospedeiro tinha, byte a byte", () => {
    const host = "node_modules/\n.env\n";
    const r = ensureGitignoreEntries(host);
    expect(r.text.startsWith(host)).toBe(true);
    expect(r.text).toBe(`${host}\n${WT}\n${TR}\n${SP}`);
  });

  it("é idempotente: a segunda passada não muda nada e não acrescenta nada", () => {
    const once = ensureGitignoreEntries("dist/\n").text;
    const again = ensureGitignoreEntries(once);
    expect(again.text).toBe(once);
    expect(again.added).toEqual([]);
  });

  it("só acrescenta as que faltam", () => {
    const host = "dist/\n/.claude/worktrees\n.trello-cache/\n";
    const r = ensureGitignoreEntries(host);
    expect(r.added.map((e) => e.line)).toEqual([SUPERPOWERS_IGNORE]);
    expect(r.text).toBe(`${host}\n${SP}`);
    const host2 = "dist/\n.superpowers\n";
    const r2 = ensureGitignoreEntries(host2);
    expect(r2.added.map((e) => e.line)).toEqual([WORKTREES_IGNORE, TRELLO_CACHE_IGNORE]);
    expect(r2.text).toBe(`${host2}\n${WT}\n${TR}`);
    const host3 = "dist/\n.claude/worktrees/*\n";
    expect(ensureGitignoreEntries(host3).added.map((e) => e.line)).toEqual([TRELLO_CACHE_IGNORE, SUPERPOWERS_IGNORE]);
  });

  it.each([".superpowers/", ".superpowers", "/.superpowers/", ".superpowers/*", ".superpowers/**", "  .superpowers/  "])(
    "já coberto por %j: não acrescenta o .superpowers/",
    (existing) => {
      const host = `dist/\n${existing}\n${WT}\n${TR}`;
      const r = ensureGitignoreEntries(host);
      expect(r.text).toBe(host);
      expect(r.added).toEqual([]);
    },
  );

  it("comentário e negação com o mesmo texto não contam como regra", () => {
    const host = `# .superpowers/\n!.superpowers/\n${WT}\n${TR}`;
    const r = ensureGitignoreEntries(host);
    expect(r.added.map((e) => e.line)).toEqual([SUPERPOWERS_IGNORE]);
    expect(r.text.split("\n").filter((l) => l === SUPERPOWERS_IGNORE)).toHaveLength(1);
  });

  it("uma subpasta do workspace (.superpowers/sdd/) não é a pasta inteira: a regra entra", () => {
    const r = ensureGitignoreEntries(".superpowers/sdd/\n");
    expect(r.added.map((e) => e.line)).toContain(SUPERPOWERS_IGNORE);
  });

  it("arquivo em CRLF continua em CRLF, nas duas regras", () => {
    const r = ensureGitignoreEntries("dist/\r\n");
    const crlf = (s: string) => s.replace(/\n/g, "\r\n");
    expect(r.text).toBe(`dist/\r\n\r\n${crlf(WT)}\r\n${crlf(TR)}\r\n${crlf(SP)}`);
    expect(r.text.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("o .gitignore deste repo (dogfood) já tem as três regras", () => {
    const gitignore = readFileSync(resolve(repoRoot(), ".gitignore"), "utf8");
    const r = ensureGitignoreEntries(gitignore);
    expect(r.added).toEqual([]);
    expect(r.text).toBe(gitignore);
  });
});

let sb: Sandbox | undefined;
const sandbox = (): Sandbox => {
  sb = makeSandbox();
  return sb;
};
afterEach(() => sb?.cleanup());

describe("install.mjs — .superpowers/ no .gitignore (issue 51)", () => {
  const ignored = (s: Sandbox, rel: string): boolean => s.gitTry("check-ignore", "-q", rel).status === 0;

  it("consumidor sem .gitignore: cria com as três regras, e o workspace do skill deixa de aparecer no status", SLOW, () => {
    const s = sandbox();

    const r = s.node("install.mjs");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/\.superpowers\//);
    const text = s.read(".gitignore");
    expect(text).toContain("\n.claude/worktrees/\n");
    expect(text).toContain("\n.trello-cache/\n");
    expect(text).toContain("\n.superpowers/\n");

    s.write(".superpowers/sdd/meu-plano/ledger.md", "x");
    expect(ignored(s, ".superpowers/sdd/meu-plano/ledger.md")).toBe(true);
    expect(s.git("status", "--porcelain", "--", ".superpowers")).toBe("");
  });

  it("consumidor que já ignora a worktrees: acrescenta o que falta no fim e preserva o resto; idempotente", SLOW, () => {
    const s = sandbox();
    s.write(".gitignore", "node_modules/\n.claude/worktrees/*\n");

    expect(s.node("install.mjs").status).toBe(0);
    const once = s.read(".gitignore");
    expect(once.startsWith("node_modules/\n.claude/worktrees/*\n")).toBe(true);
    expect(once.split("\n").filter((l) => l === ".superpowers/")).toHaveLength(1);
    expect(once.split("\n").filter((l) => l === ".claude/worktrees/")).toHaveLength(0);

    const again = s.node("install.mjs");
    expect(again.status, again.out).toBe(0);
    expect(again.out).not.toMatch(/\.gitignore/);
    expect(s.read(".gitignore")).toBe(once);
  });

  it("não duplica quando o hospedeiro já ignora a pasta de outro jeito (.superpowers/*)", SLOW, () => {
    const s = sandbox();
    s.write(".gitignore", "/.claude/worktrees\n.trello-cache\n.superpowers/*\n");

    expect(s.node("install.mjs").status).toBe(0);

    expect(s.read(".gitignore")).toBe("/.claude/worktrees\n.trello-cache\n.superpowers/*\n");
  });

  it(".gitignore em CRLF continua em CRLF", SLOW, () => {
    const s = sandbox();
    s.write(".gitignore", "node_modules/\r\n");

    expect(s.node("install.mjs").status).toBe(0);

    const text = s.read(".gitignore");
    expect(text.startsWith("node_modules/\r\n")).toBe(true);
    expect(text).toContain("\r\n.superpowers/\r\n");
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("--dry-run diz que acrescentaria e não escreve", SLOW, () => {
    const s = sandbox();
    s.write(".gitignore", "node_modules/\n");
    const r = s.node("install.mjs", ["--dry-run"]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/would:.*\.gitignore.*\.superpowers\//);
    expect(s.read(".gitignore")).toBe("node_modules/\n");
  });

  it(".gitignore que é uma pasta: avisa e não o toca, como nos outros arquivos do hospedeiro", SLOW, () => {
    const s = sandbox();
    s.write(".gitignore/placeholder", "x");

    const r = s.node("install.mjs");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/\.gitignore existe mas não pôde ser lido/);
  });
});
