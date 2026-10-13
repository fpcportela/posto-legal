import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildState } from "./beads-core.mjs";
import { makeSandbox } from "./beads-sandbox.js";
import { USAGE, classify, envValue, linkBeads, main, makeTrelloClient, parseArgs, renderReport } from "./trello-reconcile.mjs";
import { repoRoot } from "./repo-root.js";

// aiteam/scripts/beads-trello-reconcile.mjs (rb-ai-team#28): confere o beads com o quadro do
// Trello nas duas direções, só lendo. Os testes NUNCA tocam a rede: o cliente é injetado (`io.trello`)
// ou o transporte dele é um fetch falso (`io.fetch`).

const NOW = Date.parse("2026-10-05T12:00:00Z");

// ── O projeto descartável: .beads/tasks/ num diretório de tmp, sem git ────────

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

interface BeadSpec {
  status?: "pending" | "in_progress" | "completed" | "blocked";
  /** o campo `trello`, em YAML (já com aspas/colchetes) */
  trello?: string;
  scope?: "partial";
  /** texto livre numa `note`: é onde a prosa cita o card */
  note?: string;
}

function beadFile(id: string, spec: BeadSpec): string {
  const lines = [`title: "Bead ${id}"`];
  if (spec.trello !== undefined) lines.push(`trello: ${spec.trello}`);
  if (spec.scope) lines.push(`trello_scope: "${spec.scope}"`);
  lines.push('created_at: "2026-10-01T10:00:00Z"', "entries:", '  - at: "2026-10-02T10:00:00Z"', `    status: "${spec.status ?? "pending"}"`);
  if (spec.note) lines.push(`    note: ${JSON.stringify(spec.note)}`);
  return `${lines.join("\n")}\n`;
}

function project(beads: Record<string, BeadSpec>, extra: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trello-reconcile-"));
  dirs.push(dir);
  for (const [id, spec] of Object.entries(beads)) {
    fs.mkdirSync(path.join(dir, ".beads", "tasks", id), { recursive: true });
    fs.writeFileSync(path.join(dir, ".beads", "tasks", id, "main.yaml"), beadFile(id, spec));
  }
  for (const [rel, text] of Object.entries(extra)) fs.writeFileSync(path.join(dir, rel), text);
  return dir;
}

// ── O quadro falso ───────────────────────────────────────────────────────────

const LISTS = [
  { id: "L1", name: "MESA to-do" },
  { id: "L2", name: "Backlog" },
  { id: "L3", name: "FINALIZADO" },
  { id: "L4", name: "Em andamento" },
];
const MESA = [{ name: "MESA" }];
const CARDS = [
  { name: "Card adiantado", shortLink: "AAAA1111", idList: "L3", labels: MESA },
  { name: "Card parcial", shortLink: "BBBB2222", idList: "L3", labels: MESA },
  { name: "Card atrasado", shortLink: "CCCC3333", idList: "L1", labels: MESA },
  { name: "Card novo na fila", shortLink: "DDDD4444", idList: "L1", labels: MESA },
  { name: "Certidão negativa de débitos", shortLink: "EEEE5555", idList: "L2", labels: MESA },
  { name: "Card de outro time", shortLink: "FFFF6666", idList: "L2", labels: [] },
  { name: "Card MESA no backlog", shortLink: "GGGG7777", idList: "L2", labels: MESA },
  { name: "Card só em prosa", shortLink: "HHHH8888", idList: "L4", labels: MESA },
  { name: "Card meio preenchido", shortLink: "IIII9999", idList: "L4", labels: MESA },
  { name: "Card esquecido", shortLink: "JJJJ0000", idList: "L4", labels: MESA },
];
const BEADS: Record<string, BeadSpec> = {
  "api-adiantado": { status: "in_progress", trello: '"AAAA1111"' },
  "api-parcial": { status: "in_progress", trello: '"BBBB2222"', scope: "partial", note: "O card pedia só a tela." },
  "api-atrasado": { status: "completed", trello: '"CCCC3333"' },
  "api-prosa": { status: "pending", note: "Origem: Trello card https://trello.com/c/HHHH8888 ('Card só em prosa')." },
  "api-metade": {
    status: "pending",
    trello: '["IIII9999"]',
    note: "Absorveu também https://trello.com/c/JJJJ0000 e o IIII9999: https://trello.com/c/IIII9999.",
  },
  "api-sem-card": { status: "pending" },
};

