// Reconcilia o beads com o quadro do Trello, nas DUAS direções — o núcleo de
// aiteam/scripts/beads-trello-reconcile.mjs. Contrato do vínculo:
// aiteam/docs/beads-schema.md §3.5 (campos `trello` e `trello_scope`).
//
// Por que existe: o vínculo card↔bead é gravado no intake e nada depois confere
// se os dois lados continuam contando a mesma história. Três classes de deriva
// não aparecem a olho: bead viva cujo card já está em FINALIZADO, bead
// concluída cujo card seguia na fila, e card na fila sem bead nenhuma. Refazer
// isso à mão a cada release é como a deriva volta.
//
// SOMENTE LEITURA: nunca move card nem escreve comentário. Mover é decisão de
// quem conhece o escopo do card, e um script que fechasse card sozinho erraria
// exatamente nos casos ambíguos que ele existe para expor.
//
// Lê o estado combinado do modelo por bead (.beads/tasks/, pelo núcleo) — nunca
// o active.yaml, que é visão gerada e só tem os beads vivos. Só node:* e o que
// o núcleo já usa (o js-yaml vendorizado), então roda numa worktree sem
// aiteam/node_modules. Sem shebang (ver beads-core.mjs): a CLI é
// aiteam/scripts/beads-trello-reconcile.mjs.
//
// A rede é injetável (`io.trello` ou `io.fetch`): os testes nunca saem da máquina.

import * as fs from "node:fs";
import * as path from "node:path";
import { buildState } from "./beads-core.mjs";
import { gitTopLevel, isLegacy, LEGACY_HINT, readTreeInputs } from "./beads-io.mjs";

export const TRELLO_API = "https://api.trello.com/1";
/** Lista "de pronto": o card que está numa lista assim já foi entregue ao time. */
export const DEFAULT_DONE_LISTS = "finalizado|done|conclu";

export const USAGE = [
  "uso: node aiteam/scripts/beads-trello-reconcile.mjs --board <id|shortLink> (--queue <listId[,listId]> | --label <regex>) [opções]",
  "",
  "  --board <id>        o quadro do Trello (id ou shortLink). Obrigatório.",
  "  --queue <ids>       a(s) lista(s) de intake do projeto, separadas por vírgula.",
  "  --label <regex>     a etiqueta do projeto (sem diferenciar maiúsculas); casa o NOME da etiqueta.",
  "                      --queue e --label estreitam: com os dois, vale o card que cumpre os dois.",
  "                      Um dos dois é obrigatório: num quadro compartilhado, sem eles todo card seria 'sem bead'.",
  "  --ignore <regex>    cards cujo nome casa não entram em 'card aberto SEM bead' (catálogo, referência).",
  `  --done-lists <re>   listas de pronto, pelo nome (padrão: ${DEFAULT_DONE_LISTS}).`,
  "  --json              saída para pipe.",
  "",
  "Credenciais: TRELLO_API_KEY e TRELLO_TOKEN, do ambiente ou do .env da raiz (as mesmas do MCP trello-tools).",
  "Somente leitura, e só lê o checkout atual: o que as outras branches e worktrees têm de .beads/tasks/ ainda não conta",
  "(um bead criado numa branch não mergeada aparece como 'sem bead'). Um filtro que não pega nada (id de --queue",
  "fora do quadro, --label que nenhuma etiqueta casa) avisa em stderr.",
  "Códigos: 0 conferiu, 1 falhou (rede, API), 2 uso errado, credencial ausente ou repo no modelo antigo.",
].join("\n");

class Usage extends Error {}
class Failure extends Error {}

// ── Argumentos ───────────────────────────────────────────────────────────────

const VALUE_FLAGS = new Set(["board", "queue", "label", "ignore", "done-lists"]);
const BOOL_FLAGS = new Set(["json", "help"]);

function compile(flag, source) {
  try {
    return new RegExp(source, "i");
  } catch (err) {
    throw new Usage(`--${flag}: expressão regular inválida (${String(err?.message ?? err).split("\n")[0]})`);
  }
}

