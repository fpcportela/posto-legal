import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { load } from "js-yaml";
import { viewIntegrity } from "./beads-core.mjs";
import { GITIGNORE } from "./beads-migrate.mjs";
import { clean, commitAll, commitTry, definition, entry, SLOW, T, useFlowSandboxes, type Sandbox } from "./beads-sandbox.js";

// Fluxo git de verdade (ver beads-git-flow.test.ts): B11–B15 — modo legado,
// a troca com uma branch do modelo antigo, visão editada à mão, a migração
// passando pelo pre-commit novo e CRLF. Contrato: aiteam/docs/beads-schema.md
// §7.4 e §11.

const kit = useFlowSandboxes(GITIGNORE);

const liveIds = (s: Sandbox) => (load(s.read(".beads/active.yaml")) as any).tasks.map((t: any) => t.id);
const index = (s: Sandbox) => load(s.read(".beads/index.yaml")) as any[];

const BEAD_A = `${definition("Bead A", T(1))}entries:\n${entry(T(1, 11), { status: "in_progress" })}`;
const LEGACY = `version: "1.0"\nbranch: "main"\nproject: ""\nlast_updated: "${T(1)}"\nsession:\n  active_spec_hash: ""\n  budget_usd: 2.00\n  cost_accumulated_usd: 0.00\ntasks:\n  - id: "api-velha"\n    title: "Velha"\n    status: "pending"\n    created_at: "${T(1)}"\n    updated_at: "${T(1)}"\n`;

// O estado legado já existe antes dos hooks novos (é o que um consumidor tem
// quando atualiza o aiteam): entra sem passar pelo pre-commit.
function legacyRepo(): Sandbox {
  const s = kit.repo({ legacy: true });
  s.write(".beads/active.yaml", LEGACY);
  s.write(".beads/main.yaml", LEGACY);
  s.git("add", "-A");
  s.git("commit", "-q", "--no-verify", "-m", "modelo antigo");
  return s;
}

// B11b — o modo legado se decide pelo HEAD, nunca só pelo índice: um agente
// que segue o protocolo novo num consumidor legado não pode desligá-lo, e um
// repo migrado não volta ao legado no mesmo commit.
describe("B11b — o modo legado não se liga nem se desliga pelo índice", () => {
  it("legado: commit de .beads/tasks é recusado e o active.yaml rastreado fica intacto", SLOW, () => {
    const s = legacyRepo();
    s.write(".beads/tasks/api-nova/main.yaml", definition("Nova pelo protocolo novo", T(2)));
    s.git("add", "-A");
    const r = s.gitTry("commit", "-q", "-m", "bead novo em repo legado");
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/modo legado/);
    expect(r.out).toMatch(/migrate-beads/);
    expect(s.read(".beads/active.yaml")).toBe(LEGACY);
    expect(s.git("log", "--oneline").trim().split("\n").length).toBe(2);
  });

  it("migrado: tirar as pastas do índice e forçar um active.yaml antigo é recusado", SLOW, () => {
    const s = kit.repo();
    s.write(".beads/tasks/api-a/main.yaml", BEAD_A);
    commitAll(s, "bead A");
    s.git("rm", "-r", "-q", "--cached", ".beads/tasks");
    s.write(".beads/active.yaml", LEGACY);
    s.git("add", "-f", ".beads/active.yaml");
    const r = s.gitTry("commit", "-q", "-m", "volta ao legado");
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/histórico não se apaga/);
    expect(r.out).toMatch(/active\.yaml fica fora do git/);
  });
});

describe("B11/B12 — modo legado e a troca com o modelo novo", () => {
  it("B11: nada muda, só aviso", SLOW, () => {
    const s = legacyRepo();
    s.write("codigo.txt", "x\n");
    s.git("add", "codigo.txt");
    const c = s.git("commit", "-m", "código");
    expect(c).toMatch(/modo legado/);
    expect(s.git("show", "--name-only", "--format=", "HEAD").trim()).toBe("codigo.txt");
    const co = s.git("checkout", "-b", "nova");
    expect(co).toMatch(/modo legado/);
    expect(s.read(".beads/active.yaml")).toBe(LEGACY);
    expect(s.exists(".beads/nova.yaml")).toBe(false);
    expect(s.exists(".beads/index.yaml")).toBe(false);
    expect(clean(s)).toBe("");
  });

  it("B12: main migrada ↔ branch antiga, nos dois sentidos, árvore limpa", SLOW, () => {
    const s = legacyRepo();
    s.git("branch", "velha");
    const m = s.node("scripts/migrate-beads.mjs");
    expect(m.status, m.out).toBe(0);
    const mc = s.gitTry("commit", "-q", "-m", "migra");
    expect(mc.status, mc.out).toBe(0);
    expect(liveIds(s)).toEqual(["api-velha"]);
    expect(clean(s)).toBe("");

    s.git("checkout", "-q", "velha");
    expect(s.read(".beads/active.yaml")).toBe(LEGACY);
    expect(clean(s)).toBe("");

    s.git("checkout", "-q", "main");
    expect(viewIntegrity(s.read(".beads/active.yaml"))).toBe("intact");
    expect(liveIds(s)).toEqual(["api-velha"]);
    expect(clean(s)).toBe("");
  });
});

