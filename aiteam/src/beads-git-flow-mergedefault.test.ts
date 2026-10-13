import { describe, expect, it } from "vitest";
import { load } from "js-yaml";
import { GITIGNORE } from "./beads-migrate.mjs";
import { SLOW, T, useFlowSandboxes, type Sandbox } from "./beads-sandbox.js";

// Fluxo git de verdade (ver beads-git-flow.test.ts): o merge da branch padrão,
// já migrada, numa branch que ainda está no modelo antigo — o sentido contrário
// ao do beads-git-flow-oldbranch. O lado que perde o bead aqui é o HEAD, não o
// MERGE_HEAD: sem a conferência dele, o `git rm --cached` do active.yaml (ou do
// espelho da branch) passava no pre-commit e o bead sumia do estado, até um
// `migrate-beads --scan-history` trazê-lo de volta. Contrato:
// aiteam/docs/beads-schema.md §11.

const kit = useFlowSandboxes(GITIGNORE);

const node = (id: string, status: string, at: string) =>
  `  - id: "${id}"\n    title: "${id}"\n    status: "${status}"\n    created_at: "${T(1)}"\n    updated_at: "${at}"\n`;
const legacy = (tasks: string) => `version: "1.0"\nbranch: "main"\nlast_updated: "${T(1)}"\ntasks:\n${tasks}`;
const BASE = legacy(node("api-velha", "pending", T(1)));
const OLD_BRANCH = legacy(`${node("api-velha", "in_progress", T(2))}${node("api-da-velha", "pending", T(2))}`);

const liveIds = (s: Sandbox) => (load(s.read(".beads/active.yaml")) as any).tasks.map((t: any) => t.id);
const statusOf = (s: Sandbox, id: string) => (load(s.read(".beads/index.yaml")) as any[]).find((e) => e.id === id)?.status;
const notBeadFiles = (s: Sandbox) => s.git("ls-files", ".beads").split("\n").filter((p) => p && !p.startsWith(".beads/tasks/"));

/**
 * main no modelo antigo → branch `velha` (ainda no antigo) → main migra → de
 * volta em `velha`, pronta para receber a default. `touchActive: false` é a
 * branch que só registrou no espelho dela (o caso comum do modelo antigo);
 * `otherMirror` deixa na main o espelho velho de uma terceira branch, que a
 * migração (sem --recover-mirrors) não traz de propósito.
 */
function legacyBranchBehindMigratedMain(opts: { touchActive: boolean; mirror?: string; otherMirror?: boolean }): Sandbox {
  const s = kit.repo({ legacy: true });
  s.write(".beads/active.yaml", BASE);
  s.write(".beads/main.yaml", BASE);
  if (opts.otherMirror) s.write(".beads/outra.yaml", legacy(node("api-antigo", "pending", T(1))));
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
  s.git("checkout", "-q", "velha");
  return s;
}

/** Tira o modelo antigo do índice e do disco, como quem resolve o conflito sem portar. */
function dropOldModel(s: Sandbox, files: string[]): void {
  s.git("rm", "-q", "--cached", "--", ...files);
  for (const f of files) s.remove(f);
}

