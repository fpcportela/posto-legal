import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { load } from "js-yaml";
import { buildState, combineBead } from "./beads-core.mjs";
import { formatReport, legacyInstant, planMigration, planPort, type LegacySources } from "./beads-migrate.mjs";
import { definition, entry, makeSandbox, type Sandbox } from "./beads-sandbox.js";

// Migração do modelo antigo (active.yaml + espelhos + archive/) para o modelo
// por bead — aiteam/docs/beads-schema.md §11. A fixture imita os defeitos reais:
// nó só em espelho (presos pelo archive pulado), nó fora do índice (#30), linha
// de índice sem nó, o mesmo id vivo e arquivado, espelho ilegível.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "__fixtures__", "beads-legacy");
const NOW = Date.parse("2026-10-05T12:00:00Z");
const fx = (rel: string) => readFileSync(path.join(FIXTURE, ...rel.split("/")), "utf8");

function fixtureSources(): LegacySources {
  return {
    active: fx("active.yaml"),
    completed: fx("archive/completed.yaml"),
    index: fx("archive/index.yaml"),
    mirrors: readdirSync(FIXTURE)
      .filter((n) => n.endsWith(".yaml") && n !== "active.yaml")
      .map((name) => ({ name, text: fx(name) })),
  };
}

// aiteam/docs/trello-review-adoption.md §3: o `trello` dos beads antigos (mesa-crm, robo) passou a
// ter formato validado, e é a migração que pega o valor malformado — nomeando o nó — antes de escrever.
describe("planMigration — o formato do campo trello (issue 28)", () => {
  const sourcesWith = (trello: string): LegacySources => ({
    active: `version: "1.0"\nproject: demo\ntasks:\n  - id: api-card\n    title: "Card"\n    status: pending\n    trello: ${trello}\n    created_at: "2026-10-01T10:00:00Z"\n    updated_at: "2026-10-02T10:00:00Z"\n`,
    completed: "",
    index: "",
    mirrors: [],
  });

  it("shortLink e lista de shortLinks migram sem erro", () => {
    for (const ok of ['"97e1Chex"', "97e1Chex", '["0nU0fBM1", "68wGTstW"]']) {
      expect(planMigration(sourcesWith(ok), { as: "chore-migra", nowMs: NOW }).errors, ok).toEqual([]);
    }
  });

  it("a URL, a lista com item vazio e o objeto do formato antigo bloqueiam, apontando o nó, e nada é planejado como válido", () => {
    for (const bad of ['"https://trello.com/c/97e1Chex"', '["0nU0fBM1", ""]', "{card: abc123}"]) {
      const { errors } = planMigration(sourcesWith(bad), { as: "chore-migra", nowMs: NOW });
      expect(errors.join("\n"), bad).toMatch(/trello .*\(nó de /);
    }
  });
});

describe("planMigration — contagem e relatório", () => {
  const plan = planMigration(fixtureSources(), { as: "chore-migra", nowMs: NOW });

  it("conta as fontes, inclusive o espelho ilegível, sem abortar por ele", () => {
    expect(plan.errors).toEqual([]);
    expect(plan.report.sources).toMatchObject({ active: 3, completed: 4, mirrors: 4 });
    expect(plan.report.sources.unreadableMirrors.map((m) => m.name)).toEqual(["feat-quebrado.yaml"]);
  });

  it("une por id: o mesmo id vivo e arquivado entra uma vez, com o updated_at maior", () => {
    expect(plan.report.unique).toBe(6);
    expect(plan.report.folders).toBe(6);
    expect(plan.report.duplicates).toEqual([
      expect.objectContaining({ id: "api-duplicada", kept: "active.yaml", dropped: "archive/completed.yaml" }),
    ]);
    const dup = plan.files.find((f) => f.path === ".beads/tasks/api-duplicada/chore-migra.yaml")!;
    expect(dup.text).toMatch(/Versão viva/);
  });

  it("lista as divergências do índice antigo (#30)", () => {
    expect(plan.report.outsideIndex).toEqual(["orch-fora-do-indice"]);
    expect(plan.report.indexOrphans).toEqual(["orch-so-no-indice"]);
  });

  it("lista o que só existe em espelho, com origem, status e data — e deixa de fora sem a flag", () => {
    expect(plan.report.mirrorOnly).toEqual([
      { id: "docs-outra-so-no-espelho", origin: "feat-b.yaml", status: "completed", date: "2026-09-04", alsoIn: [] },
      { id: "release-so-no-espelho", origin: "feat-a.yaml", status: "completed", date: "2026-09-10", alsoIn: ["feat-b.yaml"] },
    ]);
    expect(plan.files.map((f) => f.path)).not.toContain(".beads/tasks/release-so-no-espelho/chore-migra.yaml");
    expect(plan.report.withMirrors).toBe(8);
  });

  it("o relatório em texto traz as linhas da §11", () => {
    const text = formatReport(plan.report).join("\n");
    expect(text).toMatch(/fontes: active 3 · completed 4 · espelhos 4 arquivos \(1 ilegível: feat-quebrado\.yaml\)/);
    expect(text).toMatch(/únicos 6 → pastas 6 ✓ {2}\(8 com --recover-mirrors\)/);
    expect(text).toMatch(/FORA do índice antigo \(#30\): orch-fora-do-indice/);
    expect(text).toMatch(/no índice sem nó no completed\.yaml: orch-so-no-indice/);
    expect(text).toMatch(/só em espelhos: 2/);
    expect(text).toMatch(/release-so-no-espelho · feat-a\.yaml · completed · 2026-09-10 \(também em feat-b\.yaml\)/);
  });
});

describe("planMigration --recover-mirrors", () => {
  const plan = planMigration(fixtureSources(), { as: "chore-migra", recoverMirrors: true, nowMs: NOW });

  it("os ids só de espelho entram; no mesmo id em dois espelhos vence o updated_at maior", () => {
    expect(plan.errors).toEqual([]);
    expect(plan.report.unique).toBe(8);
    expect(plan.report.folders).toBe(8);
    const rec = plan.files.find((f) => f.path === ".beads/tasks/release-so-no-espelho/chore-migra.yaml")!;
    expect(rec.text).toMatch(/versão nova/);
    expect(formatReport(plan.report).join("\n")).toMatch(/com --recover-mirrors: 2 recuperado/);
  });
});

describe("planMigration — o arquivo gerado", () => {
  const plan = planMigration(fixtureSources(), { as: "chore-migra", nowMs: NOW });
  const fileOf = (id: string) => plan.files.find((f) => f.path === `.beads/tasks/${id}/chore-migra.yaml`)!.text;

  it("definição no topo e uma entrada com o estado; a combinação devolve o nó antigo", () => {
    const text = fileOf("infra-arquivada-a");
    const doc = load(text) as any;
    expect(Object.keys(doc).at(-1)).toBe("entries");
    expect(doc.created_at).toBe("2026-07-10T22:50:00Z");
    expect(doc.entries).toEqual([
      { at: "2026-07-10T23:10:00Z", status: "completed", context_summary: "Entregue com testes. Segunda frase do resumo." },
    ]);
    const r = combineBead("infra-arquivada-a", [{ branchFile: "chore-migra", text }], { nowMs: NOW });
    expect(r.errors).toEqual([]);
    expect(r.bead).toMatchObject({ status: "completed", created_at: "2026-07-10T22:50:00Z", updated_at: "2026-07-10T23:10:00Z" });
    expect(r.bead!.fields).toMatchObject({
      title: "Primeira arquivada: com dois-pontos",
      description: "Texto dobrado em várias linhas que o YAML junta numa linha só, como os nós reais do completed.yaml",
      effort: "S",
      impl_model: "sonnet",
      tags: ["beads"],
      related_files: ["aiteam/src/a.ts"],
    });
  });

  it("preserva campo desconhecido, phase e blockers; timestamp sem aspas e com milissegundos", () => {
    const r = combineBead("api-em-andamento", [{ branchFile: "chore-migra", text: fileOf("api-em-andamento") }], { nowMs: NOW });
    expect(r.bead!.fields).toMatchObject({ trello: "abc123", squad: { nome: "plataforma" }, phase: "fase-1", blockers: ["qa-pendente"] });
    expect(r.bead!.updated_at).toBe("2026-10-04T11:00:00Z");
    const b = combineBead("spec-arquivada-b", [{ branchFile: "chore-migra", text: fileOf("spec-arquivada-b") }], { nowMs: NOW });
    expect(b.bead!.updated_at).toBe("2026-08-02T10:00:00.250Z");
  });

  it("phases e focus_note vão para .beads/project/<as>.yaml", () => {
    const project = plan.files.find((f) => f.path === ".beads/project/chore-migra.yaml")!;
    const doc = load(project.text) as any;
    expect(doc.focus_note).toBe("Fechar a migração antes do rollout.");
    expect(doc.phases).toEqual([{ key: "fase-1", name: "Fase 1 — modelo por bead", subtitle: "este repo" }]);
  });

  it("o estado combinado de tudo o que foi gerado é válido", () => {
    const inputs = plan.files
      .filter((f) => f.path.startsWith(".beads/tasks/"))
      .map((f) => ({ bead: f.path.split("/")[2]!, branchFile: "chore-migra", text: f.text }));
    const project = plan.files.filter((f) => f.path.startsWith(".beads/project/")).map((f) => ({ branchFile: "chore-migra", text: f.text }));
    const state = buildState(inputs, project, { nowMs: NOW });
    expect(state.errors).toEqual([]);
    expect(state.beads.length).toBe(6);
  });
});

describe("planMigration — ids que não viram pasta abortam antes de escrever", () => {
  const base = (id: string) => `version: "1.0"\ntasks:\n  - id: "${id}"\n    title: "x"\n    status: "pending"\n    created_at: "2026-10-01T00:00:00Z"\n    updated_at: "2026-10-01T00:00:00Z"\n`;

  it("id fora do charset", () => {
    const plan = planMigration({ active: base("api login"), completed: null, index: null, mirrors: [] }, { as: "main", nowMs: NOW });
    expect(plan.errors.join()).toMatch(/api login/);
    expect(plan.files).toEqual([]);
  });

  it("ids que só diferem em maiúsculas", () => {
    const completed = base("api-Login").replace('version: "1.0"\n', "");
    const plan = planMigration(
      { active: base("api-login"), completed: `version: "1.0"\n${completed}`, index: null, mirrors: [] },
      { as: "main", nowMs: NOW }
    );
    expect(plan.errors.join()).toMatch(/maiúsculas/);
    expect(plan.report.unique).toBe(2);
    expect(plan.report.folders).toBe(1);
    expect(plan.files).toEqual([]);
  });
});

describe("legacyInstant — tolerante ao que os arquivos antigos têm", () => {
  it("lê aspas ou não, milissegundos, só data e data-hora sem fuso (como UTC)", () => {
    expect(legacyInstant("2026-10-04T12:00:00Z")).toBe(Date.parse("2026-10-04T12:00:00Z"));
    expect(legacyInstant("2026-10-05T11:49:46.444Z")).toBe(Date.parse("2026-10-05T11:49:46.444Z"));
    expect(legacyInstant("2026-07-15")).toBe(Date.parse("2026-07-15T00:00:00Z"));
    expect(legacyInstant("2026-07-15T03:00:00")).toBe(Date.parse("2026-07-15T03:00:00Z"));
    expect(legacyInstant("")).toBeNull();
    expect(legacyInstant(undefined)).toBeNull();
  });
});

describe("planPort — active.yaml antigo trazido depois da migração", () => {
  const files = [
    { bead: "api-login", branchFile: "main", text: `${definition("Login", "2026-10-01T00:00:00Z")}entries:\n${entry("2026-10-02T00:00:00Z", { status: "in_progress" })}` },
  ];
  const ctx = (as: string) => ({
    state: buildState(files, [], { nowMs: NOW }),
    ownFiles: new Map(files.filter((f) => f.branchFile === as).map((f) => [f.bead, f.text])),
    filesOf: (id: string) => files.filter((f) => f.bead === id).map((f) => ({ branchFile: f.branchFile, text: f.text })),
  });
  const old = `version: "1.0"\ntasks:
  - id: "api-login"
    title: "Login"
    status: "completed"
    context_summary: "Feito na branch antiga."
    created_at: "2026-10-01T00:00:00Z"
    updated_at: "2026-10-03T00:00:00Z"
  - id: "ui-nova"
    title: "Nova na branch antiga"
    status: "pending"
    created_at: "2026-10-02T00:00:00Z"
    updated_at: "2026-10-02T00:00:00Z"
  - id: "api-velho"
    title: "Mais velho que o combinado"
    status: "pending"
    created_at: "2026-09-01T00:00:00Z"
    updated_at: "2026-09-01T00:00:00Z"
`;

  it("nó mais novo vira entrada no arquivo da branch; id novo vira pasta", () => {
    const plan = planPort(old, ctx("feat-x"), { as: "feat-x", nowMs: NOW });
    expect(plan.errors).toEqual([]);
    expect(plan.appended).toEqual(["api-login"]);
    expect(plan.created).toEqual(["ui-nova", "api-velho"]);
    const login = plan.files.find((f) => f.path === ".beads/tasks/api-login/feat-x.yaml")!;
    expect(load(login.text)).toEqual({
      entries: [{ at: "2026-10-03T00:00:00Z", status: "completed", context_summary: "Feito na branch antiga." }],
    });
  });

  it("id que só difere em maiúsculas de um bead existente é erro, nunca sobrescreve", () => {
    const twin = old.replace('id: "ui-nova"', 'id: "API-Login"');
    const plan = planPort(twin, ctx("feat-x"), { as: "feat-x", nowMs: NOW });
    expect(plan.errors.join()).toMatch(/API-Login.*maiúsculas/);
    expect(plan.files).toEqual([]);
  });

  it("nó que não é mais novo que o combinado fica como já refletido", () => {
    const older = old.replace('updated_at: "2026-10-03T00:00:00Z"', 'updated_at: "2026-10-01T12:00:00Z"');
    const plan = planPort(older, ctx("feat-x"), { as: "feat-x", nowMs: NOW });
    expect(plan.skipped).toContain("api-login");
  });
});

// ── A CLI, de ponta a ponta, num repo descartável sem node_modules ────────────

let sb: Sandbox | undefined;
afterEach(() => sb?.cleanup());

function legacyRepo(): Sandbox {
  sb = makeSandbox({ env: { BEADS_NOW: "2026-10-05T12:00:00Z" }, branch: "chore/migra" });
  const s = sb;
  s.write(".beads/SCHEMA.md", "# schema antigo\n");
  s.write(".beads/BACKLOG.md", "# backlog\n");
  for (const rel of ["active.yaml", "archive/completed.yaml", "archive/index.yaml", "main.yaml", "feat-a.yaml", "feat-b.yaml", "feat-quebrado.yaml", "cost-log.json"]) {
    s.write(`.beads/${rel}`, fx(rel));
  }
  s.git("add", "-A");
  s.git("commit", "-q", "-m", "modelo antigo");
  return s;
}

describe("migrate-beads.mjs (CLI)", () => {
  it("--dry-run mostra o relatório e não toca em nada", () => {
    const s = legacyRepo();
    const r = s.node("scripts/migrate-beads.mjs", ["--dry-run", "--recover-mirrors"]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/únicos 8 → pastas 8 ✓/);
    expect(s.exists(".beads/tasks")).toBe(false);
    expect(s.git("status", "--porcelain").trim()).toBe("");
  });

  it("migra: pastas staged, modelo antigo fora do git, .gitignore e visões geradas", () => {
    const s = legacyRepo();
    const r = s.node("scripts/migrate-beads.mjs", ["--recover-mirrors"]);
    expect(r.status, r.out).toBe(0);

    const tracked = s.git("ls-files", ".beads").trim().split("\n");
    expect(tracked.filter((p) => !p.startsWith(".beads/tasks/"))).toEqual([
      ".beads/.gitignore",
      ".beads/BACKLOG.md",
      ".beads/SCHEMA.md",
      ".beads/project/chore-migra.yaml",
    ]);
    expect(tracked.filter((p) => p.startsWith(".beads/tasks/")).length).toBe(8);
    expect(tracked.every((p) => !p.startsWith(".beads/tasks/") || p.endsWith("/chore-migra.yaml"))).toBe(true);

    // custo local fica no disco, fora do git; as visões existem e são ignoradas
    expect(s.exists(".beads/cost-log.json")).toBe(true);
    expect(s.read(".beads/active.yaml")).toMatch(/^# GERADO/);
    // o rastreado sai do índice (D staged) e a visão nova no disco é ignorada (!!)
    expect(s.git("status", "--porcelain", "--ignored", ".beads/active.yaml").trim().split("\n")).toEqual([
      "D  .beads/active.yaml",
      "!! .beads/active.yaml",
    ]);
    // nada foi commitado
    expect(s.git("log", "--oneline").trim().split("\n").length).toBe(1);
  });

  it("backlog vazio: migra sem quebrar (nada em .beads/tasks)", () => {
    sb = makeSandbox({ env: { BEADS_NOW: "2026-10-05T12:00:00Z" }, branch: "main" });
    const s = sb;
    s.write(".beads/active.yaml", 'version: "1.0"\nbranch: "main"\nproject: ""\nlast_updated: ""\nsession:\n  budget_usd: 2\n  cost_accumulated_usd: 0\ntasks: []\n');
    s.write(".beads/main.yaml", 'version: "1.0"\ntasks: []\n');
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "modelo antigo vazio");
    const r = s.node("scripts/migrate-beads.mjs");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/únicos 0 → pastas 0 ✓/);
    expect(s.git("ls-files", ".beads").trim()).toBe(".beads/.gitignore");
    expect(s.exists(".beads/active.yaml")).toBe(false);
  });

  it("--from-worktree com espelho modificado na árvore: migra o que está na árvore", () => {
    const s = legacyRepo();
    s.write(".beads/feat-a.yaml", fx("feat-a.yaml").replace("versão nova", "versão editada na árvore"));
    const r = s.node("scripts/migrate-beads.mjs", ["--from-worktree", "--recover-mirrors"]);
    expect(r.status, r.out).toBe(0);
    expect(s.read(".beads/tasks/release-so-no-espelho/chore-migra.yaml")).toMatch(/editada na árvore/);
    expect(s.git("ls-files", ".beads/feat-a.yaml").trim()).toBe("");
    expect(s.exists(".beads/feat-a.yaml")).toBe(false);
  });

  it("branch com tag de mesmo nome: o arquivo continua com o nome da branch", () => {
    const s = legacyRepo();
    s.git("tag", "chore/migra");
    const r = s.node("scripts/migrate-beads.mjs", ["--dry-run"]);
    expect(r.out).toContain(".beads/tasks/<id>/chore-migra.yaml");
  });

  it("recusa rodar de novo depois de migrado", () => {
    const s = legacyRepo();
    s.node("scripts/migrate-beads.mjs");
    s.git("commit", "-q", "-m", "migra");
    const r = s.node("scripts/migrate-beads.mjs");
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/já está no modelo novo/);
  });

  it("recusa com algo staged em .beads/", () => {
    const s = legacyRepo();
    s.write(".beads/BACKLOG.md", "# backlog mudado\n");
    s.git("add", ".beads/BACKLOG.md");
    const r = s.node("scripts/migrate-beads.mjs");
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/staged/);
  });

  it("lê HEAD: com mudança não commitada no active.yaml, recusa; --from-worktree lê a árvore", () => {
    const s = legacyRepo();
    s.write(".beads/active.yaml", fx("active.yaml").replace("Medir o subagente nativo", "Medir (editado na árvore)"));
    const r = s.node("scripts/migrate-beads.mjs");
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/--from-worktree/);

    const w = s.node("scripts/migrate-beads.mjs", ["--from-worktree"]);
    expect(w.status, w.out).toBe(0);
    expect(s.read(".beads/tasks/qa-pendente/chore-migra.yaml")).toMatch(/editado na árvore/);
  });

  it("aborta sem escrever nada quando um id não vira pasta", () => {
    const s = legacyRepo();
    s.write(".beads/active.yaml", fx("active.yaml").replace("id: qa-pendente", "id: qa pendente"));
    s.git("commit", "-q", "-am", "id ruim");
    const r = s.node("scripts/migrate-beads.mjs");
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/qa pendente/);
    expect(r.out).toMatch(/abortada/);
    expect(s.exists(".beads/tasks")).toBe(false);
  });

  it("--port acrescenta no arquivo da branch o que a branch antiga trouxe", () => {
    const s = legacyRepo();
    s.node("scripts/migrate-beads.mjs");
    s.git("commit", "-q", "-m", "migra");
    s.git("checkout", "-q", "-b", "feat/velha");
    const oldActive = fx("active.yaml").replace("status: pending\n    effort: M", "status: completed\n    context_summary: Feito na branch velha.\n    effort: M").replace("updated_at: '2026-10-01T01:07:01Z'", "updated_at: '2026-10-05T10:00:00Z'");
    s.write(".git/port-antigo.yaml", oldActive);
    const r = s.node("scripts/migrate-beads.mjs", ["--port", path.join(s.dir, ".git", "port-antigo.yaml")]);
    expect(r.status, r.out).toBe(0);
    const own = s.read(".beads/tasks/qa-pendente/feat-velha.yaml");
    expect(load(own)).toEqual({
      entries: [{ at: "2026-10-05T10:00:00Z", status: "completed", context_summary: "Feito na branch velha." }],
    });
    expect(s.git("diff", "--cached", "--name-only").trim()).toBe(".beads/tasks/qa-pendente/feat-velha.yaml");
  });

  it("--port com o mesmo id duas vezes fica com o updated_at maior", () => {
    const s = legacyRepo();
    s.node("scripts/migrate-beads.mjs");
    s.git("commit", "-q", "-m", "migra");
    const twice = `version: "1.0"\ntasks:
  - id: "ui-dupla"
    title: "Dupla"
    status: "in_progress"
    updated_at: "2026-10-05T11:00:00Z"
  - id: "ui-dupla"
    title: "Dupla"
    status: "pending"
    updated_at: "2026-10-05T09:00:00Z"
`;
    s.write(".git/dupla.yaml", twice);
    const r = s.node("scripts/migrate-beads.mjs", ["--port", path.join(s.dir, ".git", "dupla.yaml")]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/1 criado\(s\), 0 com entrada nova/);
    expect((load(s.read(".beads/tasks/ui-dupla/chore-migra.yaml")) as any).entries).toEqual([
      { at: "2026-10-05T11:00:00Z", status: "in_progress" },
    ]);
  });

  it("--port-from <rev> lê active, archive/ e espelhos daquele commit e porta o mais novo de cada id", () => {
    const s = legacyRepo();
    const legacyRev = s.git("rev-parse", "HEAD").trim();
    s.node("scripts/migrate-beads.mjs", ["--recover-mirrors"]);
    s.git("commit", "-q", "-m", "migra");
    // O commit antigo já está todo refletido: nada a fazer.
    const same = s.node("scripts/migrate-beads.mjs", ["--port-from", legacyRev, "--recover-mirrors"]);
    expect(same.status, same.out).toBe(0);
    expect(same.out).toMatch(/0 criado\(s\), 0 com entrada nova, 8 já refletido\(s\)/);
    expect(s.git("status", "--porcelain").trim()).toBe("");

    // Uma branch antiga que mexeu no archive/ e no active.yaml depois do fork.
    s.git("checkout", "-q", "-b", "velha", legacyRev);
    s.write(
      ".beads/archive/completed.yaml",
      `${fx("archive/completed.yaml")}  - id: "api-arquivada-na-velha"\n    title: "Arquivada na velha"\n    status: "completed"\n    updated_at: "2026-10-05T10:00:00Z"\n`
    );
    s.git("commit", "-q", "-am", "velha arquiva");
    s.git("checkout", "-q", "chore/migra");
    const r = s.node("scripts/migrate-beads.mjs", ["--port-from", "velha"]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/--port-from velha/);
    expect(r.out).toMatch(/1 criado\(s\), 0 com entrada nova/);
    expect(s.git("diff", "--cached", "--name-only").trim()).toBe(".beads/tasks/api-arquivada-na-velha/chore-migra.yaml");

    const bad = s.node("scripts/migrate-beads.mjs", ["--port-from", "nao-existe"]);
    expect(bad.status).toBe(1);
    expect(bad.out).toMatch(/nao-existe/);
  });

  // O archive antigo perdia nós (#30) e um merge podia descartar o espelho de
  // uma branch: o id sumia do HEAD, mas continua no histórico do git.
  it("--scan-history traz de volta o id apagado no meio do histórico, com commit e arquivo de origem", () => {
    sb = makeSandbox({ env: { BEADS_NOW: "2026-10-05T12:00:00Z" }, branch: "main" });
    const s = sb;
    const doc = (tasks: string) => `version: "1.0"\nbranch: "main"\nlast_updated: "2026-09-01T00:00:00Z"\ntasks:\n${tasks}`;
    const n = (id: string, status: string, at: string) =>
      `  - id: "${id}"\n    title: "${id}"\n    status: "${status}"\n    created_at: "2026-09-01T00:00:00Z"\n    updated_at: "${at}"\n`;
    const commit = (msg: string) => {
      s.git("add", "-A");
      s.git("commit", "-q", "-m", msg);
      return s.git("rev-parse", "--short=7", "HEAD").trim();
    };

    s.write(".beads/active.yaml", doc(`${n("api-a", "pending", "2026-09-02T00:00:00Z")}${n("api-apagada", "in_progress", "2026-09-03T00:00:00Z")}`));
    const c1 = commit("c1: api-a e api-apagada");
    s.write(".beads/active.yaml", doc(n("api-a", "in_progress", "2026-09-04T00:00:00Z")));
    commit("c2: api-apagada some do active.yaml");
    // um lado que o merge descartou (-s ours): api-lado só existiu no espelho dele
    s.git("checkout", "-q", "-b", "lado");
    s.write(".beads/lado.yaml", doc(`${n("api-lado", "completed", "2026-09-05T00:00:00Z")}${n("id com espaco", "pending", "2026-09-05T00:00:00Z")}`));
    const cLado = commit("lado: espelho");
    s.git("checkout", "-q", "main");
    s.git("merge", "-q", "-s", "ours", "--no-edit", "lado");

    expect(s.node("scripts/migrate-beads.mjs").status).toBe(0);
    commit("migra");
    expect(s.git("ls-files", ".beads/tasks").trim().split("\n")).toEqual([".beads/tasks/api-a/main.yaml"]);

    const dry = s.node("scripts/migrate-beads.mjs", ["--scan-history", "--dry-run"]);
    expect(dry.status, dry.out).toBe(0);
    expect(s.exists(".beads/tasks/api-apagada")).toBe(false);

    const r = s.node("scripts/migrate-beads.mjs", ["--scan-history"]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`api-apagada · in_progress · ${c1} .beads/active.yaml`);
    expect(r.out).toContain(`api-lado · completed · ${cLado} .beads/lado.yaml`);
    expect(r.out).toMatch(/faltam em \.beads\/tasks\/: 2 \(1 não concluído\(s\), 1 concluído\(s\)\)/);
    expect(r.out).toMatch(/ignorado.*id com espaco/);
    expect(r.out).toMatch(/2 criado\(s\), 0 com entrada nova/);
    expect((load(s.read(".beads/tasks/api-apagada/main.yaml")) as any).entries).toEqual([
      { at: "2026-09-03T00:00:00Z", status: "in_progress" },
    ]);
    expect(s.git("diff", "--cached", "--name-only").trim().split("\n").sort()).toEqual([
      ".beads/tasks/api-apagada/main.yaml",
      ".beads/tasks/api-lado/main.yaml",
    ]);
    commit("recupera do histórico");
    const again = s.node("scripts/migrate-beads.mjs", ["--scan-history"]);
    expect(again.status, again.out).toBe(0);
    expect(again.out).toMatch(/faltam em \.beads\/tasks\/: 0/);
  });
});
