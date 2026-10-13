import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as vm from "node:vm";
import { describe, expect, it } from "vitest";

// O front-end do Bead Board (Kanban e sala) mostra o que outra branch ou worktree
// fez nos beads — ainda não mergeado — sem misturar com o estado desta branch
// (aiteam/docs/beads-schema.md §13). Os scripts inline de index.html e room.html
// rodam aqui num vm com um DOM mínimo: o que importa é o HTML gerado e as
// classes das mesas, não o layout.

const BOARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "tools", "bead_board");

interface FakeEl {
  tag: string;
  className: string;
  dataset: Record<string, string>;
  innerHTML: string;
  innerText: string;
  textContent: any;
  style: Record<string, string>;
  value: string;
  id: string;
  children: FakeEl[];
  classes: Set<string>;
  [k: string]: any;
}

function makeEl(tag = "div", id = ""): FakeEl {
  const classes = new Set<string>();
  const attrs = new Map<string, string>();
  let html = "";
  let text = "";
  const el: FakeEl = {
    tag,
    id,
    className: "",
    dataset: {},
    // como no DOM de verdade: innerHTML = '' esvazia os filhos e textContent vira texto
    get innerHTML() {
      return html;
    },
    set innerHTML(v: string) {
      html = String(v);
      if (html === "") el.children.length = 0;
    },
    innerText: "",
    get textContent() {
      return text;
    },
    set textContent(v: unknown) {
      text = String(v ?? "");
    },
    style: {},
    value: "",
    children: [],
    classes,
    appendChild(c: FakeEl) {
      el.children.push(c);
    },
    prepend(c: FakeEl) {
      el.children.unshift(c);
    },
    addEventListener() {},
    setAttribute(k: string, v: string) {
      attrs.set(k, String(v));
    },
    getAttribute: (k: string) => attrs.get(k) ?? null,
    getBoundingClientRect: () => ({ top: 0, left: 0 }),
    querySelector(sel: string) {
      return sel === ".avatar" ? avatars.get(el) : null;
    },
    classList: {
      add: (...c: string[]) => c.forEach((x) => classes.add(x)),
      remove: (...c: string[]) => c.forEach((x) => classes.delete(x)),
      contains: (c: string) => classes.has(c),
      toggle: (c: string, force?: boolean) => {
        const on = force ?? !classes.has(c);
        if (on) classes.add(c);
        else classes.delete(c);
        return on;
      },
    },
  };
  return el;
}
const avatars = new WeakMap<object, FakeEl>();

function inlineScript(file: string): string {
  const html = readFileSync(path.join(BOARD, file), "utf8");
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  return scripts.at(-1)!;
}