describe("C1 — a default migrada entra numa branch legada: o bead do HEAD não some calado", () => {
  it("modify/delete do active.yaml: tirar o active.yaml e o espelho sem portar é recusado; depois do porte, passa e o merge de volta sai limpo", SLOW, () => {
    const s = legacyBranchBehindMigratedMain({ touchActive: true });
    expect(s.gitTry("merge", "main").status).not.toBe(0);
    dropOldModel(s, [".beads/active.yaml", ".beads/velha.yaml"]);

    const lost = s.gitTry("commit", "-q", "-m", "merge que perde o bead");
    expect(lost.status).not.toBe(0);
    expect(lost.out).toMatch(/api-da-velha/);
    expect(lost.out).toMatch(/api-velha/);
    // O lado que perde é o HEAD: a dica é o porte do HEAD, não do MERGE_HEAD.
    expect(lost.out).toMatch(/\(HEAD\) está no modelo antigo/);
    expect(lost.out).toMatch(/--port-from HEAD --recover-mirrors/);
    expect(lost.out).not.toMatch(/--port-from MERGE_HEAD/);

    const port = s.node("scripts/migrate-beads.mjs", ["--port-from", "HEAD", "--recover-mirrors"]);
    expect(port.status, port.out).toBe(0);
    expect(port.out).toMatch(/1 criado\(s\), 1 com entrada nova/);
    const ok = s.gitTry("commit", "-q", "-m", "merge com o bead portado");
    expect(ok.status, ok.out).toBe(0);
    expect(s.git("rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ").length).toBe(3); // commit de merge de verdade
    expect(liveIds(s).sort()).toEqual(["api-da-velha", "api-velha"]);
    expect(statusOf(s, "api-velha")).toBe("in_progress");
    expect(notBeadFiles(s)).toEqual([".beads/.gitignore"]);

    // E o merge de volta na default sai limpo, sem resíduo nem aviso.
    s.git("checkout", "-q", "main");
    const back = s.gitTry("merge", "--no-ff", "--no-edit", "velha");
    expect(back.status, back.out).toBe(0);
    expect(back.out).not.toMatch(/⚠/);
    const check = s.node("scripts/beads-check.mjs", ["--all"]);
    expect(check.status, check.out).toBe(0);
    expect(liveIds(s).sort()).toEqual(["api-da-velha", "api-velha"]);
    expect(statusOf(s, "api-velha")).toBe("in_progress");
  });

  it("branch que só registrou no espelho: o merge para antes do commit, tirar o espelho sem portar é recusado", SLOW, () => {
    const s = legacyBranchBehindMigratedMain({ touchActive: false });
    const m = s.gitTry("merge", "--no-commit", "--no-ff", "main");
    expect(m.status, m.out).toBe(0);
    dropOldModel(s, [".beads/velha.yaml"]);

    const lost = s.gitTry("commit", "-q", "-m", "merge que perde o espelho");
    expect(lost.status).not.toBe(0);
    expect(lost.out).toMatch(/api-da-velha/);
    expect(lost.out).toMatch(/\(HEAD\) está no modelo antigo/);
    expect(lost.out).toMatch(/--port-from HEAD --recover-mirrors/);
    // O active.yaml da branch é o da base, que a migração já trouxe: só o bead que existe
    // apenas no espelho entra na conta (api-velha, igual nos dois, não).
    expect(lost.out).toMatch(/tira \.beads\/active\.yaml, \.beads\/velha\.yaml do índice sem portar 1 bead\(s\) que o resultado não reflete: api-da-velha —/);

    const port = s.node("scripts/migrate-beads.mjs", ["--port-from", "HEAD", "--recover-mirrors"]);
    expect(port.status, port.out).toBe(0);
    const ok = s.gitTry("commit", "-q", "-m", "merge com o bead do espelho portado");
    expect(ok.status, ok.out).toBe(0);
    expect(liveIds(s)).toContain("api-da-velha");
    expect(notBeadFiles(s)).toEqual([".beads/.gitignore"]);
  });

  it("espelho da branch com YAML quebrado: é erro, não aviso — tirá-lo do merge é recusado", SLOW, () => {
    const s = legacyBranchBehindMigratedMain({ touchActive: false, mirror: 'version: "1.0"\ntasks: [\n  - {id: api-da-velha\n' });
    const m = s.gitTry("merge", "--no-commit", "--no-ff", "main");
    expect(m.status, m.out).toBe(0);
    dropOldModel(s, [".beads/velha.yaml"]);

    const lost = s.gitTry("commit", "-q", "-m", "merge que perde o espelho ilegível");
    expect(lost.status).not.toBe(0);
    expect(lost.out).toMatch(/o espelho da sua branch \(HEAD\) está ilegível/);
    expect(lost.out).toMatch(/\.beads\/velha\.yaml: /);
    expect(lost.out).toMatch(/Mantenha-o no índice/);

    // A saída da mensagem: manter o espelho no índice (ele fica rastreado, e o
    // validate:beads o aponta até alguém corrigi-lo e portá-lo).
    s.git("reset", "-q", "HEAD", "--", ".beads/velha.yaml");
    const ok = s.gitTry("commit", "-q", "-m", "merge que mantém o espelho ilegível");
    expect(ok.status, ok.out).toBe(0);
    expect(s.git("ls-files", ".beads/velha.yaml").trim()).toBe(".beads/velha.yaml");
  });

  it("espelho velho de OUTRA branch, que a branch não mexeu, não acusa e não trava o porte", SLOW, () => {
    const s = legacyBranchBehindMigratedMain({ touchActive: true, otherMirror: true });
    expect(s.gitTry("merge", "main").status).not.toBe(0);
    dropOldModel(s, [".beads/active.yaml", ".beads/velha.yaml"]);

    const lost = s.gitTry("commit", "-q", "-m", "merge que perde o bead");
    expect(lost.status).not.toBe(0);
    expect(lost.out).toMatch(/api-da-velha/);
    expect(lost.out).not.toMatch(/api-antigo/);

    // Sem --recover-mirrors o porte não traz o bead do espelho da terceira branch,
    // e o commit tem de passar assim mesmo: ele ficou fora da migração de propósito.
    const port = s.node("scripts/migrate-beads.mjs", ["--port-from", "HEAD"]);
    expect(port.status, port.out).toBe(0);
    const ok = s.gitTry("commit", "-q", "-m", "merge com o bead portado");
    expect(ok.status, ok.out).toBe(0);
    expect(liveIds(s)).not.toContain("api-antigo");
    expect(liveIds(s).sort()).toEqual(["api-da-velha", "api-velha"]);
  });

  it("squash da default migrada: sem MERGE_HEAD o HEAD continua conferido, com o espelho da própria branch", SLOW, () => {
    const s = legacyBranchBehindMigratedMain({ touchActive: true });
    expect(s.gitTry("merge", "--squash", "main").status).not.toBe(0);
    dropOldModel(s, [".beads/active.yaml", ".beads/velha.yaml"]);

    const lost = s.gitTry("commit", "-q", "-m", "squash que perde o bead");
    expect(lost.status).not.toBe(0);
    expect(lost.out).toMatch(/api-da-velha/);
    expect(lost.out).toMatch(/--port-from HEAD --recover-mirrors/);

    const port = s.node("scripts/migrate-beads.mjs", ["--port-from", "HEAD", "--recover-mirrors"]);
    expect(port.status, port.out).toBe(0);
    const ok = s.gitTry("commit", "-q", "-m", "squash com o bead portado");
    expect(ok.status, ok.out).toBe(0);
    expect(liveIds(s).sort()).toEqual(["api-da-velha", "api-velha"]);
  });

  it("ficar com o active.yaml da branch (modo legado) é recusado, e a mensagem manda portar o HEAD e tirá-lo do índice", SLOW, () => {
    const s = legacyBranchBehindMigratedMain({ touchActive: true });
    expect(s.gitTry("merge", "main").status).not.toBe(0);
    s.git("add", ".beads/active.yaml");
    const r = s.gitTry("commit", "-q", "-m", "merge que fica no modelo antigo");
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/modo legado/);
    expect(r.out).toMatch(/traz o modelo novo — a branch padrão já migrada — para uma branch ainda no modelo antigo/);
    expect(r.out).toMatch(/--port-from HEAD --recover-mirrors/);
    expect(r.out).toMatch(/git rm -q --cached -- \.beads\/active\.yaml/);

    // E o caminho que a mensagem aponta fecha o merge.
    const port = s.node("scripts/migrate-beads.mjs", ["--port-from", "HEAD", "--recover-mirrors"]);
    expect(port.status, port.out).toBe(0);
    dropOldModel(s, [".beads/active.yaml", ".beads/velha.yaml"]);
    const ok = s.gitTry("commit", "-q", "-m", "merge com o bead portado");
    expect(ok.status, ok.out).toBe(0);
    expect(liveIds(s).sort()).toEqual(["api-da-velha", "api-velha"]);
  });

  it("mexer no espelho da branch no meio do merge: a recusa fala do HEAD, não de uma branch mergeada", SLOW, () => {
    const s = legacyBranchBehindMigratedMain({ touchActive: true });
    expect(s.gitTry("merge", "main").status).not.toBe(0);
    s.git("rm", "-q", "--cached", "--", ".beads/active.yaml");
    s.remove(".beads/active.yaml");
    // O agente ainda registra no espelho (o protocolo antigo) e dá `git add`.
    s.write(".beads/velha.yaml", `${OLD_BRANCH}${node("api-extra", "pending", T(3))}`);
    s.git("add", ".beads/velha.yaml");
    const r = s.gitTry("commit", "-q", "-m", "merge com o espelho mexido");
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/\.beads\/velha\.yaml é do modelo antigo, e a sua branch \(HEAD\) é que ainda o usa/);
    expect(r.out).toMatch(/--port-from HEAD --recover-mirrors/);
    expect(r.out).not.toMatch(/veio no merge de uma branch aberta antes da migração/);
  });

  it("merge limpo (a branch só tinha o espelho): o post-merge avisa do resíduo da própria branch, e o porte do HEAD fecha", SLOW, () => {
    const s = legacyBranchBehindMigratedMain({ touchActive: false });
    const m = s.gitTry("merge", "--no-edit", "main");
    expect(m.status, m.out).toBe(0);
    expect(m.out).toMatch(/⚠⚠.*resíduo do modelo antigo/);
    expect(m.out).toMatch(/a sua, que recebeu a default já migrada/);
    expect(m.out).toMatch(/\.beads\/velha\.yaml/);
    expect(m.out).toMatch(/--port-from HEAD --recover-mirrors/);
    const check = s.node("scripts/beads-check.mjs", ["--all"]);
    expect(check.status).toBe(1);
    expect(check.out).toMatch(/\.beads\/velha\.yaml: .*porte com --port \.beads\/velha\.yaml antes do git rm --cached/);

    const port = s.node("scripts/migrate-beads.mjs", ["--port-from", "HEAD", "--recover-mirrors"]);
    expect(port.status, port.out).toBe(0);
    s.git("rm", "-q", "--cached", "--", ".beads/velha.yaml");
    s.remove(".beads/velha.yaml");
    const ok = s.gitTry("commit", "-q", "-m", "tira o espelho depois do porte");
    expect(ok.status, ok.out).toBe(0);
    expect(s.node("scripts/beads-check.mjs", ["--all"]).status).toBe(0);
    expect(liveIds(s)).toContain("api-da-velha");
  });
});

