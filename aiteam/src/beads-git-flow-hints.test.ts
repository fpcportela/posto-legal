import { describe, expect, it } from "vitest";
import { load } from "js-yaml";
import { GITIGNORE } from "./beads-migrate.mjs";
import { SLOW, T, useFlowSandboxes, type Sandbox } from "./beads-sandbox.js";

// Fluxo git de verdade (ver beads-git-flow.test.ts): as MENSAGENS e as dicas das recusas do
// modelo antigo (aiteam/docs/beads-schema.md §11) — o porte por arquivo, o teto de ids, a fonte
// com nó malformado, o espelho ilegível. O comportamento (o que é recusado) é provado nos
// beads-git-flow-mergedefault, -residue e -pick; aqui, que a recusa diz o que fazer e que o que
// ela manda fazer funciona.

const kit = useFlowSandboxes(GITIGNORE);

const node = (id: string, status: string, at: string) =>
  `  - id: "${id}"\n    title: "${id}"\n    status: "${status}"\n    created_at: "${T(1)}"\n    updated_at: "${at}"\n`;
const legacy = (tasks: string) => `version: "1.0"\nbranch: "main"\nlast_updated: "${T(1)}"\ntasks:\n${tasks}`;
const BASE = legacy(node("api-velha", "pending", T(1)));
const OLD_BRANCH = legacy(`${node("api-velha", "in_progress", T(2))}${node("api-da-velha", "pending", T(2))}`);

const liveIds = (s: Sandbox) => (load(s.read(".beads/active.yaml")) as any).tasks.map((t: any) => t.id);

/** main no modelo antigo → branch `velha` (com os arquivos dados) → main migra → de volta em `velha`. */
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

function dropOldModel(s: Sandbox, files: string[]): void {
  s.git("rm", "-q", "--cached", "--", ...files);
  for (const f of files) s.remove(f);
}

// A6: o --port-from HEAD --recover-mirrors lê TODOS os espelhos do commit — num repo real, ele
// criava 32 beads onde o --port do arquivo criava 1. A dica principal é o porte arquivo a
// arquivo, e ele lê do commit (<rev>:<arquivo>): vale com o arquivo já apagado do disco.
describe("C6 — a dica de porte é por arquivo", () => {
  it("o --port HEAD:<arquivo> da recusa traz só o que o arquivo tem, com o arquivo já apagado — sem os espelhos de outras branches", SLOW, () => {
    const s = legacyBranchBehindMigratedMain({
      ".beads/velha.yaml": OLD_BRANCH,
      // O espelho de uma terceira branch, que veio num merge antigo e continua rastreado.
      ".beads/outra.yaml": legacy(node("api-antigo", "pending", T(1))),
    });
    const m = s.gitTry("merge", "--no-edit", "main");
    expect(m.status, m.out).toBe(0);
    dropOldModel(s, [".beads/velha.yaml"]);

    const lost = s.gitTry("commit", "-q", "-m", "tira o espelho sem portar");
    expect(lost.status, lost.out).not.toBe(0);
    expect(lost.out).toMatch(/migrate-beads\.mjs --port HEAD:\.beads\/velha\.yaml/);
    // O --recover-mirrors fica como alternativa, com o aviso do que ele traz a mais.
    expect(lost.out).toMatch(/--port-from HEAD --recover-mirrors/);
    expect(lost.out).toMatch(/também o que só existe nos espelhos de outras branches/);
    // Descartar de propósito só tem o --no-verify, e ele pula também o secret scan e o drift.
    expect(lost.out).toMatch(/--no-verify.*secret scan.*drift das personas/);

    const port = s.node("scripts/migrate-beads.mjs", ["--port", "HEAD:.beads/velha.yaml"]);
    expect(port.status, port.out).toBe(0);
    expect(port.out).toMatch(/1 criado\(s\), 1 com entrada nova/);
    const ok = s.gitTry("commit", "-q", "-m", "tira o espelho depois do porte");
    expect(ok.status, ok.out).toBe(0);
    expect(liveIds(s).sort()).toEqual(["api-da-velha", "api-velha"]);
    expect(liveIds(s)).not.toContain("api-antigo");
  });

  it("o --port <rev>:<arquivo> que não existe no commit recusa com a causa, sem escrever nada", SLOW, () => {
    const s = legacyBranchBehindMigratedMain({ ".beads/velha.yaml": OLD_BRANCH });
    const r = s.node("scripts/migrate-beads.mjs", ["--port", "HEAD:.beads/nao-existe.yaml"]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/\.beads\/nao-existe\.yaml não existe em HEAD/);
    expect(s.git("status", "--porcelain").trim()).toBe("");
  });

  it("no merge de uma branch antiga na default, a dica também é por arquivo, do MERGE_HEAD", SLOW, () => {
    const s = legacyBranchBehindMigratedMain({ ".beads/active.yaml": OLD_BRANCH, ".beads/velha.yaml": OLD_BRANCH });
    s.git("checkout", "-q", "main");
    expect(s.gitTry("merge", "velha").status).not.toBe(0);
    dropOldModel(s, [".beads/active.yaml", ".beads/velha.yaml"]);

    const lost = s.gitTry("commit", "-q", "-m", "merge que perde o bead");
    expect(lost.status, lost.out).not.toBe(0);
    expect(lost.out).toMatch(/migrate-beads\.mjs --port MERGE_HEAD:\.beads\/active\.yaml/);
    expect(lost.out).toMatch(/migrate-beads\.mjs --port MERGE_HEAD:\.beads\/velha\.yaml/);
    expect(lost.out).toMatch(/--port-from MERGE_HEAD/);
    expect(lost.out).toMatch(/--no-verify.*secret scan.*drift das personas/);

    for (const f of [".beads/active.yaml", ".beads/velha.yaml"]) {
      const port = s.node("scripts/migrate-beads.mjs", ["--port", `MERGE_HEAD:${f}`]);
      expect(port.status, port.out).toBe(0);
    }
    const ok = s.gitTry("commit", "-q", "-m", "merge com o bead portado");
    expect(ok.status, ok.out).toBe(0);
    expect(liveIds(s).sort()).toEqual(["api-da-velha", "api-velha"]);
  });
});