function load(file: string, state: unknown, desks: FakeEl[] = []) {
  const els = new Map<string, FakeEl>();
  const get = (id: string) => {
    if (!els.has(id)) {
      const el = makeEl("div", id);
      if (id === "elsewhere-note") el.hidden = true; // como na marcação: o aviso nasce oculto
      els.set(id, el);
    }
    return els.get(id)!;
  };
  desks.forEach((d) => els.set(d.id, d));
  const document = {
    body: makeEl("body"),
    getElementById: get,
    createElement: (tag: string) => makeEl(tag),
    querySelectorAll: (sel: string) => (sel === ".hotspot-desk" ? desks : sel === ".hotspot-desk.idle" ? desks.filter((d) => d.classes.has("idle")) : []),
    querySelector: () => makeEl(),
    addEventListener() {},
  };
  const sandbox: Record<string, unknown> = {
    document,
    window: { location: { search: "" }, parent: { postMessage() {} }, addEventListener() {} },
    URLSearchParams,
    localStorage: { getItem: () => null, setItem() {} },
    jsyaml: { load: (s: string) => JSON.parse(s) },
    marked: { parse: (s: string) => s },
    fetch: async () => ({ json: async () => state }),
    setInterval: () => 0,
    setTimeout: () => 0,
    console,
    Math,
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(inlineScript(file), ctx);
  return { ctx, els, get, run: (code: string) => vm.runInContext(code, ctx) };
}

const yaml = (tasks: unknown[]) => JSON.stringify({ project: "demo", session: { cost_accumulated_usd: 0, budget_usd: 2, current_task_phase: "implement" }, tasks });

const fonte = (origem: string, extra: Record<string, unknown> = {}) => ({ arquivo: "x", tipo: "local", ref: "feat/x", sha7: "abc1234", nao_commitado: false, origem, ...extra });

describe("Kanban (index.html) — cartões de outras branches", () => {
  const state = {
    branch: "main",
    index: "",
    yaml: yaml([
      { id: "api-a", status: "in_progress", title: "A local" },
      { id: "ui-b", status: "pending", title: "B local" },
    ]),
    elsewhere: [
      {
        id: "orch-novo",
        title: 'Novo <img src=x onerror="alert(1)">',
        aqui: null,
        la: { status: "in_progress", stage: "implement", blockers: [], updated_at: "t" },
        fontes: [fonte("worktree-agent-x (local abc1234)")],
      },
      {
        id: "api-a",
        title: "A local",
        aqui: { status: "in_progress", stage: null, blockers: [], updated_at: "t" },
        la: { status: "blocked", stage: null, blockers: ["api-z"], updated_at: "t" },
        fontes: [fonte("feat/y (worktree, não commitado)", { tipo: "worktree", nao_commitado: true }), fonte("feat/y (local abc1234)")],
      },
      { id: "orch-feito", title: "Já concluído lá", aqui: null, la: { status: "completed", stage: null, blockers: [], updated_at: "t" }, fontes: [fonte("feat/z (local def5678)")] },
    ],
  };

  it("bead novo vira cartão-fantasma na coluna do estado de lá, com a origem e 'não mergeado'", async () => {
    const ui = load("index.html", state);
    await ui.run("fetchState()");
    const progress = ui.get("col-progress").children;
    const ghost = progress.find((c) => c.className.includes("ghost"))!;
    expect(ghost).toBeTruthy();
    expect(ghost.innerHTML).toContain("#orch-novo");
    expect(ghost.innerHTML).toContain("↗ worktree-agent-x (local abc1234) · não mergeado (implement)");
    expect(ghost.innerHTML).not.toContain("<img"); // o título de outra branch passa por esc()
    expect(ghost.innerHTML).toContain("&lt;img");
    expect(ui.get("col-completed").children.some((c) => c.className.includes("ghost") && c.innerHTML.includes("#orch-feito"))).toBe(true);
    expect(ui.get("col-pending").children.some((c) => c.className.includes("ghost"))).toBe(false);
  });

  it("o cartão local ganha o selo quando o estado lá é outro, e não vira fantasma", async () => {
    const ui = load("index.html", state);
    await ui.run("fetchState()");
    const local = ui.get("col-progress").children.find((c) => !c.className.includes("ghost") && c.innerHTML.includes("#api-a"))!;
    expect(local.innerHTML).toContain("↗ blocked em feat/y (worktree, não commitado) +1 · não mergeado");
    const ghosts = [...ui.get("col-progress").children, ...ui.get("col-pending").children, ...ui.get("col-completed").children].filter((c) => c.className.includes("ghost"));
    expect(ghosts.map((g) => /#([\w-]+)/.exec(g.innerHTML)![1])).toEqual(["orch-feito", "orch-novo"].sort((a, b) => ghosts.findIndex((g) => g.innerHTML.includes(`#${a}`)) - ghosts.findIndex((g) => g.innerHTML.includes(`#${b}`))));
  });

  // B-R3: o bead concluído aqui (fora do active.yaml) e reaberto em outra branch tem
  // `aqui` preenchido, mas não é cartão local: ele vira fantasma, dizendo o que é aqui.
  it("concluído aqui e reaberto lá vira fantasma, com 'aqui: concluído'", async () => {
    const reopened = {
      id: "api-done",
      title: "Concluído aqui, reaberto lá",
      aqui: { status: "completed", stage: null, blockers: [], updated_at: "t" },
      la: { status: "in_progress", stage: "implement", blockers: [], updated_at: "t" },
      fontes: [fonte("feat/reabre (local abc1234)")],
    };
    const ui = load("index.html", { ...state, elsewhere: [...state.elsewhere, reopened] });
    await ui.run("fetchState()");
    const ghost = ui.get("col-progress").children.find((c) => c.className.includes("ghost") && c.innerHTML.includes("#api-done"))!;
    expect(ghost).toBeTruthy();
    expect(ghost.innerHTML).toContain("↗ feat/reabre (local abc1234) · não mergeado (implement)");
    expect(ghost.innerHTML).toContain("aqui: concluído");
    // o bead novo (aqui: null) não ganha essa frase
    const novo = ui.get("col-progress").children.find((c) => c.className.includes("ghost") && c.innerHTML.includes("#orch-novo"))!;
    expect(novo.innerHTML).not.toContain("aqui:");
  });

  // O selo do cartão local dizia só o status de lá: quando o que mudou lá foi o `stage` (o status
  // é o mesmo daqui), ele não dizia nada de novo. Agora o stage entra ao lado do status quando
  // difere do daqui — de `aqui → lá` se o daqui tem stage, só o de lá se não tem.
  it("o selo do cartão local mostra o stage de lá quando ele difere do daqui", async () => {
    const st = (id: string, aqui: { status: string; stage: string | null }, la: { status: string; stage: string | null }) => ({
      id,
      title: id,
      aqui: { ...aqui, blockers: [], updated_at: "t" },
      la: { ...la, blockers: [], updated_at: "t" },
      fontes: [fonte("feat/y (local abc1234)")],
    });
    const ui = load("index.html", {
      branch: "main",
      index: "",
      yaml: yaml([
        { id: "api-a", status: "in_progress", title: "A" },
        { id: "api-b", status: "in_progress", title: "B" },
        { id: "api-c", status: "in_progress", title: "C" },
        { id: "api-d", status: "pending", title: "D" },
        { id: "api-e", status: "in_progress", title: "E" },
      ]),
      elsewhere: [
        st("api-a", { status: "in_progress", stage: "implement" }, { status: "in_progress", stage: "review" }), // só o stage mudou
        st("api-b", { status: "in_progress", stage: null }, { status: "in_progress", stage: "review" }), // daqui não tem stage
        st("api-c", { status: "in_progress", stage: "review" }, { status: "blocked", stage: "review" }), // mesmo stage: só o status
        st("api-d", { status: "pending", stage: null }, { status: "in_progress", stage: "<img src=x onerror=alert(1)>" }), // stage é dado de lá
        st("api-e", { status: "in_progress", stage: "implement" }, { status: "completed", stage: "" }), // sem stage lá: nada a mostrar
      ],
    });
    await ui.run("fetchState()");
    const cards = [...ui.get("col-progress").children, ...ui.get("col-pending").children].filter((c) => !c.className.includes("ghost"));
    const badge = (id: string) => /<span class="origin-badge">(.*?)<\/span>/.exec(cards.find((c) => c.innerHTML.includes(`#${id}`))!.innerHTML)![1];
    expect(badge("api-a")).toBe("↗ in_progress (implement → review) em feat/y (local abc1234) · não mergeado");
    expect(badge("api-b")).toBe("↗ in_progress (review) em feat/y (local abc1234) · não mergeado");
    expect(badge("api-c")).toBe("↗ blocked em feat/y (local abc1234) · não mergeado");
    expect(badge("api-d")).toBe("↗ in_progress (&lt;img src=x onerror=alert(1)&gt;) em feat/y (local abc1234) · não mergeado");
    expect(badge("api-e")).toBe("↗ completed em feat/y (local abc1234) · não mergeado");
    expect(cards.some((c) => c.innerHTML.includes("<img"))).toBe(false);
  });

  it("os contadores são só do estado desta branch; sem elsewhere nada muda", async () => {
    const ui = load("index.html", state);
    await ui.run("fetchState()");
    expect(ui.get("c-progress").textContent).toBe("1");
    expect(ui.get("c-pending").textContent).toBe("1");
    expect(ui.get("c-completed").textContent).toBe("0");

    const plain = load("index.html", { ...state, elsewhere: [] });
    await plain.run("fetchState()");
    const all = [...plain.get("col-progress").children, ...plain.get("col-pending").children, ...plain.get("col-completed").children];
    expect(all.some((c) => c.className.includes("ghost") || c.innerHTML.includes("não mergeado"))).toBe(false);
    // servidor antigo, sem o campo: também funciona
    const { elsewhere: _drop, ...old } = state;
    const legacy = load("index.html", old);
    await legacy.run("fetchState()");
    expect(legacy.get("c-progress").textContent).toBe("1");
  });

  it("a busca também filtra os fantasmas", async () => {
    const ui = load("index.html", state);
    await ui.run("fetchState()");
    ui.get("searchInput").value = "feito";
    ui.run("renderBoard()");
    const ghosts = [...ui.get("col-progress").children, ...ui.get("col-pending").children, ...ui.get("col-completed").children].filter((c) => c.className.includes("ghost"));
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0]!.innerHTML).toContain("#orch-feito");
  });
});

// O /api/state avisa quando a agregação de outras branches ficou parcial (o prazo estourou) ou
// está indisponível (o comando falhou, ou node/beads.mjs não existem). Sem aviso, a lista vazia
// de `elsewhere` seria igual a "nada em outras branches". O indicador é discreto: some quando
// está tudo certo, e o texto é fixo (nada que vem do servidor vira HTML).
describe.each(["index.html", "room.html"])("%s — indicador de agregação parcial ou indisponível", (file) => {
  const state = (extra: Record<string, unknown> = {}) => ({
    branch: "main",
    index: "",
    yaml: yaml([{ id: "api-a", status: "pending", title: "A" }]),
    elsewhere: [],
    ...extra,
  });
  const noteOf = async (extra: Record<string, unknown> = {}) => {
    const ui = load(file, state(extra));
    await ui.run("fetchState()");
    return ui.get("elsewhere-note");
  };

  it("sem aviso quando a agregação está inteira, e com servidor antigo (sem os campos)", async () => {
    for (const extra of [{ elsewhere_available: true, elsewhere_partial: false, elsewhere_stale: false }, {}]) {
      const note = await noteOf(extra);
      expect(note.hidden).toBe(true);
      expect(note.textContent).toBe("");
    }
  });

  it("parcial: '↗ agregação parcial', com a explicação no title", async () => {
    const note = await noteOf({ elsewhere_available: true, elsewhere_partial: true });
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe("↗ agregação parcial");
    expect(note.title).toContain("incompleta");
  });

  it("indisponível: '↗ agregação indisponível', e vence o parcial", async () => {
    const note = await noteOf({ elsewhere_available: false, elsewhere_partial: true });
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe("↗ agregação indisponível");
    expect(note.title).toContain("nada de lá");
  });

  it("o aviso some quando a agregação volta ao normal", async () => {
    const s = state({ elsewhere_available: false });
    const ui = load(file, s);
    await ui.run("fetchState()");
    expect(ui.get("elsewhere-note").hidden).toBe(false);
    Object.assign(s, { elsewhere_available: true });
    await ui.run("fetchState()");
    expect(ui.get("elsewhere-note").hidden).toBe(true);
    expect(ui.get("elsewhere-note").textContent).toBe("");
  });

  it("valor velho sozinho não gera aviso (acontece a cada 15 s); com aviso, o title diz que é a última leitura", async () => {
    expect((await noteOf({ elsewhere_available: true, elsewhere_partial: false, elsewhere_stale: true })).hidden).toBe(true);
    const note = await noteOf({ elsewhere_available: true, elsewhere_partial: true, elsewhere_stale: true });
    expect(note.title).toContain("renovando");
  });

  // Indisponível + velho: o valor "velho" é a própria leitura indisponível (lista vazia). O title
  // dizia "nada de lá é mostrado. Mostrando a última leitura…", que se contradiz.
  it("indisponível e velho: o title não diz que mostra a última leitura (nada de lá é mostrado), diz que tenta de novo", async () => {
    const note = await noteOf({ elsewhere_available: false, elsewhere_partial: false, elsewhere_stale: true });
    expect(note.textContent).toBe("↗ agregação indisponível");
    expect(note.title).toContain("nada de lá é mostrado");
    expect(note.title).not.toContain("Mostrando a última leitura");
    expect(note.title).toContain("de novo em segundo plano");
  });

  // O aviso fica numa live region (role="status"): reescrever o textContent a cada poll de 2 s
  // pode fazer o leitor de tela reanunciá-lo. Só escreve quando o conteúdo muda — e nem o texto é
  // reescrito quando só o title muda (o "velho" alterna a cada 15 s).
  const watched = (ui: ReturnType<typeof load>) => {
    const el = ui.get("elsewhere-note");
    const writes = { text: 0, hidden: 0, title: 0 };
    let text = el.textContent as string;
    let hidden = el.hidden as boolean;
    let title = (el.title ?? "") as string;
    Object.defineProperty(el, "textContent", { configurable: true, get: () => text, set: (v) => { writes.text++; text = String(v); } });
    Object.defineProperty(el, "hidden", { configurable: true, get: () => hidden, set: (v) => { writes.hidden++; hidden = v; } });
    Object.defineProperty(el, "title", { configurable: true, get: () => title, set: (v) => { writes.title++; title = String(v); } });
    return { el, writes };
  };
  const polls = async (ui: ReturnType<typeof load>, n = 3) => {
    for (let i = 0; i < n; i++) await ui.run("fetchState()");
  };

  it("só escreve no aviso quando o conteúdo muda: o poll de 2 s não reanuncia na live region", async () => {
    const s = state({ elsewhere_available: true, elsewhere_partial: true });
    const ui = load(file, s);
    const { el, writes } = watched(ui);
    await polls(ui);
    expect(el.textContent).toBe("↗ agregação parcial");
    expect(writes).toEqual({ text: 1, hidden: 1, title: 1 }); // 3 polls iguais, 1 escrita

    Object.assign(s, { elsewhere_available: false });
    await polls(ui);
    expect(el.textContent).toBe("↗ agregação indisponível");
    expect(writes.text).toBe(2); // parcial → indisponível: muda

    Object.assign(s, { elsewhere_available: true, elsewhere_partial: false });
    await polls(ui);
    expect(el.hidden).toBe(true);
    expect(el.textContent).toBe("");
    expect(writes.text).toBe(3); // voltou ao normal: limpa uma vez, e só
    await polls(ui);
    expect(writes.text).toBe(3);
  });

  it("sem aviso desde o início, nunca escreve: o hidden da marcação já vale", async () => {
    const ui = load(file, state({ elsewhere_available: true, elsewhere_partial: false }));
    const { writes } = watched(ui);
    await polls(ui, 5);
    expect(writes).toEqual({ text: 0, hidden: 0, title: 0 });
  });

  it("o 'velho' que alterna só muda o title: o texto da live region não é reescrito", async () => {
    const s = state({ elsewhere_available: true, elsewhere_partial: true, elsewhere_stale: false });
    const ui = load(file, s);
    const { el, writes } = watched(ui);
    await polls(ui, 2);
    Object.assign(s, { elsewhere_stale: true });
    await polls(ui, 2);
    expect(el.title).toContain("renovando"); // o title acompanha
    expect(writes.text).toBe(1); // o texto não
    Object.assign(s, { elsewhere_stale: false });
    await polls(ui, 2);
    expect(el.title).not.toContain("renovando");
    expect(writes.text).toBe(1);
  });

  it("a marcação traz o aviso oculto e como live region", () => {
    const html = readFileSync(path.join(BOARD, file), "utf8");
    expect(html).toMatch(/<div class="elsewhere-note" id="elsewhere-note" role="status" hidden><\/div>/);
  });

  it("só true e false de verdade valem: texto vindo do servidor não aciona nem entra no aviso", async () => {
    const note = await noteOf({ elsewhere_available: "false", elsewhere_partial: '<img src=x onerror="alert(1)">' });
    expect(note.hidden).toBe(true);
    expect(note.textContent).toBe("");
  });
});

// O README lista o que o /api/state devolve, em EN e PT: o payload ganhou `elsewhere` e
// `elsewhere_partial` (os beads de outras branches, não mergeados).
describe("README — o payload do /api/state", () => {
  it("as duas listas (EN e PT) citam elsewhere e elsewhere_partial", () => {
    const readme = readFileSync(path.resolve(BOARD, "..", "..", "README.md"), "utf8");
    const lines = readme.split("\n").filter((l) => l.includes("/api/state →"));
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(l).toContain("worktrees, yaml, index, branch");
      expect(l).toContain("elsewhere");
      expect(l).toContain("elsewhere_partial");
    }
  });
});

