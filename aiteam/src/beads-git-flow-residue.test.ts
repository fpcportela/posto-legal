import { describe, expect, it } from "vitest";
import { load } from "js-yaml";
import { GITIGNORE } from "./beads-migrate.mjs";
import { SLOW, T, useFlowSandboxes, type Sandbox } from "./beads-sandbox.js";

// Fluxo git de verdade (ver beads-git-flow.test.ts): o resíduo do modelo antigo
// que um merge LIMPO deixa rastreado num repo já migrado (o espelho ou o
// archive/ de uma branch aberta antes da migração). O post-merge avisa, mas o
// `git rm --cached` do resíduo num commit COMUM não passava por nenhuma
// conferência: o commit saía 0 e o bead que só existia ali sumia do estado. Agora
// o pre-commit confere o que o commit apaga do índice, sem base de merge
// (aiteam/docs/beads-schema.md §8 e §11).

const kit = useFlowSandboxes(GITIGNORE);

const node = (id: string, status: string, at: string) =>
  `  - id: "${id}"\n    title: "${id}"\n    status: "${status}"\n    created_at: "${T(1)}"\n    updated_at: "${at}"\n`;
const legacy = (tasks: string) => `version: "1.0"\nbranch: "main"\nlast_updated: "${T(1)}"\ntasks:\n${tasks}`;
const BASE = legacy(node("api-velha", "pending", T(1)));
const OLD_BRANCH = legacy(`${node("api-velha", "in_progress", T(2))}${node("api-da-velha", "pending", T(2))}`);

const liveIds = (s: Sandbox) => (load(s.read(".beads/active.yaml")) as any).tasks.map((t: any) => t.id);
const notBeadFiles = (s: Sandbox) => s.git("ls-files", ".beads").split("\n").filter((p) => p && !p.startsWith(".beads/tasks/"));

/**
 * main no modelo antigo → branch `velha` (modelo antigo, só com os arquivos que
 * ela criou) → main migra → de volta em `velha`, pronta para receber a default.
 */
