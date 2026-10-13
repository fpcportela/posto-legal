import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { load } from "js-yaml";
import { GITIGNORE } from "./beads-migrate.mjs";
import { commitAll, commitTry, definition, entry, SLOW, T, useFlowSandboxes, type Sandbox } from "./beads-sandbox.js";

// Fluxo git de verdade (ver beads-git-flow.test.ts): B6–B10, as recusas do
// pre-commit e a regeneração das visões pelos hooks. Contrato:
// aiteam/docs/beads-schema.md §7.3 e §8.

const kit = useFlowSandboxes(GITIGNORE);

const liveIds = (s: Sandbox) => (load(s.read(".beads/active.yaml")) as any).tasks.map((t: any) => t.id);
const indexed = (s: Sandbox, id: string) => (load(s.read(".beads/index.yaml")) as any[]).find((e) => e.id === id);

const BEAD_A = `${definition("Bead A", T(1))}entries:\n${entry(T(1, 11), { status: "in_progress" })}`;

function withBeadA(): Sandbox {
  const s = kit.repo();
  s.write(".beads/tasks/api-a/main.yaml", BEAD_A);
  commitAll(s, "bead A");
  return s;
}

describe("B6 — recusas do pre-commit", () => {
  it("arquivo de outra branch, com o caminho certo na mensagem", SLOW, () => {
    const s = withBeadA();
    s.git("checkout", "-q", "-b", "feat/x");
    s.write(".beads/tasks/api-a/main.yaml", `${BEAD_A}${entry(T(2), { status: "blocked" })}`);
    const r = commitTry(s, "mexe no arquivo da main");
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/\.beads\/tasks\/api-a\/main\.yaml é da branch "main"; você está em "feat\/x"/);
    expect(r.out).toMatch(/\.beads\/tasks\/api-a\/feat-x\.yaml/);
  });

  it("git add -f da visão e espelho do modelo antigo", SLOW, () => {
    const s = withBeadA();
    s.git("add", "-f", ".beads/active.yaml");
    const v = s.gitTry("commit", "-q", "-m", "visão");
    expect(v.status).not.toBe(0);
    expect(v.out).toMatch(/active\.yaml fica fora do git/);
    s.git("reset", "-q");

    s.write(".beads/main.yaml", 'version: "1.0"\ntasks: []\n');
    const m = commitTry(s, "espelho");
    expect(m.status).not.toBe(0);
    expect(m.out).toMatch(/modelo antigo/);
    s.git("reset", "-q");
    s.remove(".beads/main.yaml");

    // Um active.yaml no formato antigo, forçado: não pode religar o modo legado.
    s.write(".beads/active.yaml", 'version: "1.0"\nbranch: "main"\ntasks: []\n');
    s.git("add", "-f", ".beads/active.yaml");
    const legado = s.gitTry("commit", "-q", "-m", "active antigo forçado");
    expect(legado.status).not.toBe(0);
    expect(legado.out).toMatch(/active\.yaml fica fora do git/);
  });

  it("branch com tag de mesmo nome escreve no arquivo com o nome da branch", SLOW, () => {
    const s = withBeadA();
    s.git("tag", "feat-t");
    s.git("checkout", "-q", "-b", "feat-t");
    s.write(".beads/tasks/api-t/feat-t.yaml", definition("T", T(2)));
    const r = commitTry(s, "bead na branch que tem tag gêmea");
    expect(r.status, r.out).toBe(0);
  });

  it("editar o meio do próprio arquivo já commitado é erro; acrescentar no fim passa", SLOW, () => {
    const s = withBeadA();
    s.write(".beads/tasks/api-a/main.yaml", BEAD_A.replace('"in_progress"', '"blocked"'));
    const meio = commitTry(s, "edita o meio");
    expect(meio.status).not.toBe(0);
    expect(meio.out).toMatch(/só cresce no fim/);

    s.write(".beads/tasks/api-a/main.yaml", `${BEAD_A}${entry(T(2), { status: "blocked" })}`);
    const fim = commitTry(s, "acrescenta");
    expect(fim.status, fim.out).toBe(0);
    expect(indexed(s, "api-a").status).toBe("blocked");
  });

  // R6: uma linha anexada à última entrada já commitada é só um acréscimo
  // textual, mas passaria a valer com o `at` antigo.
  it("R6: campo anexado à última entrada já commitada é recusado, dizendo qual; entrada nova passa", SLOW, () => {
    const s = withBeadA();
    s.write(".beads/tasks/api-a/main.yaml", `${BEAD_A}    stage: "review"\n`);
    const anexo = commitTry(s, "anexa campo à última entrada");
    expect(anexo.status).not.toBe(0);
    expect(anexo.out).toMatch(/stage acrescentado à entrada 1/);
    expect(anexo.out).toMatch(/comece uma entrada nova com "- at:"/);

    s.write(".beads/tasks/api-a/main.yaml", `${BEAD_A}${entry(T(2), { stage: "review" })}`);
    const nova = commitTry(s, "entrada nova");
    expect(nova.status, nova.out).toBe(0);
    expect((load(s.read(".beads/active.yaml")) as any).tasks[0].stage).toBe("review");
  });

  // A4: feat/x e feat-x viram o mesmo arquivo. O aviso olhava só os heads
  // locais; uma branch que só existe no remoto colide do mesmo jeito.
  it("A4: a colisão feat/x × feat-x considera as branches locais e as remotas", SLOW, () => {
    const s = withBeadA();
    s.git("update-ref", "refs/remotes/origin/feat-x", "HEAD");
    // origin/HEAD e a mesma branch no remoto (origin/feat/x) não são colisão.
    s.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    s.git("update-ref", "refs/remotes/origin/main", "HEAD");
    s.git("update-ref", "refs/remotes/origin/feat/x", "HEAD");
    s.git("checkout", "-q", "-b", "feat/x");
    s.write(".beads/tasks/api-b/feat-x.yaml", definition("B", T(2)));
    const remota = commitTry(s, "bead na branch que colide com a remota");
    expect(remota.status, remota.out).toBe(0);
    expect(remota.out).toMatch(/as branches "feat\/x" e "feat-x" viram o mesmo arquivo feat-x\.yaml/);
    expect(remota.out).not.toMatch(/"feat\/x" e "feat\/x"|"HEAD"|"main"/);

    // Local, como antes.
    s.git("checkout", "-q", "-b", "feat-x");
    s.write(".beads/tasks/api-b/feat-x.yaml", `${definition("B", T(2))}entries:\n${entry(T(3), { status: "blocked" })}`);
    const local = commitTry(s, "bead na branch que colide com a local");
    expect(local.status, local.out).toBe(0);
    expect(local.out).toMatch(/as branches "feat-x" e "feat\/x" viram o mesmo arquivo feat-x\.yaml/);
  });

  it("apagar um arquivo de bead é recusado", SLOW, () => {
    const s = withBeadA();
    s.remove(".beads/tasks/api-a/main.yaml");
    const r = commitTry(s, "apaga");
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/histórico não se apaga/);
  });
});

