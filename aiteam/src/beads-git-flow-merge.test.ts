import { describe, expect, it } from "vitest";
import { GITIGNORE } from "./beads-migrate.mjs";
import { commitAll, commitTry, definition, entry, SLOW, T, useFlowSandboxes, type Sandbox } from "./beads-sandbox.js";

// Fluxo git de verdade (ver beads-git-flow.test.ts): B7 negativo — a isenção
// de merge e squash cobre só a regra de dono (aiteam/docs/beads-schema.md §8).
// Arquivo próprio para rodar em paralelo com os outros cenários.

const kit = useFlowSandboxes(GITIGNORE);

const BEAD_A = `${definition("Bead A", T(1))}entries:\n${entry(T(1, 11), { status: "in_progress" })}`;

function withBeadA(): Sandbox {
  const s = kit.repo();
  s.write(".beads/tasks/api-a/main.yaml", BEAD_A);
  commitAll(s, "bead A");
  return s;
}

// A isenção de merge/squash cobre só a regra de DONO (§8): o resto — recusa
// de apagar bead, acréscimo só no fim, as entradas do outro lado — continua.
describe("B7 — a isenção de merge não vira porta aberta", () => {
  it("squash com add/add resolvido pelo lado que perde a entrada T3 é recusado", SLOW, () => {
    const s = kit.repo();
    s.git("checkout", "-q", "-b", "x");
    s.write(".beads/tasks/api-z/feat.yaml", `${definition("Z", T(1))}entries:\n${entry(T(2), { status: "in_progress" })}`);
    s.git("add", "-A");
    s.git("commit", "-q", "--no-verify", "-m", "x: Z até T2");
    s.git("checkout", "-q", "main");
    s.write(".beads/tasks/api-z/feat.yaml", `${definition("Z", T(1))}entries:\n${entry(T(2), { status: "in_progress" })}${entry(T(3), { status: "completed" })}`);
    s.git("add", "-A");
    s.git("commit", "-q", "--no-verify", "-m", "main: Z até T3");
    expect(s.gitTry("merge", "--squash", "x").status).not.toBe(0);
    s.git("checkout", "--theirs", "--", ".beads/tasks/api-z/feat.yaml");
    s.git("add", "-A");
    const r = s.gitTry("commit", "-q", "-m", "squash que perde T3");
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/só cresce no fim/);
  });

  it("merge com conflito: git rm de arquivo de bead é recusado", SLOW, () => {
    const s = withBeadA();
    s.write("codigo.txt", "base\n");
    commitAll(s, "base");
    s.git("checkout", "-q", "-b", "feat");
    s.write("codigo.txt", "feat\n");
    commitAll(s, "feat");
    s.git("checkout", "-q", "main");
    s.write("codigo.txt", "main\n");
    commitAll(s, "main");
    expect(s.gitTry("merge", "feat").status).not.toBe(0);
    s.write("codigo.txt", "resolvido\n");
    s.git("add", "codigo.txt");
    s.git("rm", "-q", ".beads/tasks/api-a/main.yaml");
    const r = s.gitTry("commit", "-q", "-m", "merge que apaga bead");
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/histórico não se apaga/);
  });

  it("merge que fica só com um lado perde as entradas do outro: recusado; com as duas, passa", SLOW, () => {
    const s = withBeadA();
    s.git("checkout", "-q", "-b", "outro-clone");
    s.write(".beads/tasks/api-a/main.yaml", `${BEAD_A}${entry(T(3), { status: "blocked" })}`);
    s.git("add", "-A");
    s.git("commit", "-q", "--no-verify", "-m", "outro clone da main acrescenta T3");
    s.git("checkout", "-q", "main");
    s.write(".beads/tasks/api-a/main.yaml", `${BEAD_A}${entry(T(2), { status: "completed" })}`);
    commitAll(s, "main acrescenta T2");
    expect(s.gitTry("merge", "outro-clone").status).not.toBe(0);
    s.git("checkout", "--ours", "--", ".beads/tasks/api-a/main.yaml");
    s.git("add", "-A");
    const ours = s.gitTry("commit", "-q", "-m", "fica com a nossa");
    expect(ours.status).not.toBe(0);
    expect(ours.out).toMatch(/perdeu entradas da outra branch/);

    s.write(".beads/tasks/api-a/main.yaml", `${BEAD_A}${entry(T(2), { status: "completed" })}${entry(T(3), { status: "blocked" })}`);
    s.git("add", "-A");
    const both = s.gitTry("commit", "-q", "-m", "as duas");
    expect(both.status, both.out).toBe(0);
  });

  it("SQUASH_MSG velho não libera editar o meio nem apagar", SLOW, () => {
    const s = withBeadA();
    s.git("checkout", "-q", "-b", "feat");
    s.write(".git/SQUASH_MSG", "squash esquecido\n");
    s.write(".beads/tasks/api-a/main.yaml", BEAD_A.replace('"in_progress"', '"completed"'));
    const meio = commitTry(s, "edita o meio com SQUASH_MSG velho");
    expect(meio.status).not.toBe(0);
    expect(meio.out).toMatch(/só cresce no fim/);
  });

  it("MERGE_HEAD forjado (= HEAD ou lixo) não isenta a regra de dono", SLOW, () => {
    const s = withBeadA();
    s.git("checkout", "-q", "-b", "feat");
    s.write(".beads/tasks/api-a/main.yaml", `${BEAD_A}${entry(T(2), { status: "blocked" })}`);
    s.write(".git/MERGE_HEAD", `${s.git("rev-parse", "HEAD").trim()}\n`);
    const same = commitTry(s, "MERGE_HEAD = HEAD");
    expect(same.status).not.toBe(0);
    expect(same.out).toMatch(/é da branch "main"/);
    s.write(".git/MERGE_HEAD", "lixo\n");
    const junk = commitTry(s, "MERGE_HEAD lixo");
    expect(junk.status).not.toBe(0);
    expect(junk.out).toMatch(/é da branch "main"/);
  });
});

