import { afterEach, describe, expect, it } from "vitest";
import { load } from "js-yaml";
import { definition, entry, makeSandbox, type Sandbox } from "./beads-sandbox.js";
import { GITIGNORE, viewIntegrity } from "./beads-core.mjs";
import { validateBeads } from "./beads-schema.js";

// As CLIs rodam como subprocesso num repo descartável SEM aiteam/node_modules:
// é a prova de que beads-views e beads-check funcionam numa worktree recém-criada.
// Contrato: aiteam/docs/beads-schema.md §7 (visões) e §8 (validação).

const NOW = "2026-10-05T12:00:00Z";
let sb: Sandbox;

function sandbox(): Sandbox {
  sb = makeSandbox({ env: { BEADS_NOW: NOW } });
  return sb;
}

afterEach(() => sb?.cleanup());

const LOGIN = `${definition("Login", "2026-10-01T10:00:00Z", 'effort: "M"\n')}entries:\n${entry("2026-10-02T10:00:00Z", {
  status: "in_progress",
  stage: "implement",
})}`;
const VELHO = `${definition("Velho", "2026-07-01T10:00:00Z")}entries:\n${entry("2026-07-02T10:00:00Z", { status: "completed" })}`;

function seed(s: Sandbox): void {
  s.write("SPEC.md", '---\nproject: "demo"\nbudget_usd: 3.50\n---\n# demo\n');
  s.write(".beads/tasks/api-login/main.yaml", LOGIN);
  s.write(".beads/tasks/orch-velho/main.yaml", VELHO);
}

