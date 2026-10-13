import { describe, expect, it } from "vitest";
import { load } from "js-yaml";
import { GITIGNORE } from "./beads-migrate.mjs";
import { SLOW, T, useFlowSandboxes, type Sandbox } from "./beads-sandbox.js";

// Fluxo git de verdade (ver beads-git-flow.test.ts): a branch aberta antes da
// migração e mergeada depois dela (aiteam/docs/beads-schema.md §11). O que ela
// traz do modelo antigo não entra no git, e o bead dela não se perde no
// caminho: o merge só passa depois do --port. Arquivo próprio para rodar em
// paralelo com os outros cenários.

const kit = useFlowSandboxes(GITIGNORE);

const node = (id: string, status: string, at: string) =>
  `  - id: "${id}"\n    title: "${id}"\n    status: "${status}"\n    created_at: "${T(1)}"\n    updated_at: "${at}"\n`;
const legacy = (tasks: string) => `version: "1.0"\nbranch: "main"\nlast_updated: "${T(1)}"\ntasks:\n${tasks}`;
const BASE = legacy(node("api-velha", "pending", T(1)));
const OLD_BRANCH = legacy(`${node("api-velha", "in_progress", T(2))}${node("api-da-velha", "pending", T(2))}`);

const liveIds = (s: Sandbox) => (load(s.read(".beads/active.yaml")) as any).tasks.map((t: any) => t.id);
const statusOf = (s: Sandbox, id: string) => (load(s.read(".beads/index.yaml")) as any[]).find((e) => e.id === id)?.status;

/** main no modelo antigo → branch `velha` (ainda no antigo) → main migra. */
function oldBranchAfterMigration(opts: { touchActive: boolean; mirror?: string }): Sandbox {
  const s = kit.repo({ legacy: true });
  s.write(".beads/active.yaml", BASE);
  s.write(".beads/main.yaml", BASE);
  s.git("add", "-A");
  s.git("commit", "-q", "--no-verify", "-m", "modelo antigo");
  s.git("checkout", "-q", "-b", "velha");
  if (opts.touchActive) s.write(".beads/active.yaml", OLD_BRANCH);
  s.write(".beads/velha.yaml", opts.mirror ?? OLD_BRANCH);
  s.write("codigo.txt", "da velha\n");
  s.git("add", "-A");
  s.git("commit", "-q", "-m", "trabalho na branch antiga");
  s.git("checkout", "-q", "main");
  const m = s.node("scripts/migrate-beads.mjs");
  expect(m.status, m.out).toBe(0);
  const c = s.gitTry("commit", "-q", "-m", "migra");
  expect(c.status, c.out).toBe(0);
  return s;
}

describe("A2 — branch aberta antes da migração, mergeada depois", () => {
  it("o espelho e o active.yaml antigos não entram no merge: a recusa aponta o --port", SLOW, () => {
    const s = oldBranchAfterMigration({ touchActive: true });
    expect(s.gitTry("merge", "velha").status).not.toBe(0);
    s.git("add", ".beads/active.yaml", ".beads/velha.yaml");
    const r = s.gitTry("commit", "-q", "-m", "merge da velha");
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/\.beads\/velha\.yaml é do modelo antigo/);
    expect(r.out).toMatch(/\.beads\/active\.yaml é do modelo antigo/);
    expect(r.out).toMatch(/migrate-beads\.mjs --port \.beads\/velha\.yaml/);
    expect(r.out).toMatch(/--port-from MERGE_HEAD/);
    // O espelho pode ter bead que o active.yaml não tem: a dica cita o --recover-mirrors.
    expect(r.out).toMatch(/--port-from MERGE_HEAD --recover-mirrors/);
  });

  it("git rm do active.yaml sem portar perderia o bead: recusado; depois do --port-from, passa", SLOW, () => {
    const s = oldBranchAfterMigration({ touchActive: true });
    expect(s.gitTry("merge", "velha").status).not.toBe(0);
    s.git("rm", "-q", "--cached", "--", ".beads/active.yaml", ".beads/velha.yaml");
    s.remove(".beads/active.yaml");
    s.remove(".beads/velha.yaml");
    const lost = s.gitTry("commit", "-q", "-m", "merge que perde o bead");
    expect(lost.status).not.toBe(0);
    expect(lost.out).toMatch(/modelo antigo/);
    expect(lost.out).toMatch(/api-da-velha/);
    expect(lost.out).toMatch(/api-velha/);
    expect(lost.out).toMatch(/--port-from MERGE_HEAD/);

    const port = s.node("scripts/migrate-beads.mjs", ["--port-from", "MERGE_HEAD"]);
    expect(port.status, port.out).toBe(0);
    expect(port.out).toMatch(/1 criado\(s\), 1 com entrada nova/);
    const ok = s.gitTry("commit", "-q", "-m", "merge com o bead portado");
    expect(ok.status, ok.out).toBe(0);
    expect(liveIds(s).sort()).toEqual(["api-da-velha", "api-velha"]);
    expect(statusOf(s, "api-velha")).toBe("in_progress");
    expect(s.git("ls-files", ".beads").split("\n").filter((p) => p && !p.startsWith(".beads/tasks/"))).toEqual([".beads/.gitignore"]);
    expect(s.git("status", "--porcelain", "--ignored", ".beads").trim()).not.toMatch(/editado/);
  });

  it("merge limpo que traz só o espelho: o post-merge avisa alto e o validate:beads aponta o --port", SLOW, () => {
    const s = oldBranchAfterMigration({ touchActive: false });
    const m = s.gitTry("merge", "--no-edit", "velha");
    expect(m.status, m.out).toBe(0);
    expect(m.out).toMatch(/⚠⚠.*resíduo do modelo antigo/);
    expect(m.out).toMatch(/\.beads\/velha\.yaml/);
    expect(m.out).toMatch(/--port/);
    expect(m.out).toMatch(/--port-from HEAD --recover-mirrors/);

    const check = s.node("scripts/beads-check.mjs", ["--all"]);
    expect(check.status).toBe(1);
    expect(check.out).toMatch(/\.beads\/velha\.yaml: .*porte com --port \.beads\/velha\.yaml antes do git rm --cached/);
  });
});