const fakeTrello = (lists = LISTS, cards = CARDS) => {
  const calls: { path: string; params: Record<string, string> }[] = [];
  const client = async (p: string, params: Record<string, string> = {}) => {
    calls.push({ path: p, params });
    if (p.endsWith("/lists")) return lists;
    if (p.endsWith("/cards")) return cards;
    throw new Error(`rota inesperada: ${p}`);
  };
  return { client, calls };
};

async function run(argv: string[], dir: string, io: Record<string, unknown> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(argv, { cwd: dir, env: {}, stdout: (l: string) => stdout.push(l), stderr: (l: string) => stderr.push(l), ...io });
  return { code, stdout, stderr, out: stdout.join("\n"), err: stderr.join("\n") };
}

const idsOf = (rows: { card?: string; id?: string }[]) => rows.map((r) => r.card ?? r.id);

// ── Argumentos ───────────────────────────────────────────────────────────────

describe("parseArgs", () => {
  it("--board mais --queue e/ou --label; os valores aceitam --flag=valor", () => {
    const a: any = parseArgs(["--board", "XYZ", "--queue", "L1,L2", "--label=MESA", "--ignore", "certid", "--json"]);
    expect(a).toMatchObject({ board: "XYZ", queue: ["L1", "L2"], json: true, help: false });
    expect(a.label.test("mesa")).toBe(true); // sem diferenciar maiúsculas
    expect(a.ignore.test("Certidão negativa")).toBe(true);
    expect(a.ignore.test("Proposta comercial")).toBe(false);
    expect(a.doneLists.test("FINALIZADO")).toBe(true);
    expect(a.doneLists.test("Em andamento")).toBe(false);
    expect(parseArgs(["--board", "X", "--label", "A"]) as any).toMatchObject({ queue: [], label: expect.any(RegExp), ignore: null });
  });

  it("--done-lists troca o regex das listas de pronto", () => {
    const a: any = parseArgs(["--board", "X", "--queue", "L1", "--done-lists", "^entregue$"]);
    expect(a.doneLists.test("Entregue")).toBe(true);
    expect(a.doneLists.test("FINALIZADO")).toBe(false);
  });

  it("--help não exige o resto", () => {
    expect(parseArgs(["--help"])).toEqual({ help: true });
  });

  it("o uso diz que só lê o checkout atual (as outras branches e worktrees não entram), e que o aviso de filtro vai para stderr", () => {
    expect(USAGE).toMatch(/só lê o checkout atual/);
    expect(USAGE).toMatch(/outras branches/);
    expect(USAGE).toMatch(/stderr/);
  });

  it("sem --board, sem filtro do projeto, flag desconhecida, valor ausente e regex inválida são uso errado", () => {
    expect(() => parseArgs([])).toThrow(/--board é obrigatório/);
    expect(() => parseArgs(["--board", "X"])).toThrow(/--queue.*--label/);
    expect(() => parseArgs(["--board", "X", "--queue", "L1", "--mesa"])).toThrow(/flag desconhecida: --mesa/);
    expect(() => parseArgs(["--board"])).toThrow(/precisa de um valor/);
    expect(() => parseArgs(["--board", "X", "--queue", "--json"])).toThrow(/precisa de um valor/);
    expect(() => parseArgs(["--board", "X", "--queue", ""])).toThrow(/vazio/);
    expect(() => parseArgs(["--board", "X", "--label", "("])).toThrow(/--label: expressão regular inválida/);
    expect(() => parseArgs(["--board", "X", "--queue", "L1", "x"])).toThrow(/argumento inesperado/);
    expect(() => parseArgs(["--board", "X", "--queue", "L1", "--json=1"])).toThrow(/não leva valor/);
  });
});