/**
 * Os argumentos da CLI. Lança Usage para flag desconhecida, valor ausente,
 * regex inválida, ou nenhum dos filtros do projeto (--queue, --label).
 */
export function parseArgs(argv) {
  const raw = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Usage(`argumento inesperado: ${a}`);
    const eq = a.indexOf("=");
    const name = a.slice(2, eq < 0 ? undefined : eq);
    if (BOOL_FLAGS.has(name)) {
      if (eq >= 0) throw new Usage(`--${name} não leva valor`);
      raw[name] = true;
    } else if (VALUE_FLAGS.has(name)) {
      let v;
      if (eq >= 0) v = a.slice(eq + 1);
      else {
        v = argv[i + 1];
        if (v === undefined || v.startsWith("--")) throw new Usage(`--${name} precisa de um valor`);
        i++;
      }
      if (v.trim() === "") throw new Usage(`--${name} vazio`);
      raw[name] = v;
    } else {
      throw new Usage(`flag desconhecida: --${name}`);
    }
  }
  if (raw.help) return { help: true };
  if (!raw.board) throw new Usage("--board é obrigatório: o quadro não tem padrão no framework");
  if (!raw.queue && !raw.label) {
    throw new Usage("informe --queue (a lista de intake) e/ou --label (a etiqueta do projeto): num quadro compartilhado, sem eles todo card seria 'sem bead'");
  }
  return {
    help: false,
    board: raw.board,
    queue: raw.queue ? raw.queue.split(",").map((s) => s.trim()).filter(Boolean) : [],
    label: raw.label ? compile("label", raw.label) : null,
    ignore: raw.ignore ? compile("ignore", raw.ignore) : null,
    doneLists: compile("done-lists", raw["done-lists"] ?? DEFAULT_DONE_LISTS),
    json: Boolean(raw.json),
  };
}

// ── Trello (somente leitura) ─────────────────────────────────────────────────

/**
 * O cliente da API: `(path, params) => Promise<json>`. A chave e o token vão na
 * query, que é como a API do Trello os recebe — e por isso nenhuma mensagem de
 * erro cita a URL: só o caminho e o status.
 */
export function makeTrelloClient(key, token, fetchImpl = globalThis.fetch) {
  return async function trello(apiPath, params = {}) {
    const url = new URL(`${TRELLO_API}${apiPath}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("key", key);
    url.searchParams.set("token", token);
    let res;
    try {
      res = await fetchImpl(url.toString());
    } catch {
      throw new Failure(`Trello ${apiPath} → sem resposta (rede?)`);
    }
    if (!res.ok) throw new Failure(`Trello ${apiPath} → HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new Failure(`Trello ${apiPath} → resposta que não é JSON`);
    }
  };
}

/** Uma variável do ambiente ou, na falta, a linha `CHAVE=valor` do .env da raiz. */
export function envValue(key, env, dotenvText) {
  if (env[key]) return env[key];
  const m = (dotenvText ?? "").match(new RegExp(`^${key}=(.*)$`, "m"));
  const v = m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  return v || null;
}

// ── Os beads e o vínculo com o card ──────────────────────────────────────────

const PROSE_LINK = /trello\.com\/c\/([A-Za-z0-9]+)/g;

/**
 * Cada bead do estado combinado com seus cards. `texts` é `{id → texto bruto de
 * todos os arquivos do bead}`: o link citado em PROSA é caçado no bead inteiro
 * (a nota do intake, o resumo, o que uma entrada antiga disse), não só nos
 * campos que venceram a combinação.
 *
 * - `links`: o CAMPO manda; a prosa vira fallback.
 * - `soEmProsa`: cita card em texto e não preencheu o campo — dívida de vínculo.
 * - `forasteiros`: campo preenchido, mas o texto cita card que ele não lista (o
 *   bead absorveu dois cards e registrou um). Mesma dívida do `soEmProsa`, e é
 *   o que faz o outro card imprimir como "sem bead" a cada release.
 * - `parcial`: `trello_scope: partial` — o card pede menos que o bead cobre.
 */