function legacyBranchBehindMigratedMain(velhaFiles: Record<string, string>): Sandbox {
  const s = kit.repo({ legacy: true });
  s.write(".beads/active.yaml", BASE);
  s.write(".beads/main.yaml", BASE);
  s.git("add", "-A");
  s.git("commit", "-q", "--no-verify", "-m", "modelo antigo");
  s.git("checkout", "-q", "-b", "velha");
  for (const [rel, text] of Object.entries(velhaFiles)) s.write(rel, text);
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

/** Tira o resíduo do índice e do disco, como quem faz a limpeza que o post-merge pediu. */
function dropResidue(s: Sandbox, files: string[]): void {
  s.git("rm", "-q", "--cached", "--", ...files);
  for (const f of files) s.remove(f);
}

// A5: com o HEAD ainda legado, um commit comum que tira o active.yaml / archive/ do índice
// passava sem conferência ("é a migração"). Um `git rm --cached` manual, sem rodar o migrate,
// perdia tudo. A migração real (migrate-beads.mjs) leva os nós do active.yaml e do archive/
// e deixa de fora, de propósito, o que só existe em espelho: ela continua passando.
describe("C5 — HEAD legado: o commit que tira o active.yaml e o archive/ do índice", () => {
  function legacyRepoWithMirrors(): Sandbox {
    const s = kit.repo({ legacy: true });
    s.write(".beads/active.yaml", legacy(`${node("a1", "pending", T(1))}${node("a2", "in_progress", T(2))}`));
    s.write(".beads/main.yaml", BASE);
    s.write(".beads/outra.yaml", legacy(node("so-no-espelho", "pending", T(1))));
    s.write(".beads/archive/completed.yaml", legacy(node("arq1", "completed", T(1))));
    s.git("add", "-A");
    s.git("commit", "-q", "--no-verify", "-m", "modelo antigo");
    return s;
  }

  it("git rm --cached manual do active.yaml e do archive/, sem migrar: recusado, com os ids", SLOW, () => {
    const s = legacyRepoWithMirrors();
    dropResidue(s, [".beads/active.yaml", ".beads/archive/completed.yaml"]);
    const lost = s.gitTry("commit", "-q", "-m", "tira o modelo antigo na mão");
    expect(lost.status, lost.out).not.toBe(0);
    expect(lost.out).toMatch(/a sua branch \(HEAD\) está no modelo antigo e este commit tira \.beads\/active\.yaml, \.beads\/archive\/completed\.yaml do índice sem portar 3 bead\(s\)/);
    expect(lost.out).toMatch(/a1, a2, arq1/);
    // Os espelhos ficam de fora na migração, de propósito: não entram na conta.
    expect(lost.out).not.toMatch(/so-no-espelho/);
  });

  it("L1: a migração real passa — o espelho só-espelho que ela deixa de fora de propósito não a recusa", SLOW, () => {
    const s = legacyRepoWithMirrors();
    const m = s.node("scripts/migrate-beads.mjs");
    expect(m.status, m.out).toBe(0);
    // api-velha (main.yaml) e so-no-espelho (outra.yaml) só existem em espelho: ficam de fora.
    expect(m.out).toMatch(/só em espelhos: 2 \(ficam de fora sem --recover-mirrors\)/);
    const c = s.gitTry("commit", "-q", "-m", "migra");
    expect(c.status, c.out).toBe(0);
    expect(liveIds(s).sort()).toEqual(["a1", "a2"]);
    const index = (load(s.read(".beads/index.yaml")) as any[]).map((e) => e.id).sort();
    expect(index).toEqual(["a1", "a2", "arq1"]);
  });
});

describe("C3 — git rm --cached do resíduo num commit comum não perde o bead", () => {
  it("o espelho da própria branch antiga, que ficou no merge limpo da default: recusado; depois do porte, a limpeza passa", SLOW, () => {
    const s = legacyBranchBehindMigratedMain({ ".beads/velha.yaml": OLD_BRANCH });
    const m = s.gitTry("merge", "--no-edit", "main");
    expect(m.status, m.out).toBe(0);
    expect(m.out).toMatch(/⚠⚠.*resíduo do modelo antigo/);
    expect(s.git("ls-files", ".beads/velha.yaml").trim()).toBe(".beads/velha.yaml");

    dropResidue(s, [".beads/velha.yaml"]);
    const lost = s.gitTry("commit", "-q", "-m", "tira o espelho sem portar");
    expect(lost.status).not.toBe(0);
    expect(lost.out).toMatch(/api-da-velha/);
    expect(lost.out).toMatch(/tira \.beads\/velha\.yaml do índice sem portar/);
    expect(lost.out).toMatch(/--port-from HEAD --recover-mirrors/);
    expect(lost.out).toMatch(/--port HEAD:\.beads\/velha\.yaml/);

    const port = s.node("scripts/migrate-beads.mjs", ["--port-from", "HEAD", "--recover-mirrors"]);
    expect(port.status, port.out).toBe(0);
    const ok = s.gitTry("commit", "-q", "-m", "tira o espelho depois do porte");
    expect(ok.status, ok.out).toBe(0);
    expect(liveIds(s).sort()).toEqual(["api-da-velha", "api-velha"]);
    expect(notBeadFiles(s)).toEqual([".beads/.gitignore"]);
    expect(s.node("scripts/beads-check.mjs", ["--all"]).status).toBe(0);
  });

  it("o espelho que veio do MERGE_HEAD (branch antiga mergeada na default, merge limpo): recusado; depois do porte, passa", SLOW, () => {
    const s = legacyBranchBehindMigratedMain({ ".beads/velha.yaml": OLD_BRANCH });
    s.git("checkout", "-q", "main");
    const m = s.gitTry("merge", "--no-edit", "velha");
    expect(m.status, m.out).toBe(0);
    expect(s.git("ls-files", ".beads/velha.yaml").trim()).toBe(".beads/velha.yaml");

    dropResidue(s, [".beads/velha.yaml"]);
    const lost = s.gitTry("commit", "-q", "-m", "tira o espelho sem portar");
    expect(lost.status).not.toBe(0);
    expect(lost.out).toMatch(/api-da-velha/);
    expect(lost.out).toMatch(/--port-from HEAD --recover-mirrors/);

    const port = s.node("scripts/migrate-beads.mjs", ["--port-from", "HEAD", "--recover-mirrors"]);
    expect(port.status, port.out).toBe(0);
    const ok = s.gitTry("commit", "-q", "-m", "tira o espelho depois do porte");
    expect(ok.status, ok.out).toBe(0);
    expect(liveIds(s)).toContain("api-da-velha");
  });

  // A2: no commit de merge o HEAD já migrado só tinha o resíduo conferido se o espelho tivesse
  // mudado desde a base do merge. O resíduo velho (anterior à base) saía de graça dentro de um
  // merge de branch filha. Com o HEAD migrado, vale todo espelho que sai, como no commit comum.
  it("A2: resíduo anterior à base que sai dentro de um commit de merge é conferido do mesmo jeito", SLOW, () => {
    const s = legacyBranchBehindMigratedMain({ ".beads/velha.yaml": OLD_BRANCH });
    const clean = s.gitTry("merge", "--no-edit", "main"); // o resíduo velha.yaml fica rastreado
    expect(clean.status, clean.out).toBe(0);
    s.git("checkout", "-q", "-b", "sub");
    s.write("s.txt", "sub\n");
    s.git("add", "s.txt");
    s.git("commit", "-q", "-m", "sub");
    s.git("checkout", "-q", "velha");
    s.write("v.txt", "velha avança\n");
    s.git("add", "v.txt");
    s.git("commit", "-q", "-m", "velha avança");
    const m = s.gitTry("merge", "--no-commit", "--no-ff", "sub");
    expect(m.status, m.out).toBe(0);

    dropResidue(s, [".beads/velha.yaml"]);
    const lost = s.gitTry("commit", "-q", "-m", "merge da filha que limpa o resíduo sem portar");
    expect(lost.status, lost.out).not.toBe(0);
    expect(lost.out).toMatch(/api-da-velha/);
    expect(lost.out).toMatch(/o HEAD ainda rastreia o modelo antigo/);

    const port = s.node("scripts/migrate-beads.mjs", ["--port-from", "HEAD", "--recover-mirrors"]);
    expect(port.status, port.out).toBe(0);
    const ok = s.gitTry("commit", "-q", "-m", "merge da filha com o bead portado");
    expect(ok.status, ok.out).toBe(0);
    expect(liveIds(s)).toContain("api-da-velha");
  });

  it("o archive/completed.yaml que veio no merge limpo também é conferido", SLOW, () => {
    const done = legacy(node("api-arquivada", "completed", T(2)));
    const s = legacyBranchBehindMigratedMain({ ".beads/archive/completed.yaml": done });
    s.git("checkout", "-q", "main");
    const m = s.gitTry("merge", "--no-edit", "velha");
    expect(m.status, m.out).toBe(0);
    expect(s.git("ls-files", ".beads/archive/completed.yaml").trim()).toBe(".beads/archive/completed.yaml");

    dropResidue(s, [".beads/archive/completed.yaml"]);
    const lost = s.gitTry("commit", "-q", "-m", "tira o archive sem portar");
    expect(lost.status).not.toBe(0);
    expect(lost.out).toMatch(/api-arquivada/);
    expect(lost.out).toMatch(/tira \.beads\/archive\/completed\.yaml do índice sem portar/);
    expect(lost.out).toMatch(/--port-from HEAD/);

    const port = s.node("scripts/migrate-beads.mjs", ["--port-from", "HEAD"]);
    expect(port.status, port.out).toBe(0);
    const ok = s.gitTry("commit", "-q", "-m", "tira o archive depois do porte");
    expect(ok.status, ok.out).toBe(0);
    // Concluído não está no active.yaml (só os vivos): confere no índice.
    const entry = (load(s.read(".beads/index.yaml")) as any[]).find((e) => e.id === "api-arquivada");
    expect(entry?.status).toBe("completed");
  });

  it("espelho velho de outra branch, cujos beads já estão em .beads/tasks/, apaga-se sem recusa", SLOW, () => {
    // O espelho só tem o que a migração já trouxe (api-velha, igual ao estado).
    const s = legacyBranchBehindMigratedMain({ ".beads/outra.yaml": BASE });
    s.git("checkout", "-q", "main");
    const m = s.gitTry("merge", "--no-edit", "velha");
    expect(m.status, m.out).toBe(0);
    expect(s.git("ls-files", ".beads/outra.yaml").trim()).toBe(".beads/outra.yaml");

    dropResidue(s, [".beads/outra.yaml"]);
    const ok = s.gitTry("commit", "-q", "-m", "limpeza do espelho já refletido");
    expect(ok.status, ok.out).toBe(0);
    expect(ok.out).not.toMatch(/sem portar/);
    expect(liveIds(s)).toEqual(["api-velha"]);
    expect(notBeadFiles(s)).toEqual([".beads/.gitignore"]);
  });
});