describe("B13 — visão editada à mão", () => {
  it("backup, aviso e bloqueio do commit até o backup sair", SLOW, () => {
    const s = kit.repo();
    s.write(".beads/tasks/api-a/main.yaml", BEAD_A);
    commitAll(s, "bead A");
    const edited = s.read(".beads/active.yaml").replace('"in_progress"', '"completed"');
    s.write(".beads/active.yaml", edited);
    s.write("codigo.txt", "1\n");
    const first = commitTry(s, "código 1");
    expect(first.status).toBe(0);
    expect(first.out).toMatch(/edição à mão — guardada em \.beads\/active\.yaml\.editado-/);
    const backup = ".beads/active.yaml.editado-20261009T120000Z";
    expect(s.read(backup)).toBe(edited);
    expect(clean(s)).toBe(""); // o backup é ignorado pelo git

    s.write("codigo.txt", "2\n");
    const blocked = commitTry(s, "código 2");
    expect(blocked.status).not.toBe(0);
    expect(blocked.out).toMatch(/visão editada à mão/);

    s.remove(backup);
    expect(commitTry(s, "código 2").status).toBe(0);
  });
});

describe("B14 — migração de ponta a ponta com os hooks novos", () => {
  it("o commit da migração passa no pre-commit do modelo novo e a árvore fica limpa", SLOW, () => {
    const s = kit.repo({ legacy: true });
    const here = path.dirname(fileURLToPath(import.meta.url));
    const fx = (rel: string) => fs.readFileSync(path.join(here, "__fixtures__", "beads-legacy", ...rel.split("/")), "utf8");
    for (const rel of ["active.yaml", "archive/completed.yaml", "archive/index.yaml", "main.yaml", "feat-a.yaml", "feat-b.yaml", "feat-quebrado.yaml", "cost-log.json"]) {
      s.write(`.beads/${rel}`, fx(rel));
    }
    s.git("add", "-A");
    s.git("commit", "-q", "--no-verify", "-m", "modelo antigo");
    const m = s.node("scripts/migrate-beads.mjs", ["--recover-mirrors"]);
    expect(m.status, m.out).toBe(0);
    expect(m.out).toMatch(/únicos 8 → pastas 8 ✓/);
    const c = s.gitTry("commit", "-q", "-m", "migra");
    expect(c.status, c.out).toBe(0);
    expect(s.git("ls-files", ".beads").trim().split("\n").filter((p) => !p.startsWith(".beads/tasks/"))).toEqual([
      ".beads/.gitignore",
      ".beads/project/main.yaml",
    ]);
    expect(liveIds(s)).toEqual(["api-duplicada", "qa-pendente", "api-em-andamento"]);
    expect(index(s).length).toBe(8);
    expect(s.exists(".beads/cost-log.json")).toBe(true);
    expect(clean(s)).toBe("");
  });
});

describe("B15 — bead com CRLF na árvore", () => {
  it("checkout em CRLF, acréscimo em CRLF: o commit passa e a visão confere", SLOW, () => {
    const s = kit.repo({ autocrlf: true });
    s.write(".beads/tasks/api-a/main.yaml", BEAD_A);
    commitAll(s, "bead A");
    s.remove(".beads/tasks/api-a/main.yaml");
    s.git("checkout", "--", ".beads/tasks/api-a/main.yaml");
    const crlf = s.read(".beads/tasks/api-a/main.yaml");
    expect(crlf).toContain("\r\n");
    expect(clean(s)).toBe("");

    s.write(".beads/tasks/api-a/main.yaml", `${crlf}${entry(T(2), { status: "completed" }).replace(/\n/g, "\r\n")}`);
    const r = commitTry(s, "conclui em CRLF");
    expect(r.status, r.out).toBe(0);
    expect(index(s).find((e) => e.id === "api-a").status).toBe("completed");
    expect(viewIntegrity(s.read(".beads/index.yaml"))).toBe("intact");
    expect(clean(s)).toBe("");
  });
});
