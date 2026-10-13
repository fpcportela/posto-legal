import { afterEach, describe, expect, it } from "vitest";
import { makeSandbox, SLOW, type Sandbox } from "./beads-sandbox.js";

// O install.mjs roda como subprocesso num repo descartável: é o que um
// consumidor vê ao receber o PR do aiteam-sync (que roda o install e carrega o
// diff com `git add -A`). Issue 38: a configuração de worktree dos subagentes.

let sb: Sandbox | undefined;
const sandbox = (): Sandbox => {
  sb = makeSandbox();
  return sb;
};
afterEach(() => sb?.cleanup());

const settingsOf = (s: Sandbox): { worktree?: Record<string, unknown> } & Record<string, unknown> =>
  JSON.parse(s.read(".claude/settings.json"));

describe("install.mjs — .claude/worktrees/ no .gitignore (issue 38)", () => {
  const ignored = (s: Sandbox, rel: string): boolean => s.gitTry("check-ignore", "-q", rel).status === 0;

  it("consumidor sem .gitignore: cria com a regra, e uma worktree de subagente deixa de aparecer no status", SLOW, () => {
    const s = sandbox();

    const r = s.node("install.mjs");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/\.gitignore/);
    expect(s.read(".gitignore")).toContain("\n.claude/worktrees/\n");

    s.write(".claude/worktrees/agent-1/arquivo.txt", "x");
    expect(ignored(s, ".claude/worktrees/agent-1/arquivo.txt")).toBe(true);
    expect(s.git("status", "--porcelain", "--", ".claude/worktrees")).toBe("");
  });

  it("consumidor com .gitignore próprio: acrescenta no fim e preserva o resto; idempotente", SLOW, () => {
    const s = sandbox();
    s.write(".gitignore", "node_modules/\n.env\n");

    expect(s.node("install.mjs").status).toBe(0);
    const once = s.read(".gitignore");
    expect(once.startsWith("node_modules/\n.env\n")).toBe(true);
    expect(once.split("\n").filter((l) => l === ".claude/worktrees/")).toHaveLength(1);

    const again = s.node("install.mjs");
    expect(again.status, again.out).toBe(0);
    expect(again.out).not.toMatch(/\.gitignore/);
    expect(s.read(".gitignore")).toBe(once);
  });

  it("não duplica quando o hospedeiro já ignora a pasta de outro jeito", SLOW, () => {
    const s = sandbox();
    // (o .trello-cache/ e o .superpowers/ também já estão: o install acrescenta essas regras ao lado da de worktrees)
    s.write(".gitignore", "/.claude/worktrees\n.trello-cache/\n/.superpowers\n");

    expect(s.node("install.mjs").status).toBe(0);

    expect(s.read(".gitignore")).toBe("/.claude/worktrees\n.trello-cache/\n/.superpowers\n");
  });

  it("--dry-run não escreve o .gitignore", SLOW, () => {
    const s = sandbox();
    const r = s.node("install.mjs", ["--dry-run"]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/would:.*\.gitignore/);
    expect(s.exists(".gitignore")).toBe(false);
  });
});

describe("install.mjs — worktree.baseRef no .claude/settings.json (issue 38)", () => {
  it("consumidor novo: grava worktree.baseRef head e é idempotente", SLOW, () => {
    const s = sandbox();

    const first = s.node("install.mjs");
    expect(first.status, first.out).toBe(0);
    expect(settingsOf(s).worktree).toEqual({ baseRef: "head" });

    const again = s.node("install.mjs");
    expect(again.status, again.out).toBe(0);
    expect(again.out).toMatch(/already installed|nothing to change/);
    expect(settingsOf(s).worktree).toEqual({ baseRef: "head" });
  });

  it("settings.json do hospedeiro: preserva o resto e a escolha explícita de baseRef", SLOW, () => {
    const s = sandbox();
    s.write(
      ".claude/settings.json",
      JSON.stringify({ model: "opus", worktree: { baseRef: "fresh", sparsePaths: ["src"] } }, null, 2) + "\n",
    );

    expect(s.node("install.mjs").status).toBe(0);

    const settings = settingsOf(s);
    expect(settings["model"]).toBe("opus");
    expect(settings.worktree).toEqual({ baseRef: "fresh", sparsePaths: ["src"] });
  });
});