// A7: a recusa listava todos os ids sem teto (8 KB numa linha num repo real).
describe("C7 — a lista de ids da recusa tem teto", () => {
  const many = (n: number) =>
    legacy(Array.from({ length: n }, (_, i) => node(`api-n${String(i + 1).padStart(2, "0")}`, "pending", T(2))).join(""));

  it("HEAD: 13 beads que o resultado não reflete — lista 10 e acrescenta +3", SLOW, () => {
    const s = legacyBranchBehindMigratedMain({ ".beads/velha.yaml": many(13) });
    const m = s.gitTry("merge", "--no-edit", "main");
    expect(m.status, m.out).toBe(0);
    dropOldModel(s, [".beads/velha.yaml"]);

    const lost = s.gitTry("commit", "-q", "-m", "tira o espelho sem portar");
    expect(lost.status, lost.out).not.toBe(0);
    expect(lost.out).toMatch(/sem portar 13 bead\(s\)/);
    expect(lost.out).toMatch(/api-n01, api-n02, /);
    expect(lost.out).toMatch(/api-n10, … \+3 —/);
    expect(lost.out).not.toMatch(/api-n11|api-n13/);
  });

  it("MERGE_HEAD: 12 beads — lista 10 e acrescenta +2", SLOW, () => {
    const s = legacyBranchBehindMigratedMain({ ".beads/velha.yaml": many(12) });
    s.git("checkout", "-q", "main");
    const m = s.gitTry("merge", "--no-commit", "--no-ff", "velha");
    expect(m.status, m.out).toBe(0);
    dropOldModel(s, [".beads/velha.yaml"]);

    const lost = s.gitTry("commit", "-q", "-m", "merge que perde os beads");
    expect(lost.status, lost.out).not.toBe(0);
    expect(lost.out).toMatch(/traz 12 bead\(s\)/);
    expect(lost.out).toMatch(/api-n10, … \+2 —/);
    expect(lost.out).not.toMatch(/api-n11|api-n12/);
  });
});