// ── O cliente e as credenciais ───────────────────────────────────────────────

describe("makeTrelloClient e envValue", () => {
  it("monta a URL com os parâmetros, a chave e o token", async () => {
    const urls: string[] = [];
    const trello = makeTrelloClient("k1", "t1", (async (u: string) => {
      urls.push(u);
      return { ok: true, json: async () => [{ id: "L1" }] };
    }) as any);
    expect(await trello("/boards/B/lists", { fields: "name" })).toEqual([{ id: "L1" }]);
    const u = new URL(urls[0]!);
    expect(u.origin + u.pathname).toBe("https://api.trello.com/1/boards/B/lists");
    expect(Object.fromEntries(u.searchParams)).toEqual({ fields: "name", key: "k1", token: "t1" });
  });

  it("o erro cita o caminho e o status, nunca a URL (que carrega o token)", async () => {
    const http = makeTrelloClient("k1", "SEGREDO", (async () => ({ ok: false, status: 401 })) as any);
    await expect(http("/boards/B/lists")).rejects.toThrow(/^Trello \/boards\/B\/lists → HTTP 401$/);
    const net = makeTrelloClient("k1", "SEGREDO", (async () => {
      throw new Error("getaddrinfo ENOTFOUND api.trello.com?token=SEGREDO");
    }) as any);
    const err = await net("/boards/B/lists").catch((e: Error) => e);
    expect((err as Error).message).toBe("Trello /boards/B/lists → sem resposta (rede?)");
    expect((err as Error).message).not.toContain("SEGREDO");
    const bad = makeTrelloClient("k1", "SEGREDO", (async () => ({ ok: true, json: async () => { throw new Error("x"); } })) as any);
    await expect(bad("/x")).rejects.toThrow(/não é JSON/);
  });

  it("envValue: o ambiente vence o .env; aspas saem; vazio é ausente", () => {
    expect(envValue("TRELLO_TOKEN", { TRELLO_TOKEN: "do-env" }, 'TRELLO_TOKEN="do-dotenv"\n')).toBe("do-env");
    expect(envValue("TRELLO_TOKEN", {}, 'TRELLO_API_KEY=k\nTRELLO_TOKEN="do-dotenv"\n')).toBe("do-dotenv");
    expect(envValue("TRELLO_TOKEN", {}, "TRELLO_TOKEN='aspas-simples'\r\n")).toBe("aspas-simples");
    expect(envValue("TRELLO_TOKEN", { TRELLO_TOKEN: "" }, "TRELLO_TOKEN=\n")).toBeNull();
    expect(envValue("TRELLO_TOKEN", {}, undefined)).toBeNull();
  });
});

// ── Os beads e o vínculo ─────────────────────────────────────────────────────

