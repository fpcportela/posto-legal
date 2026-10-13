import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { aggregate } from "./beads-aggregate.mjs";
import { GITIGNORE } from "./beads-migrate.mjs";
import { definition, entry, fastImport, SLOW, T, useFlowSandboxes } from "./beads-sandbox.js";

// G9 — desempenho da agregação (fase 2 da #37). Arquivo próprio: monta um repo
// grande e roda em paralelo com os outros. Contrato: aiteam/docs/beads-schema.md §13.

const kit = useFlowSandboxes(GITIGNORE);
const treeFile = (bead: string, file: string) => `.beads/tasks/${bead}/${file}.yaml`;
const addendum = (at: string, fields: Record<string, string>) => `entries:\n${entry(at, fields)}`;

// A-R1: o que a HEAD mudou desde o fork não pode custar leitura. Os refs são
// bifurcados e a main anda (beads novos, entradas novas, beads apagados); só o
// que cada ref mudou é lido. O orçamento é de blobs, não de tempo: determinístico
// em qualquer máquina. Antes (diff entre as duas árvores) eram ~400 caminhos por
// ref — 16 mil nomes no cat-file.
describe("A-R1 — deriva da main desde o fork", () => {
  it("lê só o que os refs mudaram: no máximo 3× os caminhos tocados, e nada que a HEAD só apagou ou criou", SLOW, () => {
    const s = kit.repo();
    s.git("config", "core.hooksPath", ".git/hooks");
    const ids: string[] = [];
    const text = (i: number) => `${definition(`Bead ${i}`, T(1))}entries:\n${entry(T(1, 11), { status: "pending" })}`;
    for (let i = 0; i < 300; i++) {
      const id = `orch-b${String(i).padStart(3, "0")}`;
      ids.push(id);
      s.write(treeFile(id, "main"), text(i));
    }
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "300 beads");

    // 40 refs bifurcados aqui, cada um com um adendo num bead
    fastImport(
      s,
      Array.from({ length: 40 }, (_, n) => ({
        branch: `feat/d${n}`,
        files: { [treeFile(ids[n * 5]!, `feat-d${n}`)]: addendum(T(3), { status: "blocked", blockers: '["orch-b001"]' }) },
      }))
    );

    // a main anda: +300 beads novos, +100 entradas em beads antigos, 5 beads apagados
    for (let i = 300; i < 600; i++) s.write(treeFile(`orch-b${i}`, "main"), text(i));
    for (let i = 1; i < 200; i += 2) fs.appendFileSync(path.join(s.dir, treeFile(ids[i]!, "main")), entry(T(2), { note: "andou" }));
    for (const id of ids.slice(250, 255)) fs.rmSync(path.join(s.dir, ".beads", "tasks", id), { recursive: true });
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "a main anda");

    const r = aggregate(s.dir, { nowMs: Date.now() });
    expect(r.partial).toBe(false);
    expect(r.elsewhere).toHaveLength(40);
    expect(r.elsewhere.map((e) => e.id).sort()).toEqual(Array.from({ length: 40 }, (_, n) => ids[n * 5]!).sort());
    // nenhum bead apagado na HEAD "ressuscita" como novo, e a deriva não aparece
    expect(r.elsewhere.every((e) => e.aqui !== null)).toBe(true);
    expect(r.stats.refsRead).toBe(40);
    expect(r.stats.blobsRead).toBeGreaterThanOrEqual(40);
    expect(r.stats.blobsRead).toBeLessThanOrEqual(3 * 40);
  });

  // A-R1b: o ref que mesclou a main. O `git log -m` de um commit de merge lista tudo o que
  // a main mudou desde a última sincronização (a diferença contra o outro pai), e cada ref
  // virava centenas de caminhos: no repo do QA, 24.040 blobs e ~93 s. O `-c` (diff combinado)
  // lista só o que o merge mudou em relação a TODOS os pais — a resolução de conflito —,
  // e o que a main trouxe já está nos pais.
  it("A-R1b: cada ref mescla a main e a main anda de novo: o merge não custa o que a main trouxe", SLOW, () => {
    const s = kit.repo();
    s.git("config", "core.hooksPath", ".git/hooks");
    const ids: string[] = [];
    const text = (i: number) => `${definition(`Bead ${i}`, T(1))}entries:\n${entry(T(1, 11), { status: "pending" })}`;
    for (let i = 0; i < 300; i++) {
      const id = `orch-b${String(i).padStart(3, "0")}`;
      ids.push(id);
      s.write(treeFile(id, "main"), text(i));
    }
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "300 beads");
    const base = s.git("rev-parse", "HEAD").trim();

    // o que a main anda antes de os refs a mesclarem: +300 beads novos e +100 entradas
    for (let i = 300; i < 600; i++) s.write(treeFile(`orch-b${i}`, "main"), text(i));
    for (let i = 1; i < 200; i += 2) fs.appendFileSync(path.join(s.dir, treeFile(ids[i]!, "main")), entry(T(2), { note: "andou" }));
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "a main anda (1)");
    const mainA = s.git("rev-parse", "HEAD").trim();
    const changed = s.git("diff", "--name-only", base, mainA, "--", ".beads/tasks").split("\n").filter(Boolean);
    const blobOf = new Map<string, string>();
    for (const line of s.git("ls-tree", "-r", mainA, "--", ".beads/tasks").split("\n")) {
      const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
      if (m) blobOf.set(m[2]!, m[1]!);
    }
    expect(changed.length).toBeGreaterThan(300);

    // 40 refs bifurcados na base, cada um com um adendo, e um commit de merge com a mainA
    const now = Math.floor(Date.now() / 1000);
    let stream = "";
    for (let n = 0; n < 40; n++) {
      const add = addendum(T(3), { status: "blocked", blockers: '["orch-b001"]' });
      stream += `commit refs/heads/feat/m${n}\ncommitter q <q@x> ${now} +0000\ndata 3\nadd\nfrom ${base}\nM 100644 inline ${treeFile(ids[n * 5]!, `feat-m${n}`)}\ndata ${Buffer.byteLength(add)}\n${add}\n\n`;
      stream += `commit refs/heads/feat/m${n}\ncommitter q <q@x> ${now} +0000\ndata 5\nmerge\nmerge ${mainA}\n`;
      for (const p of changed) if (blobOf.has(p)) stream += `M 100644 ${blobOf.get(p)} ${p}\n`;
      stream += "\n";
    }
    const fi = spawnSync("git", ["fast-import", "--quiet"], { cwd: s.dir, env: s.env, input: stream, encoding: "utf8" });
    expect(fi.status, fi.stderr).toBe(0);

    // e a main anda de novo, depois do merge
    for (let i = 600; i < 900; i++) s.write(treeFile(`orch-b${i}`, "main"), text(i));
    for (let i = 2; i < 200; i += 2) fs.appendFileSync(path.join(s.dir, treeFile(ids[i]!, "main")), entry(T(2), { note: "andou de novo" }));
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "a main anda (2)");

    const r = aggregate(s.dir, { nowMs: Date.now() });
    expect(r.partial).toBe(false);
    expect(r.elsewhere).toHaveLength(40);
    expect(r.stats.refsRead).toBe(40);
    expect(r.stats.blobsRead).toBeGreaterThanOrEqual(40);
    expect(r.stats.blobsRead).toBeLessThanOrEqual(3 * 40);
  });

  it("a deriva no meio do bead apagado: o ref que não tocou nele não o traz de volta", SLOW, () => {
    const s = kit.repo();
    s.git("config", "core.hooksPath", ".git/hooks");
    s.write(treeFile("orch-velho", "main"), `${definition("Velho", T(1))}entries:\n${entry(T(1, 11), { status: "in_progress" })}`);
    s.write(treeFile("api-a", "main"), `${definition("A", T(1))}entries:\n${entry(T(1, 11), { status: "pending" })}`);
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "base");
    fastImport(s, [{ branch: "feat/z", files: { [treeFile("api-a", "feat-z")]: addendum(T(3), { status: "blocked" }) } }]);
    fs.rmSync(path.join(s.dir, ".beads", "tasks", "orch-velho"), { recursive: true });
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "apaga orch-velho");
    const r = aggregate(s.dir, { nowMs: Date.now() });
    expect(r.elsewhere.map((e) => e.id)).toEqual(["api-a"]);
    expect(r.stats.blobsRead).toBe(1);
  });
});