describe("B7 — commit de merge fica isento", () => {
  it("merge com conflito de código traz o arquivo de bead da outra branch", SLOW, () => {
    const s = withBeadA();
    s.write("codigo.txt", "base\n");
    commitAll(s, "código base");
    s.git("checkout", "-q", "-b", "feat");
    s.write("codigo.txt", "da feat\n");
    s.write(".beads/tasks/api-q/feat.yaml", definition("Q", T(2)));
    commitAll(s, "feat");
    s.git("checkout", "-q", "main");
    s.write("codigo.txt", "da main\n");
    commitAll(s, "main");
    expect(s.gitTry("merge", "feat").status).not.toBe(0);
    s.write("codigo.txt", "resolvido\n");
    const r = commitTry(s, "merge resolvido");
    expect(r.status, r.out).toBe(0);
    expect(liveIds(s)).toContain("api-q");
  });
});

describe("B8 — HEAD destacado", () => {
  it("o checkout gera a visão; commit de bead é recusado", SLOW, () => {
    const s = withBeadA();
    s.write(".beads/tasks/api-b/main.yaml", definition("B", T(2)));
    commitAll(s, "bead B");
    s.git("checkout", "-q", "--detach", "HEAD~1");
    expect(liveIds(s)).toEqual(["api-a"]);
    s.write(".beads/tasks/api-c/HEAD.yaml", definition("C", T(3)));
    const r = commitTry(s, "destacado");
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/HEAD destacado/);
  });
});