export function linkBeads(beads, texts = {}) {
  return beads.map((b) => {
    const campo = [].concat(b.fields.trello ?? []).filter((x) => typeof x === "string");
    const emProsa = [...new Set([...String(texts[b.id] ?? "").matchAll(PROSE_LINK)].map((m) => m[1]))];
    return {
      id: b.id,
      status: b.status,
      links: campo.length ? campo : emProsa,
      soEmProsa: campo.length === 0 && emProsa.length > 0,
      forasteiros: campo.length ? emProsa.filter((x) => !campo.includes(x)) : [],
      parcial: b.fields.trello_scope === "partial",
    };
  });
}

// ── Classificação ────────────────────────────────────────────────────────────

/**
 * Cruza os cards do quadro com os beads e devolve as quatro classes de divergência.
 *
 * "Aberto" é TUDO que não é lista de pronto — não uma lista branca. Uma lista
 * branca (`to-do|em andamento`) falha em silêncio quando alguém cria ou renomeia
 * uma lista, e leva a afirmar "nenhuma entrega tem card" quando havia cards no
 * Backlog. "Não é pronto" falha para o lado seguro: mostra demais em vez de
 * esconder.
 *
 * @param {{ cards: Array<{name:string, shortLink:string, idList:string, labels?:Array<{name?:string}>}>,
 *           listName: Map<string,string>, beads: ReturnType<typeof linkBeads>,
 *           options: {queue:string[], label:RegExp|null, ignore:RegExp|null, doneLists:RegExp} }} entrada
 */
export function classify({ cards, listName, beads, options }) {
  const vivas = beads.filter((b) => b.status !== "completed");
  const concluidas = beads.filter((b) => b.status === "completed");
  const beadPorLink = new Map();
  for (const b of beads) {
    for (const l of b.links) beadPorLink.set(l, [...(beadPorLink.get(l) ?? []), b]);
  }
  const cardInfo = (c) => ({ card: c.name, url: `https://trello.com/c/${c.shortLink}`, lista: listName.get(c.idList) ?? "?" });
  const doDoProjeto = (c) =>
    (options.queue.length === 0 || options.queue.includes(c.idList)) &&
    (!options.label || (c.labels ?? []).some((l) => options.label.test(l.name ?? "")));

  const cardAdiantado = []; // bead viva, card já dado como pronto no quadro
  const escopoParcial = []; // o mesmo, mas já explicado: o card pedia menos que a bead
  const cardAtrasado = []; // bead concluída, card ainda numa lista de fila — a dívida de write-back
  const semBead = []; // card aberto do projeto sem bead nenhuma — intake pendente

  for (const c of cards) {
    const nome = listName.get(c.idList) ?? "";
    const doBead = beadPorLink.get(c.shortLink) ?? [];
    const pronto = options.doneLists.test(nome);
    const vivasDoCard = doBead.filter((b) => b.status !== "completed");
    if (pronto && vivasDoCard.length) {
      // Basta UMA bead viva de escopo integral para o card estar adiantado de verdade.
      (vivasDoCard.every((b) => b.parcial) ? escopoParcial : cardAdiantado).push({ ...cardInfo(c), beads: vivasDoCard });
    }
    if (!pronto && doBead.length && doBead.every((b) => b.status === "completed")) {
      cardAtrasado.push({ ...cardInfo(c), beads: doBead });
    }
    if (!pronto && doBead.length === 0 && doDoProjeto(c) && !(options.ignore && options.ignore.test(c.name))) {
      semBead.push(cardInfo(c));
    }
  }

  // Dívida de vínculo: não é divergência com o quadro, é o vínculo em formato frágil.
  const soEmProsa = beads.filter((b) => b.soEmProsa);
  const campoIncompleto = beads.filter((b) => b.forasteiros.length);
  const cobertura = {
    vivasComCard: vivas.filter((b) => b.links.length).length,
    vivas: vivas.length,
    concluidasComCard: concluidas.filter((b) => b.links.length).length,
    concluidas: concluidas.length,
  };
  return { cardAdiantado, escopoParcial, cardAtrasado, semBead, soEmProsa, campoIncompleto, cobertura };
}