describe("linkBeads — o card de cada bead", () => {
  const stateOf = (beads: Record<string, BeadSpec>) => {
    const dir = project(beads);
    const inputs = Object.keys(beads).map((id) => ({ bead: id, branchFile: "main", text: fs.readFileSync(path.join(dir, ".beads", "tasks", id, "main.yaml"), "utf8") }));
    const texts = Object.fromEntries(inputs.map((i) => [i.bead, i.text]));
    return { beads: buildState(inputs, [], { nowMs: NOW }).beads, texts };
  };

  it("o campo manda: um shortLink, uma lista, e a ausência", () => {
    const { beads, texts } = stateOf({ "api-um": { trello: '"AAAA1111"' }, "api-lista": { trello: '["AAAA1111", "BBBB2222"]' }, "api-nada": {} });
    const by = Object.fromEntries(linkBeads(beads, texts).map((b) => [b.id, b]));
    expect(by["api-um"]).toMatchObject({ links: ["AAAA1111"], soEmProsa: false, forasteiros: [], parcial: false });
    expect(by["api-lista"]).toMatchObject({ links: ["AAAA1111", "BBBB2222"], soEmProsa: false });
    expect(by["api-nada"]).toMatchObject({ links: [], soEmProsa: false, forasteiros: [] });
  });

  it("só em prosa: o link vem do texto, e é dívida de vínculo", () => {
    const { beads, texts } = stateOf({ "api-prosa": { note: "Origem: Trello card https://trello.com/c/HHHH8888 ('x'). Também https://trello.com/c/HHHH8888/12-x" } });
    expect(linkBeads(beads, texts)[0]).toMatchObject({ links: ["HHHH8888"], soEmProsa: true, forasteiros: [] });
  });

  it("campo preenchido pela metade: o texto cita card que a lista não tem", () => {
    const { beads, texts } = stateOf({ "api-metade": { trello: '"IIII9999"', note: "também https://trello.com/c/JJJJ0000 e https://trello.com/c/IIII9999" } });
    expect(linkBeads(beads, texts)[0]).toMatchObject({ links: ["IIII9999"], soEmProsa: false, forasteiros: ["JJJJ0000"] });
  });

  it("a prosa é caçada no bead inteiro: o intake antigo vale mesmo depois do resumo da conclusão", () => {
    const intake = `title: "T"\ncreated_at: "2026-10-01T10:00:00Z"\nentries:\n  - at: "2026-10-01T10:00:00Z"\n    note: "Origem: https://trello.com/c/KKKK1234"\n`;
    const done = `entries:\n  - at: "2026-10-03T10:00:00Z"\n    status: "completed"\n    context_summary: "Feito."\n`;
    const inputs = [
      { bead: "api-x", branchFile: "main", text: intake },
      { bead: "api-x", branchFile: "feat-y", text: done },
    ];
    const texts = { "api-x": `${intake}\n${done}` };
    expect(linkBeads(buildState(inputs, [], { nowMs: NOW }).beads, texts)[0]).toMatchObject({ status: "completed", links: ["KKKK1234"], soEmProsa: true });
  });

  it("trello_scope: partial vira parcial", () => {
    const { beads, texts } = stateOf({ "api-p": { trello: '"AAAA1111"', scope: "partial" } });
    expect(linkBeads(beads, texts)[0]!.parcial).toBe(true);
  });
});

// ── A conferência, de ponta a ponta (cliente injetado) ───────────────────────