describe("G9 — desempenho", () => {
  // 600 beads, 40 refs e 3 worktrees (com mudança não commitada). O limite do
  // plano: < 3 s no Windows, < 1,5 s na CI Linux.
  it("600 beads, 40 refs e 3 worktrees em menos de 3 s (Windows) ou 1,5 s (Linux)", SLOW, () => {
    const s = kit.repo();
    s.git("config", "core.hooksPath", ".git/hooks"); // sem hooks: o assunto é a leitura
    const ids: string[] = [];
    for (let i = 0; i < 600; i++) {
      const id = `orch-b${String(i).padStart(3, "0")}`;
      ids.push(id);
      s.write(
        treeFile(id, "main"),
        `${definition(`Bead ${i}`, T(1))}entries:\n${entry(T(1, 11), { status: i % 3 === 0 ? "in_progress" : "pending", stage: "implement" })}`
      );
    }
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "600 beads");

    fastImport(
      s,
      Array.from({ length: 40 }, (_, n) => ({
        branch: `feat/p${n}`,
        files: { [treeFile(ids[n * 3]!, `feat-p${n}`)]: addendum(T(3), { status: "blocked", blockers: '["orch-b001"]' }) },
      }))
    );
    for (let n = 0; n < 3; n++) {
      const wt = kit.sibling(s, `wt${n}`);
      s.git("worktree", "add", "-q", wt, `feat/p${n}`);
      fs.appendFileSync(path.join(wt, treeFile(ids[n * 3]!, `feat-p${n}`)), entry(T(4), { status: "completed", context_summary: "ok" }));
    }

    // O menor de 3 rodadas (a primeira esquenta o cache de arquivos) contra o
    // limite do plano. Com a máquina carregada (a suíte inteira roda vários
    // arquivos de git em paralelo) o custo de subir um processo sobe junto, e um
    // limite absoluto vira ruído: vale também o limite relativo de 30 chamadas
    // de git, medidas aqui mesmo. A agregação gasta ~12 processos; uma
    // regressão para um processo por ref passa de 50 e estoura os dois limites.
    const gitCall = () => {
      const t = performance.now();
      spawnSync("git", ["rev-parse", "HEAD"], { cwd: s.dir, windowsHide: true });
      return performance.now() - t;
    };
    const calls = Array.from({ length: 5 }, gitCall).sort((a, b) => a - b);
    const perCall = calls[2]!; // a mediana

    let best = Infinity;
    let last: ReturnType<typeof aggregate> | undefined;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      last = aggregate(s.dir, { nowMs: Date.now() });
      best = Math.min(best, performance.now() - t0);
    }
    const r = last!;
    const absolute = process.platform === "win32" ? 3000 : 1500;
    console.info(
      `[G9] 600 beads, ${r.stats.refsListed} refs, ${r.stats.worktrees} worktrees: ${best.toFixed(0)} ms (limite ${absolute} ms ou 30 × ${perCall.toFixed(0)} ms por chamada de git)`
    );
    expect(r.partial).toBe(false);
    expect(r.stats.refsRead).toBe(40);
    expect(r.elsewhere).toHaveLength(40);
    expect(r.elsewhere.filter((e) => e.la.status === "completed")).toHaveLength(3);
    expect(best).toBeLessThan(Math.max(absolute, 30 * perCall));
  });
});