describe("sala (room.html) — a mesa anima com ↗ quando o bead está in_progress em outra branch", () => {
  const deskIds = ["desk-frontend", "desk-backend", "desk-pm", "desk-orchestrator", "desk-data", "desk-sre", "desk-ux", "desk-devops", "desk-release", "desk-debug", "desk-qa"];
  const makeDesks = () =>
    deskIds.map((id) => {
      const d = makeEl("div", id);
      d.classes.add("idle");
      avatars.set(d, makeEl("div"));
      d.title = `${id} Node`;
      return d;
    });

  it("mesa trabalhando lá ganha working + elsewhere; a que só trabalha aqui não ganha a marca", async () => {
    const desks = makeDesks();
    const ui = load(
      "room.html",
      {
        yaml: yaml([{ id: "api-a", status: "in_progress", title: "A" }]),
        elsewhere: [
          { id: "ui-novo", title: "UI lá", aqui: null, la: { status: "in_progress", stage: null, blockers: [], updated_at: "t" }, fontes: [fonte("feat/ui (local abc1234)")] },
          { id: "qa-lá", title: "QA lá, mas só pending", aqui: null, la: { status: "pending", stage: null, blockers: [], updated_at: "t" }, fontes: [fonte("feat/qa (local def5678)")] },
        ],
      },
      desks
    );
    await ui.run("fetchState()");
    const by = (id: string) => desks.find((d) => d.id === id)!;
    expect([...by("desk-frontend").classes].sort()).toEqual(["elsewhere", "working"]);
    expect([...by("desk-backend").classes]).toEqual(["working"]);
    expect([...by("desk-qa").classes]).toEqual(["idle"]); // pending lá não anima a mesa
    expect(by("desk-backend").classes.has("elsewhere")).toBe(false);
  });

  it("o histórico da mesa lista o bead de lá como '↗ origem · não mergeado', com o texto escapado", async () => {
    const desks = makeDesks();
    const ui = load(
      "room.html",
      {
        yaml: yaml([]),
        elsewhere: [{ id: "ui-novo", title: "<script>alert(1)</script>", aqui: null, la: { status: "in_progress", stage: null, blockers: [], updated_at: "t" }, fontes: [fonte("feat/ui (local abc1234)")] }],
      },
      desks
    );
    await ui.run("fetchState()");
    ui.run("showHistory('desk-frontend', { stopPropagation() {} })");
    const html = ui.get("speechBubble").innerHTML;
    expect(html).toContain("↗");
    expect(html).toContain("feat/ui (local abc1234) · não mergeado");
    expect(html).toContain("ui-novo");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  // O bead que existe aqui e também em outra branch (estado diferente lá) entrava duas vezes no
  // histórico: a linha local e a ↗. Agora é uma linha só: a local (o estado desta branch), com a
  // marca de origem no lugar da segunda linha — como o selo do cartão local no Kanban.
  it("o bead que existe aqui e lá aparece uma vez no histórico, com a marca de origem", async () => {
    const desks = makeDesks();
    const ui = load(
      "room.html",
      {
        yaml: yaml([
          { id: "ui-a", status: "in_progress", title: "A local" },
          { id: "ui-b", status: "pending", title: "B local" },
        ]),
        elsewhere: [
          { id: "ui-a", title: "A local", aqui: { status: "in_progress", stage: null, blockers: [], updated_at: "t" }, la: { status: "blocked", stage: null, blockers: ["api-z"], updated_at: "t" }, fontes: [fonte("feat/y (local abc1234)"), fonte("feat/w (worktree, não commitado)", { tipo: "worktree" })] },
          { id: "ui-novo", title: "Só lá", aqui: null, la: { status: "in_progress", stage: null, blockers: [], updated_at: "t" }, fontes: [fonte("feat/n (local def5678)")] },
        ],
      },
      desks
    );
    await ui.run("fetchState()");
    ui.run("showHistory('desk-frontend', { stopPropagation() {} })");
    const html = ui.get("speechBubble").innerHTML;
    expect(html.match(/ui-a\b/g)).toHaveLength(1); // uma linha, não duas
    expect(html).toContain("↗ blocked em feat/y (local abc1234) +1 · não mergeado"); // a marca de origem fica, como no selo do Kanban
    expect(html).toContain("🔥"); // e a linha é a local: o estado desta branch (in_progress)
    expect(html).toContain("ui-b");
    expect(html).toContain("ui-novo"); // o bead que só existe lá segue como linha ↗
    expect(html).toContain("feat/n (local def5678) · não mergeado");
    // a marca ↗ da mesa não muda: vem do ui-novo, in_progress lá (o ui-a está blocked lá, e isso não marca)
    expect(desks.find((d) => d.id === "desk-frontend")!.classes.has("elsewhere")).toBe(true);
  });

  it("a marca de origem do bead local passa por esc(): origem e estado de outra branch são dado", async () => {
    const desks = makeDesks();
    const ui = load(
      "room.html",
      {
        yaml: yaml([{ id: "ui-a", status: "pending", title: "A local" }]),
        elsewhere: [{ id: "ui-a", title: "A", aqui: { status: "pending", stage: null, blockers: [], updated_at: "t" }, la: { status: "x<img src=x onerror=alert(1)>", stage: null, blockers: [], updated_at: "t" }, fontes: [fonte("feat/<b>y</b> (local abc1234)")] }],
      },
      desks
    );
    await ui.run("fetchState()");
    ui.run("showHistory('desk-frontend', { stopPropagation() {} })");
    const html = ui.get("speechBubble").innerHTML;
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>y");
    expect(html).toContain("&lt;img");
    expect(html).toContain("feat/&lt;b&gt;y&lt;/b&gt;");
    expect(html.match(/ui-a\b/g)).toHaveLength(1);
  });

  // Como o Kanban, que só põe o selo quando lá tem `la.status`: sem ele, a marca saía como `↗  em  ·`.
  it("sem la.status a linha local não ganha marca (nem '↗  em  ·'), e continua uma linha só", async () => {
    const desks = makeDesks();
    const ui = load(
      "room.html",
      {
        yaml: yaml([{ id: "ui-a", status: "in_progress", title: "A local" }]),
        elsewhere: [{ id: "ui-a", title: "A", aqui: { status: "in_progress", stage: null, blockers: [], updated_at: "t" }, la: { stage: null, blockers: [], updated_at: "t" }, fontes: [fonte("feat/y (local abc1234)")] }],
      },
      desks
    );
    await ui.run("fetchState()");
    ui.run("showHistory('desk-frontend', { stopPropagation() {} })");
    const html = ui.get("speechBubble").innerHTML;
    expect(html.match(/ui-a\b/g)).toHaveLength(1);
    expect(html).not.toContain("↗");
    expect(html).not.toMatch(/em\s+·/);
    expect(html).toContain("🔥"); // a linha local, como estava
  });

  it("sem o mesmo id aqui, nada muda: o bead de lá segue como linha ↗ própria", async () => {
    const desks = makeDesks();
    const ui = load("room.html", { yaml: yaml([{ id: "ui-b", status: "pending", title: "B local" }]), elsewhere: [{ id: "ui-x", title: "X lá", aqui: null, la: { status: "pending", stage: null, blockers: [], updated_at: "t" }, fontes: [fonte("feat/x (local abc1234)")] }] }, desks);
    await ui.run("fetchState()");
    ui.run("showHistory('desk-frontend', { stopPropagation() {} })");
    const html = ui.get("speechBubble").innerHTML;
    expect(html.match(/ui-x\b/g)).toHaveLength(1);
    expect(html).toContain("↗");
    expect(html).toContain("feat/x (local abc1234) · não mergeado");
    expect(html).not.toContain("↗ pending em"); // a frase 'estado lá' é só do bead local com marca
  });

  // B-R1: `.hotspot-desk.elsewhere { position: relative }` ganhava de `.hotspot { position:
  // absolute }` (mais específica) e a mesa saía do lugar (a desk-release descia 308 px). A
  // marca ↗ é um ::after posicionado em relação à própria mesa, que já é absolute.
  it("nenhuma regra .hotspot-desk.elsewhere muda a posição da mesa", () => {
    const html = readFileSync(path.join(BOARD, "room.html"), "utf8");
    const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]!).join("\n");
    const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
    const onDesk = rules.filter((r) => r.selector.split(",").some((s) => /\.hotspot-desk\.elsewhere\b(?!\s*::)/.test(s.trim())));
    expect(onDesk.length, "a regra da marca existe só como ::after").toBe(0);
    for (const r of onDesk) expect(r.body).not.toMatch(/\bposition\s*:/);
    const mark = rules.find((r) => /\.hotspot-desk\.elsewhere::after/.test(r.selector));
    expect(mark?.body).toMatch(/position\s*:\s*absolute/);
    // e a mesa continua absoluta pela regra base
    expect(rules.find((r) => r.selector === ".hotspot")?.body).toMatch(/position\s*:\s*absolute/);
  });

  it("sem elsewhere nada muda nas mesas", async () => {
    const desks = makeDesks();
    const ui = load("room.html", { yaml: yaml([{ id: "api-a", status: "in_progress", title: "A" }]) }, desks);
    await ui.run("fetchState()");
    expect(desks.some((d) => d.classes.has("elsewhere"))).toBe(false);
    expect(desks.find((d) => d.id === "desk-backend")!.classes.has("working")).toBe(true);
  });
});