describe("main — as quatro divergências e a dívida de vínculo", () => {
  const ARGS = ["--board", "B", "--label", "MESA", "--ignore", "certid", "--json"];

  it("devolve cada classe com o card e a bead certos", async () => {
    const dir = project(BEADS);
    const r = await run(ARGS, dir, { trello: fakeTrello().client });
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out);
    expect(idsOf(j.cardAdiantado)).toEqual(["Card adiantado"]);
    expect(j.cardAdiantado[0]).toMatchObject({ url: "https://trello.com/c/AAAA1111", lista: "FINALIZADO" });
    expect(j.cardAdiantado[0].beads.map((b: any) => `${b.id}:${b.status}`)).toEqual(["api-adiantado:in_progress"]);
    expect(idsOf(j.escopoParcial)).toEqual(["Card parcial"]);
    expect(idsOf(j.cardAtrasado)).toEqual(["Card atrasado"]);
    expect(j.cardAtrasado[0].beads.map((b: any) => b.id)).toEqual(["api-atrasado"]);
    // sem bead, do projeto (etiqueta), fora o catálogo (--ignore) e o card de outro time
    expect(idsOf(j.semBead)).toEqual(["Card novo na fila", "Card MESA no backlog", "Card esquecido"]);
    expect(idsOf(j.soEmProsa)).toEqual(["api-prosa"]);
    expect(idsOf(j.campoIncompleto)).toEqual(["api-metade"]);
    expect(j.campoIncompleto[0]).toMatchObject({ links: ["IIII9999"], forasteiros: ["JJJJ0000"] });
    expect(j.cobertura).toEqual({ vivasComCard: 4, vivas: 5, concluidasComCard: 1, concluidas: 1 });
    expect(j.invalidos).toEqual([]);
  });

  it("o vínculo só em prosa conta como vínculo; o campo incompleto não — e o bloco METADE é quem explica o 'sem bead'", async () => {
    const j = JSON.parse((await run(ARGS, project(BEADS), { trello: fakeTrello().client })).out);
    // 'Card só em prosa' tem bead (o fallback do texto) e sai só como dívida de vínculo.
    expect(idsOf(j.semBead)).not.toContain("Card só em prosa");
    // 'Card esquecido' (JJJJ0000) é citado em texto por uma bead cujo campo lista só IIII9999: o campo manda,
    // então o card sai como "sem bead" — o falso positivo semanal que o bloco METADE existe para apontar.
    expect(idsOf(j.semBead)).toContain("Card esquecido");
    expect(j.campoIncompleto[0].forasteiros).toEqual(["JJJJ0000"]);
  });

  it("--queue estreita ao intake; --queue e --label juntos exigem os dois", async () => {
    const dir = project(BEADS);
    const queue = JSON.parse((await run(["--board", "B", "--queue", "L1", "--json"], dir, { trello: fakeTrello().client })).out);
    expect(idsOf(queue.semBead)).toEqual(["Card novo na fila"]);
    const ambos = JSON.parse((await run(["--board", "B", "--queue", "L1,L2", "--label", "MESA", "--ignore", "certid", "--json"], dir, { trello: fakeTrello().client })).out);
    expect(idsOf(ambos.semBead)).toEqual(["Card novo na fila", "Card MESA no backlog"]);
    const soBacklog = JSON.parse((await run(["--board", "B", "--queue", "L2", "--label", "MESA", "--json"], dir, { trello: fakeTrello().client })).out);
    expect(idsOf(soBacklog.semBead)).toEqual(["Certidão negativa de débitos", "Card MESA no backlog"]); // sem --ignore o catálogo volta
  });

  it("--done-lists decide o que é 'pronto'", async () => {
    const dir = project({ "api-x": { status: "in_progress", trello: '"DDDD4444"' } });
    const padrao = JSON.parse((await run(["--board", "B", "--queue", "L1", "--json"], dir, { trello: fakeTrello().client })).out);
    expect(padrao.cardAdiantado).toEqual([]);
    const troca = JSON.parse((await run(["--board", "B", "--queue", "L1", "--done-lists", "^MESA to-do$", "--json"], dir, { trello: fakeTrello().client })).out);
    expect(idsOf(troca.cardAdiantado)).toEqual(["Card novo na fila"]);
  });

  it("uma lista que não é de pronto nunca esconde o card: 'aberto' é tudo que não é pronto", async () => {
    const dir = project({ "api-novo": { status: "completed", trello: '"DDDD4444"' } });
    const lists = [...LISTS, { id: "L9", name: "Lista criada ontem" }];
    const cards = [{ name: "Card em lista nova", shortLink: "DDDD4444", idList: "L9", labels: MESA }];
    const j = JSON.parse((await run(["--board", "B", "--label", "MESA", "--json"], dir, { trello: fakeTrello(lists, cards).client })).out);
    expect(idsOf(j.cardAtrasado)).toEqual(["Card em lista nova"]);
  });

  it("pede ao Trello as listas e os cards do quadro certo, com os campos que lê", async () => {
    const t = fakeTrello();
    await run(ARGS, project(BEADS), { trello: t.client });
    expect(t.calls).toEqual([
      { path: "/boards/B/lists", params: { fields: "name" } },
      { path: "/boards/B/cards", params: { fields: "name,shortLink,idList,labels" } },
    ]);
  });

  it("o relatório em texto traz um bloco por classe, a contagem e a cobertura", async () => {
    const r = await run(["--board", "B", "--label", "MESA", "--ignore", "certid"], project(BEADS), { trello: fakeTrello().client });
    expect(r.code).toBe(0);
    for (const titulo of [
      "=== Bead VIVA, card já dado como pronto — decidir quem está certo (1) ===",
      "=== Card pronto com bead viva, já explicado (trello_scope: partial) — só conferir se ainda vale (1) ===",
      "=== Bead CONCLUÍDA, card ainda na fila — mover e comentar no card (1) ===",
      "=== Card aberto SEM bead (com a etiqueta /MESA/) — intake pendente, ou aguardando resposta da equipe (3) ===",
      "=== Vínculo só em prosa",
      "=== Campo `trello` preenchido pela METADE",
      "=== Cobertura do vínculo ===",
    ]) expect(r.out, titulo).toContain(titulo);
    expect(r.out).toContain("https://trello.com/c/AAAA1111 [FINALIZADO]");
    expect(r.out).toContain("api-adiantado (in_progress)");
    expect(r.out).toContain("api-metade (pending) tem [IIII9999] e cita JJJJ0000");
    expect(r.out).toContain("beads vivas:      4/5 com card");
    expect(r.out).toContain("beads concluídas: 1/1 com card");
  });

  it("bloco vazio diz 'nada'", async () => {
    const r = await run(["--board", "B", "--queue", "L4"], project({}), { trello: fakeTrello([], []).client });
    expect(r.out).toMatch(/=== Bead VIVA.*\(0\) ===\n {2}nada/);
  });

  // QA B-A2: um id de --queue errado (ou uma etiqueta que não casa nada) dava falso verde: o filtro
  // não pega card nenhum e o bloco "sem bead" sai vazio, igual a um quadro em dia. As listas e os cards
  // já estão em memória: o aviso é de graça.
  it("--queue com um id que não é de lista deste quadro: avisa em stderr, com as listas que existem, e confere o resto", async () => {
    const r = await run(["--board", "B", "--queue", "L1,LISTA-ERRADA", "--json"], project(BEADS), { trello: fakeTrello().client });
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/--queue: LISTA-ERRADA não é id de lista deste quadro/);
    expect(r.err).toMatch(/L1 MESA to-do/);
    expect(r.err).not.toMatch(/L1,/); // o id certo não é acusado
    expect(idsOf(JSON.parse(r.out).semBead)).toEqual(["Card novo na fila"]);
  });

  it("--label que não casa a etiqueta de card nenhum do quadro: avisa que o filtro não pega nada", async () => {
    const r = await run(["--board", "B", "--label", "^MESSA$", "--json"], project(BEADS), { trello: fakeTrello().client });
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/--label \/\^MESSA\$\/: nenhum card deste quadro tem etiqueta com esse nome/);
    expect(JSON.parse(r.out).semBead).toEqual([]);
  });

  it("filtros certos: nenhum aviso (stderr vazio), no texto e no JSON", async () => {
    for (const extra of [[], ["--json"]]) {
      const r = await run(["--board", "B", "--queue", "L1", "--label", "^MESA$", ...extra], project(BEADS), { trello: fakeTrello().client });
      expect(r.code).toBe(0);
      expect(r.err).toBe("");
    }
  });

  it("o aviso de --label também dispara no quadro sem nenhuma etiqueta", async () => {
    const semEtiqueta = CARDS.map((c) => ({ ...c, labels: [] }));
    const r = await run(["--board", "B", "--label", "MESA"], project(BEADS), { trello: fakeTrello(LISTS, semEtiqueta).client });
    expect(r.err).toMatch(/--label .*nenhum card deste quadro tem etiqueta/);
  });

  it("bead inválida fica FORA da conferência e é dita, em vez de sumir calada", async () => {
    const dir = project(BEADS);
    fs.mkdirSync(path.join(dir, ".beads", "tasks", "api-torta"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".beads", "tasks", "api-torta", "main.yaml"), beadFile("api-torta", { trello: '"https://trello.com/c/XXXX"' }));
    const r = await run(["--board", "B", "--label", "MESA", "--json"], dir, { trello: fakeTrello().client });
    expect(JSON.parse(r.out).invalidos).toEqual(["api-torta"]);
    const text = await run(["--board", "B", "--label", "MESA"], dir, { trello: fakeTrello().client });
    expect(text.out).toMatch(/1 bead\(s\) inválido\(s\) ficaram FORA da conferência: api-torta/);
  });

  it("repo sem .beads/tasks: confere sem erro, com tudo vazio", async () => {
    const dir = project({});
    const r = await run(["--board", "B", "--queue", "L1", "--json"], dir, { trello: fakeTrello().client });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).cobertura).toEqual({ vivasComCard: 0, vivas: 0, concluidasComCard: 0, concluidas: 0 });
  });
});