// A1: o legacyMergeProblems ignorava os espelhos. Uma branch antiga que só
// criou o espelho dela (o caso comum: o agente registrava no espelho da
// branch) passava no pre-commit, e o `git rm` do espelho perdia o bead calado.
// O confere vale só para os espelhos que o MERGE_HEAD mudou desde a base: os
// espelhos velhos de outras branches, que a migração deixou de fora de
// propósito, não acusam.
describe("A1 — o espelho da própria branch antiga é conferido", () => {
  it("merge que só traz o espelho: tirá-lo sem portar é recusado, com a dica do --recover-mirrors", SLOW, () => {
    const s = oldBranchAfterMigration({ touchActive: false });
    const m = s.gitTry("merge", "--no-commit", "--no-ff", "velha");
    expect(m.status, m.out).toBe(0);
    s.git("rm", "-q", "--cached", "--", ".beads/velha.yaml");
    s.remove(".beads/velha.yaml");
    const lost = s.gitTry("commit", "-q", "-m", "merge que perde o espelho");
    expect(lost.status).not.toBe(0);
    expect(lost.out).toMatch(/api-da-velha/);
    expect(lost.out).toMatch(/--port-from MERGE_HEAD --recover-mirrors/);

    const port = s.node("scripts/migrate-beads.mjs", ["--port-from", "MERGE_HEAD", "--recover-mirrors"]);
    expect(port.status, port.out).toBe(0);
    const ok = s.gitTry("commit", "-q", "-m", "merge com o bead do espelho portado");
    expect(ok.status, ok.out).toBe(0);
    expect(liveIds(s)).toContain("api-da-velha");
  });

  // A-A8: o espelho ilegível da própria branch antiga virava só aviso, e o `git rm` perdia o
  // bead dele calado. Agora é erro.
  it("A-A8: espelho ilegível da própria branch antiga é erro: tirá-lo do merge é recusado", SLOW, () => {
    const s = oldBranchAfterMigration({ touchActive: false, mirror: "version: \"1.0\"\ntasks: [\n  - {id: api-da-velha\n" });
    const m = s.gitTry("merge", "--no-commit", "--no-ff", "velha");
    expect(m.status, m.out).toBe(0);
    s.git("rm", "-q", "--cached", "--", ".beads/velha.yaml");
    s.remove(".beads/velha.yaml");
    const lost = s.gitTry("commit", "-q", "-m", "merge que perde o espelho ilegível");
    expect(lost.status).not.toBe(0);
    expect(lost.out).toMatch(/o espelho da branch mergeada \(MERGE_HEAD\) está ilegível/);
    expect(lost.out).toMatch(/\.beads\/velha\.yaml: /);
    expect(lost.out).toMatch(/--port-from MERGE_HEAD --recover-mirrors/);
  });

  it("espelho velho de outra branch, que o merge não mexeu, não acusa", SLOW, () => {
    const s = kit.repo({ legacy: true });
    s.write(".beads/active.yaml", BASE);
    s.write(".beads/main.yaml", BASE);
    // Espelho de uma branch qualquer, de antes da migração, com um bead que a
    // migração (sem --recover-mirrors) deixou de fora.
    s.write(".beads/outra.yaml", legacy(node("api-antigo", "pending", T(1))));
    s.git("add", "-A");
    s.git("commit", "-q", "--no-verify", "-m", "modelo antigo");
    s.git("checkout", "-q", "-b", "velha");
    s.write(".beads/active.yaml", legacy(node("api-velha", "in_progress", T(2))));
    s.write("codigo.txt", "da velha\n");
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "trabalho na branch antiga");
    s.git("checkout", "-q", "main");
    const mig = s.node("scripts/migrate-beads.mjs");
    expect(mig.status, mig.out).toBe(0);
    expect(s.gitTry("commit", "-q", "-m", "migra").status).toBe(0);

    expect(s.gitTry("merge", "--no-commit", "--no-ff", "velha").status).not.toBe(0);
    s.git("rm", "-q", "--cached", "--", ".beads/active.yaml");
    s.remove(".beads/active.yaml");
    const port = s.node("scripts/migrate-beads.mjs", ["--port-from", "MERGE_HEAD"]);
    expect(port.status, port.out).toBe(0);
    const ok = s.gitTry("commit", "-q", "-m", "merge da velha");
    expect(ok.status, ok.out).toBe(0);
    expect(statusOf(s, "api-velha")).toBe("in_progress");
  });
});