describe("C2 — o sentido já coberto não muda: a branch antiga entra na default migrada", () => {
  it("--port-from MERGE_HEAD continua sendo a saída, e o HEAD migrado não acusa nada", SLOW, () => {
    const s = legacyBranchBehindMigratedMain({ touchActive: true });
    s.git("checkout", "-q", "main");
    expect(s.gitTry("merge", "velha").status).not.toBe(0);
    dropOldModel(s, [".beads/active.yaml", ".beads/velha.yaml"]);

    const lost = s.gitTry("commit", "-q", "-m", "merge que perde o bead");
    expect(lost.status).not.toBe(0);
    expect(lost.out).toMatch(/a branch mergeada \(MERGE_HEAD\) está no modelo antigo/);
    expect(lost.out).toMatch(/api-da-velha/);
    expect(lost.out).toMatch(/--port-from MERGE_HEAD/);
    expect(lost.out).not.toMatch(/\(HEAD\) está no modelo antigo/);

    const port = s.node("scripts/migrate-beads.mjs", ["--port-from", "MERGE_HEAD", "--recover-mirrors"]);
    expect(port.status, port.out).toBe(0);
    const ok = s.gitTry("commit", "-q", "-m", "merge com o bead portado");
    expect(ok.status, ok.out).toBe(0);
    expect(liveIds(s).sort()).toEqual(["api-da-velha", "api-velha"]);
    expect(statusOf(s, "api-velha")).toBe("in_progress");
    expect(notBeadFiles(s)).toEqual([".beads/.gitignore"]);
  });
});