// ── Relatório ────────────────────────────────────────────────────────────────

const beadsDe = (i, comStatus = true) => i.beads.map((b) => (comStatus ? `${b.id} (${b.status})` : b.id)).join(", ");
const cardLinhas = (extra) => (i) => [`  ${i.card}`, `    ${i.url} [${i.lista}]`, `    ${extra(i)}`];

/** As linhas do relatório em texto. `ctx.filtro` descreve o que conta como card do projeto. */
export function renderReport(result, ctx = {}) {
  const lines = [];
  const bloco = (titulo, itens, render) => {
    lines.push("", `=== ${titulo} (${itens.length}) ===`);
    if (!itens.length) lines.push("  nada");
    for (const i of itens) lines.push(...render(i));
  };
  bloco("Bead VIVA, card já dado como pronto — decidir quem está certo", result.cardAdiantado, cardLinhas((i) => beadsDe(i)));
  bloco(
    "Card pronto com bead viva, já explicado (trello_scope: partial) — só conferir se ainda vale",
    result.escopoParcial,
    cardLinhas((i) => beadsDe(i))
  );
  bloco("Bead CONCLUÍDA, card ainda na fila — mover e comentar no card", result.cardAtrasado, cardLinhas((i) => beadsDe(i, false)));
  bloco(
    `Card aberto SEM bead${ctx.filtro ? ` (${ctx.filtro})` : ""} — intake pendente, ou aguardando resposta da equipe`,
    result.semBead,
    (i) => [`  ${i.card}`, `    ${i.url} [${i.lista}]`]
  );
  bloco("Vínculo só em prosa — promover ao campo `trello` (beads set <id> --trello <shortLink>; beads-schema.md §3.5)", result.soEmProsa, (i) => [
    `  ${i.id} (${i.status}) → ${i.links.join(", ")}`,
  ]);
  bloco("Campo `trello` preenchido pela METADE — a bead cita card que não está na lista", result.campoIncompleto, (i) => [
    `  ${i.id} (${i.status}) tem [${i.links.join(", ")}] e cita ${i.forasteiros.join(", ")}`,
  ]);
  const c = result.cobertura;
  lines.push(
    "",
    "=== Cobertura do vínculo ===",
    `  beads vivas:      ${c.vivasComCard}/${c.vivas} com card`,
    `  beads concluídas: ${c.concluidasComCard}/${c.concluidas} com card`,
    "",
    "  A conferência só alcança o subconjunto VINCULADO. Trabalho nascido de bug interno ou decisão de",
    "  arquitetura nunca teve card, e isso é normal — o que NÃO é normal é entrega vinda de card sem o",
    "  campo `trello` preenchido, porque some daqui em silêncio."
  );
  if (ctx.invalidos?.length) {
    lines.push("", `⚠ ${ctx.invalidos.length} bead(s) inválido(s) ficaram FORA da conferência: ${ctx.invalidos.join(", ")} — rode npm --prefix aiteam run validate:beads`);
  }
  return lines;
}

// ── A execução ───────────────────────────────────────────────────────────────

/**
 * Avisos de um filtro que não pega nada: ids de --queue fora do quadro e --label que nenhuma etiqueta
 * de card do quadro casa. Vão para stderr, uma linha cada.
 */