// A8: o espelho ilegível mais comum é a chave duplicada que o merge=union do driver antigo
// deixou no arquivo — a mensagem tem de dizer isso, e não só "YAML inválido".
describe("C9 — a mensagem do espelho ilegível cita a chave duplicada do merge=union", () => {
  const DUP = `version: "1.0"\nbranch: "velha"\nbranch: "velha"\nlast_updated: "${T(1)}"\ntasks:\n${node("api-da-velha", "pending", T(2))}`;

  it("HEAD: espelho com chave duplicada que sairia do índice", SLOW, () => {
    const s = legacyBranchBehindMigratedMain({ ".beads/velha.yaml": DUP });
    const m = s.gitTry("merge", "--no-edit", "main");
    expect(m.status, m.out).toBe(0);
    dropOldModel(s, [".beads/velha.yaml"]);

    const lost = s.gitTry("commit", "-q", "-m", "tira o espelho ilegível");
    expect(lost.status, lost.out).not.toBe(0);
    expect(lost.out).toMatch(/está ilegível/);
    expect(lost.out).toMatch(/chave duplicada que o merge=union do driver antigo deixou no arquivo/);
  });

  it("MERGE_HEAD: o mesmo, no espelho da branch mergeada", SLOW, () => {
    const s = legacyBranchBehindMigratedMain({ ".beads/velha.yaml": DUP });
    s.git("checkout", "-q", "main");
    const m = s.gitTry("merge", "--no-commit", "--no-ff", "velha");
    expect(m.status, m.out).toBe(0);
    dropOldModel(s, [".beads/velha.yaml"]);

    const lost = s.gitTry("commit", "-q", "-m", "merge que perde o espelho ilegível");
    expect(lost.status, lost.out).not.toBe(0);
    expect(lost.out).toMatch(/o espelho da branch mergeada \(MERGE_HEAD\) está ilegível/);
    expect(lost.out).toMatch(/chave duplicada que o merge=union do driver antigo deixou no arquivo/);
  });
});

// A4: um nó sem id numa fonte legada desligava a conferência inteira (virava só aviso), e com
// ele o bead válido ao lado se perdia calado. Os nós válidos são conferidos mesmo assim — e o
// porte também os leva (o --port e o --port-from não abortam por um nó sem id).
describe("C8 — um nó malformado não desliga a conferência dos nós válidos", () => {
  const NO_ID = `${OLD_BRANCH}  - title: "sem id"\n    status: "pending"\n`;

  // O cenário do QA (X1): o active.yaml da branch antiga tem um nó sem id ao lado de um bead válido.
  function conflictWithNoIdNode(): Sandbox {
    const s = legacyBranchBehindMigratedMain({ ".beads/active.yaml": NO_ID });
    expect(s.gitTry("merge", "main").status).not.toBe(0); // modify/delete do active.yaml
    dropOldModel(s, [".beads/active.yaml"]);
    return s;
  }

  it("nó sem id ao lado de um bead válido: o válido é recusado; o porte o leva e só avisa do nó", SLOW, () => {
    const s = conflictWithNoIdNode();
    const lost = s.gitTry("commit", "-q", "-m", "merge que perde o bead");
    expect(lost.status, lost.out).not.toBe(0);
    expect(lost.out).toMatch(/sem portar 2 bead\(s\) que o resultado não reflete: api-da-velha, api-velha/);
    expect(lost.out).toMatch(/ficaram de fora desta conta 1 item\(ns\) que não deu para ler \(.*nó sem id\)/);

    // O porte por arquivo não aborta por causa do nó sem id: leva os válidos e avisa.
    const port = s.node("scripts/migrate-beads.mjs", ["--port", "HEAD:.beads/active.yaml"]);
    expect(port.status, port.out).toBe(0);
    expect(port.out).toMatch(/⚠ --port: 1 nó\(s\) sem id — ficaram de fora/);
    expect(port.out).toMatch(/1 criado\(s\), 1 com entrada nova/);
    const ok = s.gitTry("commit", "-q", "-m", "merge com o bead portado");
    expect(ok.status, ok.out).toBe(0);
    // O nó malformado fica só como aviso: não trava o commit depois do porte.
    expect(ok.out).toMatch(/não consegui conferir todo o modelo antigo de HEAD \(.*nó sem id\)/);
    expect(liveIds(s).sort()).toEqual(["api-da-velha", "api-velha"]);
  });

  it("o --port-from também leva os nós válidos e avisa do sem id", SLOW, () => {
    const s = conflictWithNoIdNode();
    const port = s.node("scripts/migrate-beads.mjs", ["--port-from", "HEAD"]);
    expect(port.status, port.out).toBe(0);
    expect(port.out).toMatch(/⚠ .*nó sem id/);
    expect(port.out).toMatch(/1 criado\(s\), 1 com entrada nova/);
  });
});