describe("beads-views — gera as visões", () => {
  it("escreve active.yaml e index.yaml válidos, com SPEC e custo local", () => {
    const s = sandbox();
    seed(s);
    s.write(".beads/session.local.json", JSON.stringify({ cost_accumulated_usd: 0.42, circuit_open: false }));

    const r = s.node("scripts/beads-views.mjs");
    expect(r.status, r.out).toBe(0);

    const active = s.read(".beads/active.yaml");
    expect(viewIntegrity(active)).toBe("intact");
    expect(validateBeads(active).errors).toEqual([]);
    const doc = load(active) as any;
    expect(doc.project).toBe("demo");
    expect(doc.session.budget_usd).toBe(3.5);
    expect(doc.session.cost_accumulated_usd).toBe(0.42);
    expect(doc.tasks.map((t: any) => t.id)).toEqual(["api-login"]);
    expect(doc.archive.count).toBe(1);

    const index = load(s.read(".beads/index.yaml")) as any[];
    expect(index.map((e) => e.id)).toEqual(["orch-velho", "api-login"]);
  });

  it("budget sem SPEC cai no AI_SESSION_BUDGET_USD e depois em 2", () => {
    const s = sandbox();
    s.write(".beads/tasks/api-login/main.yaml", LOGIN);
    expect(s.node("scripts/beads-views.mjs", [], { AI_SESSION_BUDGET_USD: "7" }).status).toBe(0);
    expect((load(s.read(".beads/active.yaml")) as any).session.budget_usd).toBe(7);
    expect(s.node("scripts/beads-views.mjs", [], { AI_SESSION_BUDGET_USD: "" }).status).toBe(0);
    expect((load(s.read(".beads/active.yaml")) as any).session.budget_usd).toBe(2);
  });

  it("--merge (o modo do post-merge) mostra os avisos de combinação e cala os de conteúdo", () => {
    const s = sandbox();
    seed(s);
    s.write(".beads/tasks/api-login/feat-x.yaml", `title: "Outra definição"\ncreated_at: "2026-10-01T11:00:00Z"\n`);
    s.write(".beads/tasks/api-html/main.yaml", definition("<b>html</b>", "2026-10-01T10:00:00Z", 'status: "pending"\n'));
    const r = s.node("scripts/beads-views.mjs", ["--merge"]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/definido por feat-x e main/);
    expect(r.out).not.toMatch(/HTML/);
    const full = s.node("scripts/beads-views.mjs");
    expect(full.out).toMatch(/HTML/);
  });

  it("rodar de novo sem mudança não reescreve o conteúdo", () => {
    const s = sandbox();
    seed(s);
    s.node("scripts/beads-views.mjs");
    const before = s.read(".beads/active.yaml");
    const r = s.node("scripts/beads-views.mjs");
    expect(r.status).toBe(0);
    expect(s.read(".beads/active.yaml")).toBe(before);
  });

  it("bead inválido é pulado com aviso alto, e o resto é renderizado", () => {
    const s = sandbox();
    seed(s);
    s.write(".beads/tasks/api-quebrado/main.yaml", 'title: "sem data"\n');
    const r = s.node("scripts/beads-views.mjs", ["--quiet"]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/api-quebrado/);
    expect(r.out).toMatch(/created_at/);
    const doc = load(s.read(".beads/active.yaml")) as any;
    expect(doc.tasks.map((t: any) => t.id)).toEqual(["api-login"]);
    expect(s.read(".beads/active.yaml")).toMatch(/1 inválido/);
  });

  it("visão editada à mão vai para .editado-<ts> antes de ser reescrita, com aviso", () => {
    const s = sandbox();
    seed(s);
    s.node("scripts/beads-views.mjs");
    const edited = s.read(".beads/active.yaml").replace('"in_progress"', '"completed"');
    s.write(".beads/active.yaml", edited);

    const r = s.node("scripts/beads-views.mjs", ["--quiet"]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/editad/i);
    expect(s.read(".beads/active.yaml.editado-20261005T120000Z")).toBe(edited);
    expect(viewIntegrity(s.read(".beads/active.yaml"))).toBe("intact");
  });

  it("um active.yaml que não é visão gerada também é guardado, nunca destruído", () => {
    const s = sandbox();
    seed(s);
    const legacy = 'version: "1.0"\nbranch: "main"\ntasks: []\n';
    s.write(".beads/active.yaml", legacy);
    s.node("scripts/beads-views.mjs", ["--quiet"]);
    expect(s.read(".beads/active.yaml.editado-20261005T120000Z")).toBe(legacy);
  });

  it("falha de escrita mantém o que havia, avisa e sai com 1", () => {
    const s = sandbox();
    seed(s);
    s.write(".beads/active.yaml/bloqueio", "um diretório no lugar da visão");
    const r = s.node("scripts/beads-views.mjs", ["--quiet"]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/active\.yaml/);
    expect(s.read(".beads/active.yaml/bloqueio")).toBe("um diretório no lugar da visão");
    expect(viewIntegrity(s.read(".beads/index.yaml"))).toBe("intact");
  });

  // Sem .beads/tasks nem .beads/project o repo não está no modelo novo: um
  // active.yaml solto ali (fora de um repo git, por exemplo) é do usuário.
  it("sem .beads/tasks nem .beads/project, não gera nada e não toca no active.yaml", () => {
    const s = sandbox();
    const solto = 'version: "1.0"\nbranch: "main"\ntasks: []\n';
    s.write(".beads/active.yaml", solto);
    const r = s.node("scripts/beads-views.mjs");
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/nada a gerar/);
    expect(s.read(".beads/active.yaml")).toBe(solto);
    expect(s.exists(".beads/index.yaml")).toBe(false);
  });

  it("modo legado (active.yaml rastreado): não gera nada e só avisa", () => {
    const s = sandbox();
    const legacy = 'version: "1.0"\nbranch: "main"\nproject: ""\nlast_updated: ""\nsession:\n  budget_usd: 2\n  cost_accumulated_usd: 0\ntasks: []\n';
    s.write(".beads/active.yaml", legacy);
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "legado");
    const r = s.node("scripts/beads-views.mjs");
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/legado/);
    expect(s.read(".beads/active.yaml")).toBe(legacy);
    expect(s.exists(".beads/index.yaml")).toBe(false);
  });

  it("modo legado remove o index.yaml gerado que sobrou de uma branch do modelo novo", () => {
    const s = sandbox();
    seed(s);
    s.node("scripts/beads-views.mjs");
    const generated = s.read(".beads/index.yaml");
    s.remove(".beads/tasks");
    s.write(".beads/active.yaml", 'version: "1.0"\nbranch: "x"\nproject: ""\nlast_updated: ""\nsession:\n  budget_usd: 2\n  cost_accumulated_usd: 0\ntasks: []\n');
    s.git("add", ".beads/active.yaml");
    s.git("commit", "-q", "-m", "legado");
    expect(viewIntegrity(generated)).toBe("intact");

    s.node("scripts/beads-views.mjs", ["--quiet"]);
    expect(s.exists(".beads/index.yaml")).toBe(false);
  });
});