// ── Credenciais, rede e o modelo antigo ──────────────────────────────────────

describe("main — credenciais, falhas de rede e repo legado", () => {
  const ok = (urls: string[] = []) =>
    (async (u: string) => {
      urls.push(u);
      const p = new URL(u).pathname;
      return { ok: true, json: async () => (p.endsWith("/lists") ? LISTS : CARDS) };
    }) as any;

  it("sem credencial: sai com 2 e não chama a rede", async () => {
    const urls: string[] = [];
    const r = await run(["--board", "B", "--queue", "L1"], project(BEADS), { fetch: ok(urls) });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/TRELLO_API_KEY\/TRELLO_TOKEN ausentes/);
    expect(urls).toEqual([]);
  });

  it("credenciais do ambiente ou do .env da raiz; a chave e o token só vão na query da API", async () => {
    const urls: string[] = [];
    const doEnv = await run(["--board", "B", "--queue", "L1", "--json"], project(BEADS), { env: { TRELLO_API_KEY: "kk", TRELLO_TOKEN: "tt-SEGREDO" }, fetch: ok(urls) });
    expect(doEnv.code, doEnv.err).toBe(0);
    expect(urls).toHaveLength(2);
    expect(new URL(urls[0]!).searchParams.get("token")).toBe("tt-SEGREDO");
    expect(doEnv.out + doEnv.err).not.toContain("tt-SEGREDO");

    const dotenv = project(BEADS, { ".env": 'TRELLO_API_KEY=kk\nTRELLO_TOKEN="tt-DO-DOTENV"\n' });
    const urls2: string[] = [];
    const r = await run(["--board", "B", "--queue", "L1", "--json"], dotenv, { fetch: ok(urls2) });
    expect(r.code, r.err).toBe(0);
    expect(new URL(urls2[0]!).searchParams.get("token")).toBe("tt-DO-DOTENV");
    expect(r.out + r.err).not.toContain("tt-DO-DOTENV");
  });

  it("401 e rede fora: sai com 1, diz o caminho e o status, e nunca o token", async () => {
    const env = { TRELLO_API_KEY: "kk", TRELLO_TOKEN: "tt-SEGREDO" };
    const dir = project(BEADS);
    const http = await run(["--board", "B", "--queue", "L1"], dir, { env, fetch: (async () => ({ ok: false, status: 401 })) as any });
    expect(http.code).toBe(1);
    expect(http.err).toBe("Trello /boards/B/lists → HTTP 401");
    const net = await run(["--board", "B", "--queue", "L1"], dir, {
      env,
      fetch: (async (u: string) => {
        throw new Error(`falhou ${u}`);
      }) as any,
    });
    expect(net.code).toBe(1);
    expect(net.err).not.toContain("tt-SEGREDO");
  });

  it("uso errado: 2, com a mensagem e o uso; --help: 0 e só o uso", async () => {
    const dir = project({});
    const bad = await run(["--board", "B"], dir, { trello: fakeTrello().client });
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/--queue.*--label/);
    expect(bad.err).toContain("uso: node aiteam/scripts/beads-trello-reconcile.mjs");
    const help = await run(["--help"], dir);
    expect(help.code).toBe(0);
    expect(help.out).toContain("uso: node aiteam/scripts/beads-trello-reconcile.mjs");
    expect(help.err).toBe("");
  });

  it("repo no modelo antigo (active.yaml rastreado): recusa com 2 e manda migrar — nunca lê o active.yaml", async () => {
    const s = makeSandbox();
    try {
      s.write(".beads/active.yaml", "version: '1.0'\nproject: demo\ntasks:\n  - id: api-velho\n    title: Velho\n    status: pending\n    trello: AAAA1111\n");
      s.git("add", "-A");
      s.git("commit", "-q", "-m", "legado");
      const r = await run(["--board", "B", "--queue", "L1"], s.dir, { trello: fakeTrello().client });
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/modo legado/);
      expect(r.err).toMatch(/migre antes/);
      expect(r.out).toBe("");
    } finally {
      s.cleanup();
    }
  });
});

