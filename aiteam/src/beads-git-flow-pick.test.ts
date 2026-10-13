import { describe, expect, it } from "vitest";
import { load } from "js-yaml";
import { GITIGNORE } from "./beads-migrate.mjs";
import { SLOW, T, useFlowSandboxes, type Sandbox } from "./beads-sandbox.js";

// Fluxo git de verdade (ver beads-git-flow.test.ts): rebase e cherry-pick de uma
// branch do modelo antigo sobre a default já migrada. O HEAD é a default (migrada),
// não há MERGE_HEAD, e depois do `git rm --cached` do active.yaml e do espelho o
// diff do commit não tinha .beads nenhum: o hook voltava cedo, o `--continue`
// passava e o bead sumia do estado — e nem o `--scan-history` o recuperava, porque
// a versão antiga saía do histórico do HEAD. O lado "de lá" aqui é o REBASE_HEAD
// (o commit que o rebase está aplicando) ou o CHERRY_PICK_HEAD. Contrato:
// aiteam/docs/beads-schema.md §11.

const kit = useFlowSandboxes(GITIGNORE);

const node = (id: string, status: string, at: string) =>
  `  - id: "${id}"\n    title: "${id}"\n    status: "${status}"\n    created_at: "${T(1)}"\n    updated_at: "${at}"\n`;
const legacy = (tasks: string) => `version: "1.0"\nbranch: "main"\nlast_updated: "${T(1)}"\ntasks:\n${tasks}`;
const BASE = legacy(node("api-velha", "pending", T(1)));
const OLD_BRANCH = legacy(`${node("api-velha", "in_progress", T(2))}${node("api-da-velha", "pending", T(2))}`);

const liveIds = (s: Sandbox) => (load(s.read(".beads/active.yaml")) as any).tasks.map((t: any) => t.id);
const notBeadFiles = (s: Sandbox) => s.git("ls-files", ".beads").split("\n").filter((p) => p && !p.startsWith(".beads/tasks/"));
const EDITOR = ["-c", "core.editor=true"];

/** main no modelo antigo → branch `velha` (antiga, active.yaml e espelho) → main migra. Fica em `velha`. */
function legacyBranchBehindMigratedMain(): Sandbox {
  const s = kit.repo({ legacy: true });
  s.write(".beads/active.yaml", BASE);
  s.write(".beads/main.yaml", BASE);
  s.git("add", "-A");
  s.git("commit", "-q", "--no-verify", "-m", "modelo antigo");
  s.git("checkout", "-q", "-b", "velha");
  s.write(".beads/active.yaml", OLD_BRANCH);
  s.write(".beads/velha.yaml", OLD_BRANCH);
  s.write("codigo.txt", "da velha\n");
  s.git("add", "-A");
  s.git("commit", "-q", "-m", "trabalho na branch antiga");
  s.git("checkout", "-q", "main");
  const m = s.node("scripts/migrate-beads.mjs");
  expect(m.status, m.out).toBe(0);
  const c = s.gitTry("commit", "-q", "-m", "migra");
  expect(c.status, c.out).toBe(0);
  s.git("checkout", "-q", "velha");
  return s;
}

function dropOldModel(s: Sandbox, files: string[]): void {
  s.git("rm", "-q", "--cached", "--", ...files);
  for (const f of files) s.remove(f);
}