describe("beads-check --all", () => {
  it("passa com beads válidos", () => {
    const s = sandbox();
    seed(s);
    const r = s.node("scripts/beads-check.mjs", ["--all"]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/2 beads/);
  });

  it("falha com o erro de cada bead inválido", () => {
    const s = sandbox();
    seed(s);
    s.write(".beads/tasks/api-quebrado/main.yaml", `${definition("x", "2026-10-01T10:00:00Z")}status: "done"\n`);
    const r = s.node("scripts/beads-check.mjs", ["--all"]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/api-quebrado\/main\.yaml: status/);
  });

  it("arquivo estranho dentro de .beads/tasks é erro", () => {
    const s = sandbox();
    seed(s);
    s.write(".beads/tasks/api-login/notas.md", "x");
    s.write(".beads/tasks/api-login/main.yml", "x");
    const r = s.node("scripts/beads-check.mjs", ["--all"]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/notas\.md/);
    expect(r.out).toMatch(/main\.yml/);
  });

  // Um merge fica isento da regra de dono, então uma branch aberta antes da
  // migração pode trazer de volta um espelho ou o archive/ sem conflito
  // nenhum. Quem pega isso é o validate:beads — na CI, no PR.
  it("resto do modelo antigo rastreado pelo git é erro (espelho, archive/, visão)", () => {
    const s = sandbox();
    seed(s);
    s.write(".beads/main.yaml", 'version: "1.0"\ntasks: []\n');
    s.write(".beads/archive/completed.yaml", 'version: "1.0"\ntasks: []\n');
    s.write(".beads/index.yaml", "- {id: x}\n");
    s.git("add", "-A");
    const r = s.node("scripts/beads-check.mjs", ["--all"]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/\.beads\/main\.yaml: rastreado/);
    expect(r.out).toMatch(/\.beads\/archive\/completed\.yaml: rastreado/);
    expect(r.out).toMatch(/\.beads\/index\.yaml: rastreado/);
    expect(r.out).toMatch(/git rm --cached/);
    // Espelho e archive/ ainda podem trazer bead que o modelo novo não tem:
    // a dica manda portar antes de tirar do git.
    expect(r.out).toMatch(/\.beads\/main\.yaml: .*porte com --port \.beads\/main\.yaml antes do git rm --cached/);
    expect(r.out).toMatch(/\.beads\/archive\/completed\.yaml: .*porte com --port \.beads\/archive\/completed\.yaml antes do git rm --cached/);
  });

  // Num repo já migrado, um active.yaml forçado com git add -f (mesmo sem o
  // cabeçalho de visão) não religa o modo legado: vira resto a tirar do git.
  it("active.yaml forçado num repo migrado não liga o modo legado", () => {
    const s = sandbox();
    seed(s);
    s.write(".beads/active.yaml", 'version: "1.0"\nbranch: "main"\ntasks: []\n');
    s.git("add", "-A");
    s.git("add", "-f", ".beads/active.yaml");
    const r = s.node("scripts/beads-check.mjs", ["--all"]);
    expect(r.status).toBe(1);
    expect(r.out).not.toMatch(/modo legado/);
    expect(r.out).toMatch(/\.beads\/active\.yaml: rastreado/);
  });

  // O modo legado se decide pelo HEAD: pastas commitadas por fora (com
  // --no-verify, por exemplo) não o desligam — e o validate:beads acusa.
  it("legado com .beads/tasks commitado: segue legado, a visão não toca o active.yaml e o check acusa", () => {
    const s = sandbox();
    const legacy = 'version: "1.0"\nbranch: "main"\nproject: ""\nlast_updated: ""\nsession:\n  budget_usd: 2\n  cost_accumulated_usd: 0\ntasks: []\n';
    s.write(".beads/active.yaml", legacy);
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "legado");
    s.write(".beads/tasks/api-login/main.yaml", LOGIN);
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "pasta por fora");
    expect(s.node("scripts/beads-views.mjs").out).toMatch(/modo legado/);
    expect(s.read(".beads/active.yaml")).toBe(legacy);
    const r = s.node("scripts/beads-check.mjs", ["--all"]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/modo legado.*\.beads\/tasks/);
  });

  it("modo legado não falha: avisa que é hora de migrar", () => {
    const s = sandbox();
    s.write(".beads/active.yaml", 'version: "1.0"\ntasks: []\n');
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "legado");
    const r = s.node("scripts/beads-check.mjs", ["--all"]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/legado/);
  });
});