describe("B9 — regeneração nos hooks", () => {
  it("troca de branch, commit, merge, pull fast-forward e rebase", SLOW, () => {
    const s = withBeadA();
    s.git("checkout", "-q", "-b", "feat");
    s.write(".beads/tasks/ui-b/feat.yaml", definition("B", T(2)));
    commitAll(s, "b");
    expect(liveIds(s)).toEqual(["api-a", "ui-b"]); // post-commit
    s.git("checkout", "-q", "main");
    expect(liveIds(s)).toEqual(["api-a"]); // post-checkout
    s.git("merge", "--no-edit", "-q", "feat");
    expect(liveIds(s)).toEqual(["api-a", "ui-b"]); // post-merge

    const clone = kit.sibling(s, "clone");
    s.git("clone", "-q", "-c", "core.hooksPath=aiteam/githooks", s.dir, clone);
    const inClone = (...a: string[]) => s.git("-C", clone, ...a);
    const cloneView = () =>
      (load(fs.readFileSync(path.join(clone, ".beads", "active.yaml"), "utf8")) as any).tasks.map((t: any) => t.id);
    expect(cloneView()).toEqual(["api-a", "ui-b"]); // post-checkout do clone
    s.write(".beads/tasks/api-c/main.yaml", definition("C", T(3)));
    commitAll(s, "c");
    inClone("pull", "-q", "--ff-only");
    expect(cloneView()).toEqual(["api-a", "ui-b", "api-c"]); // post-merge do pull

    s.git("checkout", "-q", "-b", "rebase-me", "HEAD~1");
    s.write(".beads/tasks/api-d/rebase-me.yaml", definition("D", T(4)));
    commitAll(s, "d");
    s.git("rebase", "-q", "main");
    expect(liveIds(s)).toEqual(["api-a", "ui-b", "api-c", "api-d"]); // post-rewrite
    expect(s.git("status", "--porcelain").trim()).toBe("");
  });
});

describe("B10 — sem node", () => {
  it("aviso alto, e a regra de dono (bash) continua recusando", SLOW, () => {
    const s = withBeadA();
    const semNode = { ...s.env, BEADS_NODE: path.join(s.dir, "nao-existe", "node") };
    const run = (...a: string[]) => {
      const r = spawnSync("git", a, { cwd: s.dir, env: semNode, encoding: "utf8" });
      return { status: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
    };
    const co = run("checkout", "-b", "feat");
    expect(co.out).toMatch(/node não encontrado/);

    s.write(".beads/tasks/api-a/main.yaml", `${BEAD_A}${entry(T(2), { status: "blocked" })}`);
    s.git("add", "-A");
    const outra = run("commit", "-q", "-m", "outra branch");
    expect(outra.status).not.toBe(0);
    expect(outra.out).toMatch(/é da branch "main"/);

    s.git("checkout", "-q", "HEAD", "--", ".beads/tasks/api-a/main.yaml");
    s.write(".beads/tasks/api-a/feat.yaml", `entries:\n${entry(T(2), { status: "blocked" })}`);
    s.git("add", "-A");
    const propria = run("commit", "-q", "-m", "própria");
    expect(propria.status, propria.out).toBe(0);
    expect(propria.out).toMatch(/node não encontrado/);
  });
});