describe("C4 — rebase e cherry-pick do modelo antigo sobre a default migrada", () => {
  // O git roda os commits de um rebase com -n: o `rebase --continue` NÃO chama o pre-commit
  // (o cherry-pick --continue chama), então não dá para recusar ali. O post-rewrite confere
  // no fim contra o ORIG_HEAD e avisa alto, com o comando que traz o bead de volta.
  it("rebase: o git não roda o pre-commit no --continue; o post-rewrite avisa alto, e o porte do ORIG_HEAD recupera o bead", SLOW, () => {
    const s = legacyBranchBehindMigratedMain();
    expect(s.gitTry("rebase", "main").status).not.toBe(0);
    dropOldModel(s, [".beads/active.yaml", ".beads/velha.yaml"]);

    const done = s.gitTry(...EDITOR, "rebase", "--continue");
    expect(done.status, done.out).toBe(0);
    expect(s.git("branch", "--show-current").trim()).toBe("velha");
    expect(done.out).toMatch(/a branch antes do rebase \(ORIG_HEAD\) estava no modelo antigo e o rebase tirou \.beads\/active\.yaml, \.beads\/velha\.yaml do índice sem portar 2 bead\(s\)/);
    expect(done.out).toMatch(/api-da-velha/);
    expect(done.out).toMatch(/--port-from ORIG_HEAD --recover-mirrors/);
    expect(done.out).toMatch(/⚠⚠.*o rebase deixou bead para trás/);
    expect(liveIds(s)).toEqual(["api-velha"]);

    // O comando do aviso traz o bead de volta, e o commit seguinte passa.
    const port = s.node("scripts/migrate-beads.mjs", ["--port-from", "ORIG_HEAD", "--recover-mirrors"]);
    expect(port.status, port.out).toBe(0);
    expect(port.out).toMatch(/1 criado\(s\), 1 com entrada nova/);
    const ok = s.gitTry("commit", "-q", "-m", "porta o bead que o rebase deixou");
    expect(ok.status, ok.out).toBe(0);
    expect(liveIds(s).sort()).toEqual(["api-da-velha", "api-velha"]);
    expect(notBeadFiles(s)).toEqual([".beads/.gitignore"]);
    expect(s.node("scripts/beads-check.mjs", ["--all"]).status).toBe(0);
  });

  it("rebase com o porte feito no meio (--port-from REBASE_HEAD): o --continue e o post-rewrite ficam em silêncio", SLOW, () => {
    const s = legacyBranchBehindMigratedMain();
    expect(s.gitTry("rebase", "main").status).not.toBe(0);
    const port = s.node("scripts/migrate-beads.mjs", ["--port-from", "REBASE_HEAD", "--recover-mirrors"]);
    expect(port.status, port.out).toBe(0);
    expect(port.out).toMatch(/1 criado\(s\), 1 com entrada nova/);
    // O porte no meio do rebase não regenera as visões: a árvore ainda tem o active.yaml antigo.
    expect(s.exists(".beads/active.yaml.editado-20261009T120000Z")).toBe(false);
    dropOldModel(s, [".beads/active.yaml", ".beads/velha.yaml"]);

    const done = s.gitTry(...EDITOR, "rebase", "--continue");
    expect(done.status, done.out).toBe(0);
    expect(done.out).not.toMatch(/o rebase tirou|deixou bead para trás/);
    expect(s.git("branch", "--show-current").trim()).toBe("velha");
    expect(liveIds(s).sort()).toEqual(["api-da-velha", "api-velha"]);
    expect(notBeadFiles(s)).toEqual([".beads/.gitignore"]);
    expect(s.node("scripts/beads-check.mjs", ["--all"]).status).toBe(0);
  });

  it("cherry-pick: o mesmo, com o CHERRY_PICK_HEAD", SLOW, () => {
    const s = legacyBranchBehindMigratedMain();
    const picked = s.git("rev-parse", "velha").trim();
    s.git("checkout", "-q", "main");
    expect(s.gitTry("cherry-pick", picked).status).not.toBe(0);
    dropOldModel(s, [".beads/active.yaml", ".beads/velha.yaml"]);

    const lost = s.gitTry(...EDITOR, "cherry-pick", "--continue");
    expect(lost.status, lost.out).not.toBe(0);
    expect(lost.out).toMatch(/api-da-velha/);
    expect(lost.out).toMatch(/\(CHERRY_PICK_HEAD\) está no modelo antigo/);
    expect(lost.out).toMatch(/--port-from CHERRY_PICK_HEAD/);
    expect(lost.out).not.toMatch(/MERGE_HEAD/);

    const port = s.node("scripts/migrate-beads.mjs", ["--port-from", "CHERRY_PICK_HEAD", "--recover-mirrors"]);
    expect(port.status, port.out).toBe(0);
    const ok = s.gitTry(...EDITOR, "cherry-pick", "--continue");
    expect(ok.status, ok.out).toBe(0);
    expect(s.git("branch", "--show-current").trim()).toBe("main");
    expect(liveIds(s).sort()).toEqual(["api-da-velha", "api-velha"]);
    expect(notBeadFiles(s)).toEqual([".beads/.gitignore"]);
  });
});