// ── classify e renderReport, sem I/O ─────────────────────────────────────────

describe("classify — o filtro do projeto e o --ignore só mexem no 'sem bead'", () => {
  const options = (o: Partial<Parameters<typeof classify>[0]["options"]> = {}) => ({ queue: [], label: null, ignore: null, doneLists: /finalizado/i, ...o });
  const listName = new Map(LISTS.map((l) => [l.id, l.name]));
  const bead = (b: Partial<ReturnType<typeof linkBeads>[number]> & { id: string }) => ({ status: "in_progress", links: [], soEmProsa: false, forasteiros: [], parcial: false, ...b });

  it("o --ignore não esconde card que TEM bead (só o catálogo sem bead)", () => {
    const cards = [{ name: "Certidão X", shortLink: "AAAA1111", idList: "L3" }];
    const r = classify({ cards, listName, beads: [bead({ id: "api-a", links: ["AAAA1111"] })], options: options({ queue: ["L3"], ignore: /certid/i }) });
    expect(idsOf(r.cardAdiantado)).toEqual(["Certidão X"]);
  });

  it("basta uma bead viva de escopo integral para o card estar adiantado de verdade", () => {
    const cards = [{ name: "C", shortLink: "AAAA1111", idList: "L3" }];
    const r = classify({
      cards,
      listName,
      beads: [bead({ id: "api-a", links: ["AAAA1111"], parcial: true }), bead({ id: "api-b", links: ["AAAA1111"] })],
      options: options({ queue: ["L1"] }),
    });
    expect(idsOf(r.cardAdiantado)).toEqual(["C"]);
    expect(r.escopoParcial).toEqual([]);
  });

  it("card em lista de pronto com a bead concluída está em ordem: nenhuma divergência", () => {
    const cards = [{ name: "C", shortLink: "AAAA1111", idList: "L3" }];
    const r = classify({ cards, listName, beads: [bead({ id: "api-a", status: "completed", links: ["AAAA1111"] })], options: options({ queue: ["L1"] }) });
    expect([r.cardAdiantado, r.escopoParcial, r.cardAtrasado, r.semBead].map((x) => x.length)).toEqual([0, 0, 0, 0]);
  });

  it("renderReport sem filtro descrito e sem inválidas não inventa parênteses nem aviso", () => {
    const r = classify({ cards: [], listName, beads: [], options: options({ queue: ["L1"] }) });
    const text = renderReport(r).join("\n");
    expect(text).toContain("=== Card aberto SEM bead — intake pendente, ou aguardando resposta da equipe (0) ===");
    expect(text).not.toContain("⚠");
  });
});

// ── A CLI (subprocesso, sem rede) ────────────────────────────────────────────

describe("aiteam/scripts/beads-trello-reconcile.mjs — a CLI", () => {
  const script = path.resolve(repoRoot(), "aiteam", "scripts", "beads-trello-reconcile.mjs");
  const cli = (args: string[], cwd: string) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd,
      env: { ...process.env, TRELLO_API_KEY: "", TRELLO_TOKEN: "" },
      encoding: "utf8",
      windowsHide: true,
    });

  it("--help sai com 0; uso errado, com 2; credencial ausente, com 2 — sem rede em nenhum", () => {
    const dir = project({});
    const help = cli(["--help"], dir);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("uso: node aiteam/scripts/beads-trello-reconcile.mjs");
    const bad = cli([], dir);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/--board é obrigatório/);
    const semCredencial = cli(["--board", "B", "--queue", "L1"], dir);
    expect(semCredencial.status).toBe(2);
    expect(semCredencial.stderr).toMatch(/ausentes/);
  });
});