describe("beads-check --staged", () => {
  function committed(s: Sandbox): void {
    seed(s);
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "base");
  }

  it("acréscimo no fim do próprio arquivo passa", () => {
    const s = sandbox();
    committed(s);
    s.write(".beads/tasks/api-login/main.yaml", `${LOGIN}${entry("2026-10-03T10:00:00Z", { status: "completed" })}`);
    s.git("add", "-A");
    const r = s.node("scripts/beads-check.mjs", ["--staged", "--branch", "main"]);
    expect(r.status, r.out).toBe(0);
  });

  it("editar o meio de um arquivo já commitado é erro", () => {
    const s = sandbox();
    committed(s);
    s.write(".beads/tasks/api-login/main.yaml", LOGIN.replace('"implement"', '"review"'));
    s.git("add", "-A");
    const r = s.node("scripts/beads-check.mjs", ["--staged", "--branch", "main"]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/só cresce no fim/);
  });

  it("arquivo de outra branch é erro, com o caminho certo", () => {
    const s = sandbox();
    committed(s);
    s.write(".beads/tasks/api-login/main.yaml", `${LOGIN}${entry("2026-10-03T10:00:00Z", { status: "blocked" })}`);
    s.git("add", "-A");
    const r = s.node("scripts/beads-check.mjs", ["--staged", "--branch", "feat-x"]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/\.beads\/tasks\/api-login\/feat-x\.yaml/);
  });

  it("conteúdo inválido no arquivo staged é erro", () => {
    const s = sandbox();
    committed(s);
    s.write(".beads/tasks/api-novo/main.yaml", 'title: "sem data"\n');
    s.git("add", "-A");
    const r = s.node("scripts/beads-check.mjs", ["--staged", "--branch", "main"]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/created_at/);
  });

  it("valida o que está staged, não a árvore", () => {
    const s = sandbox();
    committed(s);
    s.write(".beads/tasks/api-novo/main.yaml", definition("Novo", "2026-10-04T10:00:00Z"));
    s.git("add", "-A");
    s.write(".beads/tasks/api-novo/main.yaml", 'title: "estragado só na árvore"\n');
    const r = s.node("scripts/beads-check.mjs", ["--staged", "--branch", "main"]);
    expect(r.status, r.out).toBe(0);
  });

  it("id novo que colide ignorando maiúsculas com um existente é erro", () => {
    const s = sandbox();
    committed(s);
    // Direto no índice: num disco que ignora maiúsculas (Windows, macOS) as
    // duas pastas não coexistem na árvore — mas coexistem no git, e é o que
    // chega num clone Linux.
    s.git("config", "core.ignorecase", "false");
    s.write(".git/blob-tmp", definition("Outro", "2026-10-04T10:00:00Z"));
    const blob = s.git("hash-object", "-w", ".git/blob-tmp").trim();
    s.git("update-index", "--add", "--cacheinfo", `100644,${blob},.beads/tasks/API-login/main.yaml`);
    const r = s.node("scripts/beads-check.mjs", ["--staged", "--branch", "main"]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/maiúsculas/);
  });
});

// O install.mjs garante o .beads/.gitignore canônico (§2) — também num
// consumidor ainda legado, onde o circuit breaker já escreve o
// session.local.json e nada o ignorava.
describe("install.mjs — .beads/.gitignore canônico", () => {
  const LEGADO = 'version: "1.0"\nbranch: "main"\ntasks: []\n';

  it("consumidor legado: cria o .gitignore sem sair do legado; session.local.json ignorado; idempotente", () => {
    const s = sandbox();
    s.write(".beads/active.yaml", LEGADO);
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "legado");
    const r = s.node("install.mjs");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/\.beads\/\.gitignore/);
    expect(r.out).toMatch(/modo legado/);
    expect(s.read(".beads/.gitignore")).toBe(GITIGNORE);
    expect(s.read(".beads/active.yaml")).toBe(LEGADO);
    expect(s.git("ls-files", ".beads/active.yaml").trim()).toBe(".beads/active.yaml");

    s.write(".beads/session.local.json", '{"cost_accumulated_usd": 0.1}\n');
    s.write(".beads/session.local.json.corrupt-20261005T120000Z", "{");
    expect(s.git("status", "--porcelain", "--", ".beads").trim()).toBe("?? .beads/.gitignore");

    const again = s.node("install.mjs");
    expect(again.status, again.out).toBe(0);
    expect(again.out).not.toMatch(/\.beads\/\.gitignore/);
    expect(s.read(".beads/.gitignore")).toBe(GITIGNORE);
  });

  it("repo com .gitignore próprio: acrescenta só as linhas que faltam", () => {
    const s = sandbox();
    s.write(".beads/.gitignore", "# local\n/session.local.json\nrascunho.txt\n");
    s.write(".beads/tasks/api-login/main.yaml", LOGIN);
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "modelo novo");
    expect(s.node("install.mjs").status).toBe(0);
    const out = s.read(".beads/.gitignore");
    expect(out.startsWith("# local\n/session.local.json\nrascunho.txt\n")).toBe(true);
    expect(out.split("\n").filter((l) => l === "/session.local.json")).toHaveLength(1);
    expect(out).toContain("/active.yaml\n");
    expect(s.git("status", "--porcelain", "--", ".beads").trim()).toBe("M .beads/.gitignore");
  });
});