export function filterWarnings(options, lists, cards) {
  const warnings = [];
  const known = new Set(lists.map((l) => l.id));
  const bad = options.queue.filter((q) => !known.has(q));
  if (bad.length) {
    const have = lists.slice(0, 12).map((l) => `${l.id} ${l.name}`).join("; ");
    warnings.push(
      ...bad.map(
        (q) => `⚠ --queue: ${q} não é id de lista deste quadro — o filtro não pega nenhum card dela (listas do quadro: ${have}${lists.length > 12 ? "; …" : ""})`
      )
    );
  }
  if (options.label && !cards.some((c) => (c.labels ?? []).some((l) => options.label.test(l.name ?? "")))) {
    warnings.push(
      `⚠ --label /${options.label.source}/: nenhum card deste quadro tem etiqueta com esse nome — o filtro não pega nada, e "sem bead" sai vazio por isso (escape os metacaracteres do regex: Time.X vira Time\\.X)`
    );
  }
  return warnings;
}

function describeFilter(options) {
  const parts = [];
  if (options.queue.length) parts.push(`na fila ${options.queue.join(", ")}`);
  if (options.label) parts.push(`com a etiqueta /${options.label.source}/`);
  return parts.join(" e ");
}

/**
 * Roda o reconcile. `io`: `{cwd, env, stdout(line), stderr(line)}` e, para os
 * testes, `trello(path, params)` (o cliente) ou `fetch` (o transporte do cliente
 * real). Devolve o código de saída; nunca chama process.exit.
 */
export async function main(argv, io) {
  const out = io.stdout ?? ((l) => console.log(l));
  const err = io.stderr ?? ((l) => console.error(l));
  try {
    const options = parseArgs(argv);
    if (options.help) {
      out(USAGE);
      return 0;
    }
    const top = gitTopLevel(io.cwd);
    const root = top ?? io.cwd;
    // O modelo antigo não tem .beads/tasks/: ler o active.yaml dele é justamente o que este script não faz.
    // Fora de um repo git não há "modo": o isLegacy lê o HEAD, então só roda dentro de um.
    if (top && isLegacy(top)) {
      err(`${LEGACY_HINT}\nEste conferidor lê o modelo por bead (.beads/tasks/); migre antes.`);
      return 2;
    }

    let client = io.trello;
    if (!client) {
      let dotenv = "";
      try {
        dotenv = fs.readFileSync(path.join(root, ".env"), "utf8");
      } catch {
        /* sem .env: vale o ambiente */
      }
      const env = io.env ?? {};
      const key = envValue("TRELLO_API_KEY", env, dotenv);
      const token = envValue("TRELLO_TOKEN", env, dotenv);
      if (!key || !token) {
        err("TRELLO_API_KEY/TRELLO_TOKEN ausentes (ambiente ou .env da raiz) — nada a conferir.");
        return 2;
      }
      client = makeTrelloClient(key, token, io.fetch);
    }

    const inputs = readTreeInputs(root);
    const state = buildState(inputs.beads, inputs.project);
    const texts = {};
    for (const f of inputs.beads) texts[f.bead] = `${texts[f.bead] ?? ""}\n${f.text}`;
    const beads = linkBeads(state.beads, texts);

    const lists = await client(`/boards/${options.board}/lists`, { fields: "name" });
    const cards = await client(`/boards/${options.board}/cards`, { fields: "name,shortLink,idList,labels" });
    const listName = new Map(lists.map((l) => [l.id, l.name]));

    // Um filtro errado dá falso verde: o --queue de um id que não é do quadro, ou o --label que não casa
    // etiqueta nenhuma, não pega card algum, e "nada sem bead" sai igual a um quadro em dia. Os dados já
    // estão em memória: avisa em stderr (não muda a saída nem o código).
    for (const line of filterWarnings(options, lists, cards)) err(line);

    const result = classify({ cards, listName, beads, options });
    const invalidos = state.invalid.map((i) => i.id);
    if (options.json) {
      out(JSON.stringify({ ...result, invalidos }, null, 2));
    } else {
      for (const line of renderReport(result, { filtro: describeFilter(options), invalidos })) out(line);
    }
    return 0;
  } catch (e) {
    if (e instanceof Usage) {
      err(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    if (e instanceof Failure) {
      err(e.message);
      return 1;
    }
    err(`falha inesperada: ${String(e?.message ?? e).split("\n")[0]}`);
    return 1;
  }
}
