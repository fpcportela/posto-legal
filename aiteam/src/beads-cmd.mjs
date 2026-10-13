// O comando `beads` (fase 2 da #37): escreve o arquivo da branch atual e mostra
// o estado dos beads, inclusive o das outras branches. Contrato:
// aiteam/docs/beads-schema.md §12 e §13.
//
//   node aiteam/scripts/beads.mjs <new|start|stage|block|unblock|done|note|set|show|list|status|path> …
//
// Por que um comando: o agente que escreve o YAML à mão erra o caminho (a
// branch vira o nome do arquivo), o horário (o `at` tem de vencer as entradas
// anteriores) e a posição (tudo no fim). Aqui o caminho vem da branch, o `at`
// de nextAt, a entrada de appendEntry e nada é gravado antes da validação.
//
// Esta camada é testável sem processo: `run(argv, ctx)` devolve
// `{code, stdout, stderr}`. Quem imprime é aiteam/scripts/beads.mjs.
// Saída: 0 gravou (ou mostrou), 1 recusou, 2 erro de uso.
//
// Só node:*, o núcleo e o io — roda sem aiteam/node_modules. Sem shebang.
// O comando não faz `git add`, não escreve no .git/config e nunca grava fora
// de `.beads/tasks/<id>/<branch>.yaml`.

import * as fs from "node:fs";
import * as path from "node:path";
import { CORE_SCHEMA, load } from "../vendor/js-yaml.mjs";
import { aggregate, cleanText, DEFAULT_MAX_REFS, DEFAULT_SINCE_DAYS, elsewhereLine } from "./beads-aggregate.mjs";
import {
  appendEntry,
  appendOnlyProblem,
  AT_AHEAD_WARN_MS,
  buildState,
  byteCompare,
  combineBead,
  IMPL_MODELS,
  idProblems,
  nextAt,
  renderDefinition,
  sanitizeBranch,
} from "./beads-core.mjs";
import {
  catFiles,
  currentBranch,
  gitTopLevel,
  isLegacy,
  LEGACY_HINT,
  listBeadIds,
  nowFromEnv,
  readBeadFiles,
  readTreeInputs,
  regenerateViews,
} from "./beads-io.mjs";

const HTML = /<[a-z][^>]*>/i;
const CONTROL = /[\u0000-\u001f\u007f]/;
const EFFORTS = ["S", "M", "L"];
// Quem espera um comando aguenta mais que o brief do SessionStart (1,5 s): o
// prazo só existe para um git pendurado não prender o terminal para sempre.
const AGGREGATE_DEADLINE_MS = 15_000;
// Teto do id e do caminho relativo: o id vira nome de pasta, e no Windows o
// caminho absoluto (raiz do repo + este) passa de 260 antes de o disco dizer ENOENT.
const MAX_ID_CHARS = 100;
const MAX_REL_PATH_CHARS = 200;

class Refusal extends Error {}
class Usage extends Error {}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ── Argumentos ───────────────────────────────────────────────────────────────

const COMMON = { value: [], bool: ["json", "quiet", "help"] };
const DEFINITION_VALUES = ["title", "desc", "effort", "model", "tags", "files", "phase", "trello", "trello-scope"];

/** `positional`: quantos argumentos sem flag; `rest`: o último junta o resto (texto livre). */
const SPECS = {
  new: { positional: 1, value: [...DEFINITION_VALUES, "stage"], bool: ["start", "force", "no-views"] },
  start: { positional: 1, value: ["stage"], bool: ["no-views"] },
  stage: { positional: 2, value: [], bool: ["no-views"] },
  block: { positional: 1, value: ["on", "note"], bool: ["no-views"] },
  unblock: { positional: 1, value: [], bool: ["no-views"] },
  done: { positional: 1, value: ["summary", "tags"], bool: ["no-views"] },
  note: { positional: 2, rest: true, value: [], bool: ["no-views"] },
  set: { positional: 1, value: DEFINITION_VALUES, bool: ["no-views"] },
  show: { positional: 1, value: [], bool: ["all"] },
  list: { positional: 0, value: ["status"], bool: ["done", "all"] },
  status: { positional: 0, value: ["since", "max-refs"], bool: ["local", "remotes"] },
  path: { positional: 1, value: [], bool: [] },
};

const USAGE = [
  "uso: node aiteam/scripts/beads.mjs <subcomando> [argumentos] [--json] [--quiet]",
  "",
  "  new <id> --title T [--desc D] [--effort S|M|L] [--model sonnet|opus|haiku] [--tags a,b]",
  "           [--files a,b] [--phase P] [--trello shortLink[,shortLink] [--trello-scope partial]]",
  "           [--start [--stage s]] [--force]   cria o bead (definição + 1ª entrada)",
  "  start <id> [--stage s]            in_progress (e a etapa, se vier)",
  "  stage <id> <s>                    muda a etapa",
  "  block <id> --on a,b [--note N]    blocked, com os ids que bloqueiam",
  "  unblock <id>                      volta a in_progress e limpa os blockers",
  "  done <id> --summary S [--tags a,b]  completed (--summary é obrigatório, até 3 frases)",
  "  note <id> <texto>                 uma linha de log (ação Tier 2)",
  "  set <id> [--title|--desc|--effort|--model|--tags|--files|--phase|--trello|--trello-scope …]   corrige a definição",
  "  show <id> [--all]                 estado combinado e linha do tempo (--all: outras branches)",
  "  list [--status s] [--done] [--all]  um bead por linha (--done: inclui concluídos; --all: outras branches)",
  "  status [--local] [--remotes] [--since DIAS] [--max-refs N]   branch, contagens e outras branches",
  "  path <id>                         o arquivo que esta branch escreve para o bead",
  "",
  "Texto que começa com - (nota, etapa, título): use `--` antes dele (beads note <id> -- --texto) ou --flag=--valor.",
  "Escreve só em .beads/tasks/<id>/<sua-branch>.yaml, só no fim, e só se o resultado for válido.",
  "Flags de escrita: --no-views não regenera active.yaml e index.yaml. Contrato: aiteam/docs/beads-schema.md.",
].join("\n");

function parseArgs(sub, argv) {
  const spec = SPECS[sub];
  const value = new Set([...COMMON.value, ...spec.value]);
  const bool = new Set([...COMMON.bool, ...spec.bool]);
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = a.slice(2, eq < 0 ? undefined : eq);
    if (bool.has(name)) {
      if (eq >= 0) throw new Usage(`--${name} não leva valor`);
      flags[name] = true;
    } else if (value.has(name)) {
      let v;
      if (eq >= 0) v = a.slice(eq + 1);
      else {
        v = argv[i + 1];
        if (v === undefined || (v.startsWith("--") && v.length > 2)) {
          throw new Usage(`--${name} precisa de um valor${v === undefined ? "" : ` (${v} parece uma flag; para um valor que começa com "--", escreva --${name}=${v})`}`);
        }
        i++;
      }
      flags[name] = v;
    } else {
      throw new Usage(`flag desconhecida: --${name} (subcomando ${sub}) — para texto que começa com "-", use "--" antes dele (beads note <id> -- --texto) ou --flag=valor`);
    }
  }
  const want = spec.positional;
  const extra = spec.rest && positional.length > want ? [positional.slice(want - 1).join(" ")] : [];
  const args = spec.rest && positional.length > want ? [...positional.slice(0, want - 1), ...extra] : positional;
  if (args.length < want) throw new Usage(`faltam argumentos (${sub} espera ${want}, vieram ${args.length})`);
  if (args.length > want) throw new Usage(`argumentos demais para ${sub}: ${args.slice(want).join(" ")}`);
  return { flags, args };
}

const list = (v) =>
  String(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// ── Contexto: raiz, branch e arquivo de escrita ──────────────────────────────

function repoContext(cwd, { write }) {
  const root = gitTopLevel(cwd);
  if (!root) throw new Refusal("não estou num repositório git (rode dentro do repo)");
  if (isLegacy(root)) throw new Refusal(LEGACY_HINT.replace(/^\[beads\] /, ""));
  const cur = currentBranch(root);
  const own = cur.branch ? sanitizeBranch(cur.branch) : { file: null, reason: "HEAD destacado — crie uma branch antes de registrar beads (git switch -c <nome>)" };
  if (write && !own.file) throw new Refusal(own.reason);
  return { root, branch: cur.branch, file: own.file, reason: own.reason };
}

const relFor = (id, file) => `.beads/tasks/${id}/${file}.yaml`;

/** O caminho absoluto, garantido dentro de `.beads/tasks/` (o id já passou por idProblems). */
function absFor(root, id, file) {
  const tasks = path.resolve(root, ".beads", "tasks");
  const abs = path.resolve(tasks, id, `${file}.yaml`);
  const rel = path.relative(tasks, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Refusal(`o caminho de ${id} sairia de .beads/tasks/`);
  return abs;
}

const insideOf = (parent, child) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);

/**
 * Nada se grava através de um link: `.beads/tasks/` e a pasta do bead têm de
 * resolver para dentro do repo (A-A2). O listBeadIds não vê uma junção (no
 * Windows) ou um link (no Linux) como pasta, então o `new` seguia em frente, o
 * mkdir recursivo atravessava e o `wx` gravava fora do repositório.
 */
function confine(root, id) {
  const tasks = path.join(root, ".beads", "tasks");
  let rootReal;
  let tasksReal = null;
  try {
    rootReal = fs.realpathSync(root);
  } catch {
    rootReal = path.resolve(root);
  }
  // O próprio `.beads`: junção ou link para fora, sem `tasks/` lá, não deixaria nada a conferir
  // abaixo — e o mkdir recursivo criaria `tasks/<id>/` do outro lado (A-novo).
  const beadsDir = path.join(root, ".beads");
  let beadsSt = null;
  try {
    beadsSt = fs.lstatSync(beadsDir);
  } catch (err) {
    if (err?.code !== "ENOENT") throw new Refusal(`não consegui examinar .beads: ${err?.code ?? err?.message}`);
  }
  if (beadsSt) {
    if (beadsSt.isSymbolicLink()) throw new Refusal(".beads é um link ou junção — não escrevo através dele (seria fora do repositório)");
    let beadsReal;
    try {
      beadsReal = fs.realpathSync(beadsDir);
    } catch (err) {
      throw new Refusal(`não consegui resolver .beads: ${err?.code ?? err?.message}`);
    }
    if (!insideOf(rootReal, beadsReal)) throw new Refusal(`.beads resolve para fora do repositório (${beadsReal}) — não escrevo através dele`);
  }
  try {
    tasksReal = fs.realpathSync(tasks);
  } catch {
    tasksReal = null; // ainda não existe: o mkdir a cria dentro do repo
  }
  if (tasksReal !== null && !insideOf(rootReal, tasksReal)) {
    throw new Refusal(`.beads/tasks é um link para fora do repositório (${tasksReal}) — não escrevo através dele`);
  }
  const dir = path.join(tasks, id);
  let st = null;
  try {
    st = fs.lstatSync(dir);
  } catch (err) {
    if (err?.code !== "ENOENT") throw new Refusal(`não consegui examinar .beads/tasks/${id}: ${err?.code ?? err?.message}`);
  }
  if (st === null) return;
  if (st.isSymbolicLink()) throw new Refusal(`.beads/tasks/${id} é um link ou junção — não escrevo através dele (seria fora de .beads/tasks/)`);
  if (!st.isDirectory()) throw new Refusal(`.beads/tasks/${id} não é uma pasta`);
  let real;
  try {
    real = fs.realpathSync(dir);
  } catch (err) {
    throw new Refusal(`não consegui resolver .beads/tasks/${id}: ${err?.code ?? err?.message}`);
  }
  if (tasksReal !== null && !insideOf(tasksReal, real)) {
    throw new Refusal(`.beads/tasks/${id} resolve para fora de .beads/tasks/ (${real}) — não escrevo através dele`);
  }
}

// ── Validação de texto ───────────────────────────────────────────────────────

function textProblem(label, value) {
  if (CONTROL.test(value)) return `${label} tem mais de uma linha ou caractere de controle — use uma linha só`;
  if (HTML.test(value)) return `${label} contém HTML — use texto puro`;
  return null;
}

function checkTexts(fields) {
  const problems = [];
  for (const [label, v] of Object.entries(fields)) {
    if (typeof v !== "string") continue;
    const p = textProblem(label, v);
    if (p) problems.push(p);
  }
  if (problems.length) throw new Refusal(problems.join("; "));
}

/** Valor que veio mas é vazio ou só espaço não é valor (A-R4). */
function nonBlank(label, v) {
  if (v !== undefined && String(v).trim() === "") throw new Refusal(`${label} vazio ou só com espaços — passe um valor`);
  return v;
}

/**
 * Uma lista de valores (`--tags a,b`): sem item nenhum é recusada (A-R4) e cada
 * item passa pelas mesmas regras do texto livre (A-R3) — uma tag com quebra de
 * linha ou HTML não entra no arquivo.
 */
function listFlag(label, raw) {
  const items = list(raw);
  if (items.length === 0) throw new Refusal(`${label} vazio — passe pelo menos um valor (a,b)`);
  for (const item of items) checkTexts({ [label]: item });
  return items;
}

// ── Leitura do estado ────────────────────────────────────────────────────────

/** O bead desta árvore, combinado: `{files, result}`; `files` vazio se não existe. */
function readBead(root, id, nowMs) {
  const files = readBeadFiles(root, id);
  return { files, result: files.length ? combineBead(id, files, { nowMs }) : null };
}

function elsewhereOf(root, tree, nowMs, opts = {}) {
  return aggregate(root, { tree, nowMs, deadlineMs: AGGREGATE_DEADLINE_MS, ...opts });
}

function originText(entry) {
  return entry.fontes.map((f) => f.origem).join(", ");
}

// ── Escrita ──────────────────────────────────────────────────────────────────

function ownText(abs) {
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw new Refusal(`não consegui ler ${abs}: ${err?.message ?? err}`);
  }
  if (!st.isFile()) throw new Refusal(`${abs} não é um arquivo regular — não escrevo nele`);
  return fs.readFileSync(abs, "utf8");
}

function headText(root, rel) {
  try {
    const t = catFiles(root, [`HEAD:${rel}`]).get(`HEAD:${rel}`);
    return typeof t === "string" ? t : null;
  } catch {
    return null;
  }
}

/**
 * Grava só o acréscimo: arquivo novo com `wx` (numa corrida, quem perde
 * reabre como acréscimo) e arquivo existente com O_APPEND. Um write só, para
 * dois comandos ao mesmo tempo não se misturarem.
 */
function commitText(abs, before, after) {
  if (before === null) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    try {
      const fd = fs.openSync(abs, "wx");
      try {
        fs.writeSync(fd, Buffer.from(after, "utf8"));
      } finally {
        fs.closeSync(fd);
      }
      return;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      throw Object.assign(new Error("corrida"), { race: true });
    }
  }
  if (!after.startsWith(before)) throw new Refusal("o texto novo não começa pelo conteúdo do arquivo — não escrevo");
  const fd = fs.openSync(abs, "a");
  try {
    fs.writeSync(fd, Buffer.from(after.slice(before.length), "utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Acrescenta uma entrada ao arquivo da branch atual (ou, com `definition`,
 * cria o bead). Valida contra o disco, contra HEAD e a combinação com os
 * arquivos irmãos ANTES de gravar: qualquer erro e nada é escrito.
 */
function writeEntry(ctx, { id, entry, definition, nowMs }) {
  const { root, file } = ctx;
  const rel = relFor(id, file);
  if (rel.length > MAX_REL_PATH_CHARS) {
    throw new Refusal(`o caminho ${rel.slice(0, 60)}… passa de ${MAX_REL_PATH_CHARS} caracteres (${rel.length}) — use um id ou uma branch com nome mais curto`);
  }
  const abs = absFor(root, id, file);
  confine(root, id);
  const warnings = [];

  for (let attempt = 0; attempt < 3; attempt++) {
    const siblings = readBeadFiles(root, id);
    const disk = ownText(abs);
    if (disk === "") {
      // Outro comando acabou de criar o arquivo (open e write não são um passo
      // só): dá a vez a ele. Um arquivo que fica vazio é erro de verdade.
      if (attempt < 2) {
        sleep(40);
        continue;
      }
      throw new Refusal(`${rel} está vazio — apague-o ou escreva o conteúdo antes de acrescentar`);
    }
    if (definition && siblings.length) throw new Refusal(`o bead ${id} acabou de ser criado por outro processo — use as outras entradas`);
    const others = siblings.filter((f) => f.branchFile !== file);
    const combinedBefore = siblings.length ? combineBead(id, siblings, { nowMs }) : null;
    if (combinedBefore && !combinedBefore.bead) {
      throw new Refusal(`o bead ${id} já está inválido nesta árvore — corrija antes de acrescentar: ${combinedBefore.errors[0]}`);
    }
    const when = nextAt(nowMs, combinedBefore?.bead?.updatedMs ?? null);
    if (when.aheadMs > AT_AHEAD_WARN_MS) {
      warnings.push(`o horário da entrada (${when.at}) ficou ${Math.round(when.aheadMs / 60000)} min à frente do relógio — o bead já tem uma asserção mais nova que o agora`);
    }
    const full = { at: when.at, ...entry };
    const text = definition ? appendEntry(renderDefinition(definition, when.ms), full) : appendEntry(disk, full);

    // 1. só acréscimo, contra o disco e contra HEAD
    if (disk !== null) {
      const p = appendOnlyProblem(disk, text);
      if (p) throw new Refusal(`${rel}: ${p}`);
      const head = headText(root, rel);
      if (head !== null) {
        const q = appendOnlyProblem(head, text);
        if (q) throw new Refusal(`${rel}: o arquivo já foi editado no meio em relação a HEAD — ${q}`);
      }
    }
    // 2. válido combinado com os irmãos
    const check = combineBead(id, [...others, { branchFile: file, text }], { nowMs });
    if (!check.bead) throw new Refusal(`${rel}: ${check.errors.join("; ")}`);
    const ownWarnings = check.warnings.filter((w) => w.includes(`${file}.yaml`));
    warnings.push(...ownWarnings);

    try {
      commitText(abs, disk, text);
    } catch (err) {
      if (err?.race) continue;
      if (err instanceof Refusal) throw err;
      // Erro do disco (caminho longo, permissão, disco cheio): recusa com a causa, sem pilha.
      throw new Refusal(`não consegui gravar ${rel}: ${err?.code ?? ""} ${cleanText(err?.message, 160)}`.replace("  ", " "));
    }
    return { rel, at: when.at, bead: check.bead, warnings: [...new Set(warnings)] };
  }
  throw new Refusal(`${rel} mudou enquanto eu escrevia — rode de novo`);
}

// ── Subcomandos de escrita ───────────────────────────────────────────────────

function mustId(id) {
  const problems = idProblems(id);
  if (problems.length) throw new Refusal(problems.join("; "));
  if (id.length > MAX_ID_CHARS) throw new Refusal(`o id passa de ${MAX_ID_CHARS} caracteres (veio com ${id.length}) — escolha um nome mais curto`);
}

function parsePhase(v) {
  return /^\d+(\.\d+)?$/.test(v) ? Number(v) : v;
}

function definitionFields(flags) {
  const out = {};
  if (flags.title !== undefined) out.title = nonBlank("--title", flags.title);
  if (flags.desc !== undefined) out.description = nonBlank("--desc", flags.desc);
  if (flags.effort !== undefined) {
    const e = flags.effort.toUpperCase();
    if (!EFFORTS.includes(e)) throw new Usage(`--effort tem de ser ${EFFORTS.join(" | ")} (veio ${flags.effort})`);
    out.effort = e;
  }
  if (flags.model !== undefined) {
    if (!IMPL_MODELS.includes(flags.model)) throw new Usage(`--model tem de ser ${IMPL_MODELS.join(" | ")} (veio ${flags.model})`);
    out.impl_model = flags.model;
  }
  if (flags.tags !== undefined) out.tags = listFlag("--tags", flags.tags);
  if (flags.files !== undefined) out.related_files = listFlag("--files", flags.files);
  if (flags.phase !== undefined) {
    nonBlank("--phase", flags.phase);
    checkTexts({ "--phase": flags.phase });
    out.phase = parsePhase(flags.phase);
  }
  // O card de origem (§3.5): um shortLink grava texto, vários gravam lista. O formato de cada um é
  // do núcleo (combineBead confere o arquivo todo antes de gravar), não daqui.
  if (flags.trello !== undefined) {
    const links = listFlag("--trello", flags.trello);
    out.trello = links.length === 1 ? links[0] : links;
  }
  if (flags["trello-scope"] !== undefined) out.trello_scope = nonBlank("--trello-scope", flags["trello-scope"]);
  return out;
}

/**
 * O bead precisa existir nesta árvore, com este id exato: num disco que ignora
 * maiúsculas, `readdir` é a única fonte do nome de verdade (a pasta API-A abre
 * a api-a). Se só existe em outra fonte, a recusa mostra a origem.
 */
function requireBead(ctx, id, nowMs) {
  const { root } = ctx;
  const ids = listBeadIds(root);
  if (ids.includes(id)) {
    const { files, result } = readBead(root, id, nowMs);
    if (result) return { files, result };
  }
  const twin = ids.find((x) => x.toLowerCase() === id.toLowerCase());
  if (twin) throw new Refusal(`o bead existe como "${twin}" — o id é sensível a maiúsculas e minúsculas`);
  const agg = elsewhereOf(root, undefined, nowMs);
  const there = agg.elsewhere.find((e) => e.id === id);
  if (there) {
    // A definição na árvore NÃO commitada de outra worktree (o Orchestrator a criou lá): o
    // caminho é ele a commitar, ou o --force por ordem dele. Sem a dica, `new` recusa pelo
    // mesmo motivo e `start` manda usar `new`: um ciclo (B-A4).
    const dirty = there.fontes.some((f) => f.nao_commitado);
    const hint = dirty
      ? `. A definição está só na árvore não commitada de lá: peça ao Orchestrator que a commite — ou, por ordem do Orchestrator, crie a sua aqui com \`beads new ${id} --title … --force\``
      : `. Commite a definição antes do despacho, ou crie o bead aqui com \`beads new ${id} --title …\``;
    throw new Refusal(
      `o bead ${id} só existe em ${originText(there)} (não mergeado) — esta branch não tem a definição, e um adendo sem ela falha no pre-commit${hint}`
    );
  }
  const partial = agg.partial ? " (a leitura das outras branches ficou parcial: o prazo estourou — rode de novo antes de criar)" : "";
  throw new Refusal(`o bead ${id} não existe${partial} — crie com \`beads new ${id} --title …\``);
}

function similarTags(tag, known) {
  const t = tag.toLowerCase();
  const near = (a, b) => {
    if (a === b) return true;
    if (a.length >= 3 && (b.includes(a) || a.includes(b))) return true;
    // distância de edição ≤ 2 (tags são curtas)
    if (Math.abs(a.length - b.length) > 2) return false;
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    return d[a.length][b.length] <= 2;
  };
  return [...known].filter((k) => k !== tag && near(t, k.toLowerCase())).sort(byteCompare).slice(0, 5);
}

function tagWarnings(root, tags, nowMs) {
  const tree = readTreeInputs(root);
  const state = buildState(tree.beads, tree.project, { nowMs });
  const known = new Set(state.beads.flatMap((b) => (Array.isArray(b.fields.tags) ? b.fields.tags : [])));
  const out = [];
  for (const tag of tags) {
    if (known.has(tag)) continue;
    const like = similarTags(tag, known);
    out.push(
      like.length
        ? `a tag "${tag}" não está no índice — parecidas: ${like.join(", ")} (reuse as do índice)`
        : `a tag "${tag}" não está no índice de nenhum bead — confira se não existe uma equivalente (grep em .beads/index.yaml)`
    );
  }
  return out;
}

function writeCommand(sub, ctx, args, flags, nowMs) {
  const id = args[0];
  mustId(id);
  const texts = {};
  let entry;
  let definition = null;
  let extraWarnings = [];

  switch (sub) {
    case "new": {
      const def = definitionFields(flags);
      if (def.title === undefined && def.description === undefined) throw new Usage("new precisa de --title");
      if (flags.stage !== undefined && !flags.start) throw new Usage("--stage com new só vale junto de --start");
      nonBlank("--stage", flags.stage);
      checkTexts({ "--title": def.title, "--desc": def.description, "--stage": flags.stage });
      const lower = id.toLowerCase();
      const local = listBeadIds(ctx.root).find((x) => x.toLowerCase() === lower);
      if (local) throw new Refusal(`o bead ${local} já existe nesta árvore${local === id ? "" : " (os ids se comparam ignorando maiúsculas e minúsculas)"} — use \`beads set\` ou as outras entradas`);
      const agg = elsewhereOf(ctx.root, undefined, nowMs);
      const there = agg.elsewhere.find((e) => e.id.toLowerCase() === lower);
      if (there && !flags.force) {
        throw new Refusal(
          `o id ${there.id} já existe em ${originText(there)} (não mergeado) — criar aqui geraria duas definições. Use outro id, ou --force para criar mesmo assim (só por ordem do Orchestrator, que é quem sabe se aquela definição é a que vale)`
        );
      }
      if (there) extraWarnings.push(`o id ${there.id} também existe em ${originText(there)} — o merge vai mostrar "definido por … e …"`);
      else if (agg.partial) extraWarnings.push("a leitura das outras branches ficou parcial (o prazo estourou): não consegui conferir se o id já existe em outra branch");
      definition = def;
      entry = { status: flags.start ? "in_progress" : "pending" };
      if (flags.start && flags.stage !== undefined) entry.stage = flags.stage;
      break;
    }
    case "start":
      nonBlank("--stage", flags.stage);
      if (flags.stage !== undefined) texts["--stage"] = flags.stage;
      entry = { status: "in_progress" };
      if (flags.stage !== undefined) entry.stage = flags.stage;
      break;
    case "stage":
      nonBlank("a etapa", args[1]);
      texts.stage = args[1];
      entry = { stage: args[1] };
      break;
    case "block": {
      if (flags.on === undefined) throw new Usage("block precisa de --on <id,id>");
      const on = listFlag("--on", flags.on);
      nonBlank("--note", flags.note);
      if (flags.note !== undefined) texts["--note"] = flags.note;
      entry = { status: "blocked", blockers: on };
      if (flags.note !== undefined) entry.note = flags.note;
      const have = new Set(listBeadIds(ctx.root));
      for (const b of on) if (!have.has(b)) extraWarnings.push(`o blocker "${b}" não casa o id de nenhum bead desta árvore`);
      break;
    }
    case "unblock":
      entry = { status: "in_progress", blockers: [] };
      break;
    case "done": {
      if (flags.summary === undefined || flags.summary.trim() === "") {
        throw new Refusal("done exige --summary \"…\" (até 3 frases): é o que o histórico guarda do bead");
      }
      texts["--summary"] = flags.summary;
      entry = { status: "completed", context_summary: flags.summary };
      if (flags.tags !== undefined) {
        entry.tags = listFlag("--tags", flags.tags);
        extraWarnings = tagWarnings(ctx.root, entry.tags, nowMs);
      }
      break;
    }
    case "note":
      nonBlank("o texto da nota", args[1]);
      texts.note = args[1];
      entry = { note: args[1] };
      break;
    case "set": {
      const fields = definitionFields(flags);
      if (Object.keys(fields).length === 0) throw new Usage("set precisa de pelo menos um campo (--title, --desc, --effort, --model, --tags, --files, --phase, --trello, --trello-scope)");
      texts["--title"] = fields.title;
      texts["--desc"] = fields.description;
      entry = fields;
      break;
    }
    default:
      throw new Usage(`subcomando desconhecido: ${sub}`);
  }
  checkTexts(texts);

  if (sub !== "new") {
    const existing = requireBead(ctx, id, nowMs);
    // start, unblock e block num bead concluído o reabrem: vale, mas avisa (A-A10).
    if (["start", "unblock", "block"].includes(sub) && existing.result.bead?.status === "completed") {
      extraWarnings.push(`o bead ${id} está concluído (em ${existing.result.bead.done ?? existing.result.bead.updated_at}) — esta entrada o reabre`);
    }
  }
  const done = writeEntry(ctx, { id, entry, definition, nowMs });
  return { id, ...done, extraWarnings };
}

// ── Leitura: show, list, status, path ────────────────────────────────────────

function stageOf(bead) {
  return typeof bead.fields.stage === "string" ? bead.fields.stage : null;
}

const beadRow = (b) => ({
  id: b.id,
  status: b.status,
  stage: stageOf(b),
  title: typeof (b.fields.title ?? b.fields.description) === "string" ? (b.fields.title ?? b.fields.description) : "",
  updated_at: b.updated_at,
});

function parseLoose(text) {
  try {
    const doc = load(String(text).replace(/\r\n/g, "\n"), { schema: CORE_SCHEMA });
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : null;
  } catch {
    return null;
  }
}

/** A linha do tempo de um bead: cada asserção de cada arquivo, em ordem de instante. */
function timelineOf(files) {
  const rows = [];
  for (const f of files) {
    const doc = parseLoose(f.text);
    if (!doc) continue;
    const { entries, created_at: createdAt, ...top } = doc;
    if (typeof createdAt === "string" && Object.keys(top).length) rows.push({ at: createdAt, arquivo: `${f.branchFile}.yaml`, tipo: "definição", campos: top });
    for (const e of Array.isArray(entries) ? entries : []) {
      if (!e || typeof e !== "object") continue;
      const { at, ...campos } = e;
      if (typeof at === "string") rows.push({ at, arquivo: `${f.branchFile}.yaml`, tipo: "entrada", campos });
    }
  }
  return rows.sort((a, b) => byteCompare(a.at, b.at) || byteCompare(a.arquivo, b.arquivo));
}

const fieldsLine = (campos) =>
  Object.entries(campos)
    .map(([k, v]) => `${k}=${cleanText(Array.isArray(v) ? v.join(",") : typeof v === "object" ? JSON.stringify(v) : v, 120)}`)
    .join(" ");

function showCommand(ctx, id, flags, nowMs, out) {
  const { root } = ctx;
  mustId(id);
  const { files, result } = listBeadIds(root).includes(id) ? readBead(root, id, nowMs) : { files: [], result: null };
  if (!result) {
    const agg = flags.all ? elsewhereOf(root, undefined, nowMs) : null;
    const there = agg?.elsewhere.find((e) => e.id === id);
    if (!there) throw new Refusal(`o bead ${id} não existe nesta árvore${flags.all ? " nem nas outras branches" : " (use --all para procurar nas outras branches)"}`);
    out.json = { id, here: null, elsewhere: there };
    out.lines.push(`${id}: não existe nesta árvore`);
    out.lines.push("OUTRAS BRANCHES (não mergeado — não é o estado desta branch):");
    out.lines.push(`  ${elsewhereLine(there)}`);
    return;
  }
  if (!result.bead) {
    out.json = { id, errors: result.errors };
    throw new Refusal(`o bead ${id} está inválido: ${result.errors.join("; ")}`);
  }
  const b = result.bead;
  const timeline = timelineOf(files);
  const elsewhere = flags.all ? (elsewhereOf(root, undefined, nowMs).elsewhere.find((e) => e.id === id) ?? null) : null;
  out.json = {
    id,
    status: b.status,
    stage: stageOf(b),
    created_at: b.created_at,
    updated_at: b.updated_at,
    ...(b.done ? { done: b.done } : {}),
    branches: b.branches,
    fields: b.fields,
    timeline,
    ...(flags.all ? { elsewhere } : {}),
  };
  const f = b.fields;
  out.lines.push(`${id} — ${cleanText(f.title ?? f.description ?? "", 160)}`);
  out.lines.push(`  status: ${b.status}${stageOf(b) ? ` (etapa ${cleanText(stageOf(b), 30)})` : ""} · criado ${b.created_at} · atualizado ${b.updated_at}${b.done ? ` · concluído ${b.done}` : ""}`);
  if (Array.isArray(f.blockers) && f.blockers.length) out.lines.push(`  blockers: ${f.blockers.map((x) => cleanText(x, 60)).join(", ")}`);
  if (Array.isArray(f.tags) && f.tags.length) out.lines.push(`  tags: ${f.tags.map((x) => cleanText(x, 40)).join(", ")}`);
  if (f.trello !== undefined) {
    const cards = [].concat(f.trello).map((x) => cleanText(x, 40)).join(", ");
    out.lines.push(`  trello: ${cards}${f.trello_scope !== undefined ? ` (${cleanText(f.trello_scope, 20)})` : ""}`);
  }
  if (typeof f.context_summary === "string") out.lines.push(`  resumo: ${cleanText(f.context_summary, 300)}`);
  out.lines.push(`  arquivos: ${b.branches.map((x) => `${x}.yaml`).join(", ")}`);
  out.lines.push("  linha do tempo:");
  for (const r of timeline) out.lines.push(`    ${r.at}  ${r.arquivo}  ${r.tipo}: ${fieldsLine(r.campos)}`);
  if (elsewhere) {
    out.lines.push("OUTRAS BRANCHES (não mergeado — não é o estado desta branch):");
    out.lines.push(`  ${elsewhereLine(elsewhere)}`);
    for (const s of elsewhere.fontes) out.lines.push(`    ${s.arquivo}  ${s.origem}`);
  } else if (flags.all) {
    out.lines.push("OUTRAS BRANCHES: nada diferente do que esta árvore tem.");
  }
}

function listCommand(ctx, flags, nowMs, out) {
  const { root } = ctx;
  const tree = readTreeInputs(root);
  const state = buildState(tree.beads, tree.project, { nowMs });
  let beads = state.beads;
  if (flags.status !== undefined) beads = beads.filter((b) => b.status === flags.status);
  else if (!flags.done) beads = beads.filter((b) => b.status !== "completed");
  const rows = beads.map(beadRow).sort((a, b) => byteCompare(a.updated_at, b.updated_at) || byteCompare(a.id, b.id));
  out.json = { beads: rows, invalid: state.invalid.map((i) => ({ id: i.id, errors: i.errors })) };
  for (const r of rows) out.lines.push(`${r.id}  ${r.status}${r.stage ? ` (${cleanText(r.stage, 20)})` : ""}  ${cleanText(r.title, 100)}`);
  for (const i of state.invalid) out.lines.push(`${i.id}  inválido  ${cleanText(i.errors[0] ?? "", 100)}`);
  if (flags.all) {
    const agg = elsewhereOf(root, tree, nowMs);
    out.json.elsewhere = agg.elsewhere;
    if (agg.elsewhere.length) {
      out.lines.push("OUTRAS BRANCHES (não mergeado — não é o estado desta branch):");
      for (const e of agg.elsewhere) out.lines.push(`  ${elsewhereLine(e)}`);
    }
  }
}

const cleanState = (s) => (s ? { ...s, stage: s.stage === null || s.stage === undefined ? null : cleanText(s.stage, 40), blockers: (s.blockers ?? []).map((b) => cleanText(b, 100)) } : s);

/** O item agregado com todo texto de outra branch limpo (LLM01): é o que o board e o brief leem. */
function cleanElsewhere(e) {
  return {
    ...e,
    id: cleanText(e.id, 100),
    title: cleanText(e.title, 140),
    aqui: cleanState(e.aqui),
    la: cleanState(e.la),
    fontes: e.fontes.map((f) => ({ ...f, arquivo: cleanText(f.arquivo, 240), ref: cleanText(f.ref, 120), origem: cleanText(f.origem, 160) })),
  };
}

function statusCommand(cwd, flags, nowMs, out) {
  const root = gitTopLevel(cwd);
  if (!root) throw new Refusal("não estou num repositório git (rode dentro do repo)");
  const cur = currentBranch(root);
  const own = cur.branch ? sanitizeBranch(cur.branch) : { file: null, reason: "HEAD destacado" };
  if (isLegacy(root)) {
    out.json = { legacy: true, branch: cur.branch, file: null, hint: LEGACY_HINT };
    out.lines.push(LEGACY_HINT.replace(/^\[beads\] /, ""));
    return;
  }
  const tree = readTreeInputs(root);
  const state = buildState(tree.beads, tree.project, { nowMs });
  const live = state.beads.filter((b) => b.status !== "completed");
  const by = (s) => state.beads.filter((b) => b.status === s);
  const counts = {
    total: state.beads.length + state.invalid.length,
    live: live.length,
    pending: by("pending").length,
    in_progress: by("in_progress").length,
    blocked: by("blocked").length,
    completed: by("completed").length,
    invalid: state.invalid.length,
  };

  let agg = null;
  const limits = { sinceDays: DEFAULT_SINCE_DAYS, maxRefs: DEFAULT_MAX_REFS };
  if (!flags.local) {
    const opts = { collisions: true, remotes: Boolean(flags.remotes) };
    if (flags.since !== undefined) opts.sinceDays = Number(flags.since);
    if (flags["max-refs"] !== undefined) opts.maxRefs = Number(flags["max-refs"]);
    for (const [k, v] of [["--since", opts.sinceDays], ["--max-refs", opts.maxRefs]]) {
      if (v !== undefined && (!Number.isFinite(v) || v < 0)) throw new Usage(`${k} precisa de um número`);
    }
    if (opts.sinceDays !== undefined) limits.sinceDays = opts.sinceDays;
    if (opts.maxRefs !== undefined) limits.maxRefs = opts.maxRefs;
    agg = elsewhereOf(root, tree, nowMs, opts);
  }

  out.json = {
    branch: cur.branch,
    file: own.file,
    path_pattern: own.file ? `.beads/tasks/<id>/${own.file}.yaml` : null,
    counts,
    in_progress: by("in_progress").map(beadRow),
    blocked: by("blocked").map((b) => ({ ...beadRow(b), blockers: Array.isArray(b.fields.blockers) ? b.fields.blockers : [] })),
    // Tudo o que vem de outra branch (título, origem, ref, etapa, blockers) é dado não
    // confiável: uma linha, sem invisível nem controle, com teto — o board e o brief o leem daqui.
    elsewhere: agg ? agg.elsewhere.map(cleanElsewhere) : [],
    warnings: agg ? agg.warnings.map((w) => cleanText(w, 400)) : [],
    partial: agg ? agg.partial : false,
    skipped: agg ? agg.skipped : null,
    local_only: Boolean(flags.local),
    defaults: { sinceDays: DEFAULT_SINCE_DAYS, maxRefs: DEFAULT_MAX_REFS },
    ...(agg ? { stats: agg.stats } : {}),
  };

  out.lines.push(
    `branch: ${cur.branch ?? "(HEAD destacado)"} · ${own.file ? `escreve em .beads/tasks/<id>/${own.file}.yaml` : `não escreve beads (${own.reason})`}`
  );
  out.lines.push(
    `${counts.total} beads: ${counts.live} vivos (${counts.in_progress} in_progress, ${counts.blocked} blocked, ${counts.pending} pending) · ${counts.completed} concluídos${counts.invalid ? ` · ${counts.invalid} inválido(s)` : ""}`
  );
  for (const b of by("in_progress")) out.lines.push(`  🔥 ${beadRow(b).id}${stageOf(b) ? ` (${cleanText(stageOf(b), 20)})` : ""}  ${cleanText(beadRow(b).title, 100)}`);
  for (const b of by("blocked")) out.lines.push(`  ✗ ${b.id}  ${cleanText(beadRow(b).title, 80)} — bloqueado por ${(b.fields.blockers ?? []).map((x) => cleanText(x, 40)).join(", ") || "?"}`);
  for (const i of state.invalid) out.lines.push(`  ⚠ ${i.id} inválido: ${cleanText(i.errors[0] ?? "", 120)}`);

  if (agg) {
    if (agg.skipped) out.lines.push(`outras branches: não agregadas (${agg.skipped})`);
    else if (agg.elsewhere.length) {
      out.lines.push("OUTRAS BRANCHES (não mergeado — não é o estado desta branch):");
      for (const e of agg.elsewhere) out.lines.push(`  ${elsewhereLine(e)}`);
    } else out.lines.push("outras branches: nada novo nos beads (nenhuma branch ou worktree não mergeada mexeu neles).");
    // Ref que ficou fora da janela ou do teto não foi lido: sem este aviso, "nada novo" enganaria (A-R2).
    const { refsOutOfWindow: outWin, refsOverLimit: overCap } = agg.stats;
    if (outWin || overCap) {
      const parts = [];
      if (outWin) parts.push(`${outWin} ref(s) fora da janela de ${limits.sinceDays} dias (--since)`);
      if (overCap) parts.push(`${overCap} ref(s) acima do teto de ${limits.maxRefs} (--max-refs)`);
      out.lines.push(`ℹ não li ${parts.join(" e ")} — ajuste as flags para ver mais.`);
    }
    if (agg.partial) out.lines.push("⚠ agregação parcial — o prazo estourou; rode de novo ou use --max-refs menor.");
    for (const w of agg.warnings) out.lines.push(`⚠ ${cleanText(w, 400)}`);
  }
  for (const w of state.warnings.filter((x) => /colide|só diferem/.test(x))) out.lines.push(`⚠ ${cleanText(w, 400)}`);
}

// ── Execução ─────────────────────────────────────────────────────────────────

/**
 * Roda o comando. `ctx`: `{cwd, env}`. Devolve `{code, stdout: string[], stderr: string[]}`.
 */
export function run(argv, ctx = {}) {
  const cwd = ctx.cwd ?? process.cwd();
  const env = ctx.env ?? process.env;
  const stdout = [];
  const stderr = [];
  const out = { lines: [], json: null };
  const sub = argv[0];
  let json = false;
  let quiet = false;

  const finish = (code, extra = {}) => {
    if (json) {
      const payload = out.json ? { ok: code === 0, ...out.json, ...extra } : { ok: code === 0, ...extra };
      stdout.push(JSON.stringify(payload));
    } else if (!quiet || code !== 0) {
      stdout.push(...out.lines.map((l) => `[beads] ${l}`));
    }
    return { code, stdout, stderr };
  };

  try {
    if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
      (sub ? stdout : stderr).push(USAGE);
      return { code: sub ? 0 : 2, stdout, stderr };
    }
    if (!SPECS[sub]) throw new Usage(`subcomando desconhecido: ${sub}`);
    const { flags, args } = parseArgs(sub, argv.slice(1));
    json = Boolean(flags.json);
    quiet = Boolean(flags.quiet);
    if (flags.help) {
      stdout.push(USAGE);
      return { code: 0, stdout, stderr };
    }
    const nowMs = nowFromEnv(env);

    if (sub === "status") {
      statusCommand(cwd, flags, nowMs, out);
      return finish(0);
    }
    if (sub === "path") {
      mustId(args[0]);
      const c = repoContext(cwd, { write: true });
      const rel = relFor(args[0], c.file);
      out.lines.push(rel);
      out.json = { id: args[0], path: rel };
      if (!json) stdout.push(rel); // só o caminho, para usar em $(…)
      return json ? finish(0) : { code: 0, stdout, stderr };
    }
    if (sub === "show" || sub === "list") {
      const c = repoContext(cwd, { write: false });
      if (sub === "show") showCommand(c, args[0], flags, nowMs, out);
      else listCommand(c, flags, nowMs, out);
      return finish(0);
    }

    // Subcomandos de escrita.
    const c = repoContext(cwd, { write: true });
    const r = writeCommand(sub, c, args, flags, nowMs);
    const warnings = [...r.warnings, ...r.extraWarnings];
    let viewsFailed = null;
    if (!flags["no-views"]) {
      try {
        const summary = regenerateViews(c.root, { env, nowMs });
        const failed = (summary.results ?? []).find((x) => x.action === "failed");
        if (failed) viewsFailed = `${failed.rel}: ${failed.error}`;
      } catch (err) {
        viewsFailed = String(err?.message ?? err);
      }
    }
    if (viewsFailed) warnings.push(`não regenerei as visões (${viewsFailed}) — o próximo hook as refaz`);
    const stage = typeof r.bead.fields.stage === "string" ? r.bead.fields.stage : null;
    out.json = { command: sub, id: r.id, status: r.bead.status, stage, path: r.rel, at: r.at, warnings };
    out.lines.push(`✓ ${r.id}: ${r.bead.status} → ${r.rel}`);
    for (const w of warnings) out.lines.push(`⚠ ${w}`);
    return finish(0);
  } catch (err) {
    if (err instanceof Usage) {
      out.json = { error: err.message, usage: true };
      if (!json) stderr.push(`[beads] ✗ ${err.message}`, USAGE);
      else stdout.push(JSON.stringify({ ok: false, ...out.json }));
      return { code: 2, stdout, stderr };
    }
    if (err instanceof Refusal) {
      if (json) stdout.push(JSON.stringify({ ok: false, ...(out.json ?? {}), error: err.message }));
      else stderr.push(`[beads] ✗ ${err.message}`);
      return { code: 1, stdout, stderr };
    }
    // Erro do sistema de arquivos que ninguém tratou (ENOENT, EACCES, EMFILE…): recusa com a
    // causa, em vez de uma pilha de exceção no terminal do agente.
    if (typeof err?.code === "string" && /^E[A-Z0-9]+$/.test(err.code)) {
      const message = `erro de disco (${err.code}): ${cleanText(err.message, 200)}`;
      if (json) stdout.push(JSON.stringify({ ok: false, error: message }));
      else stderr.push(`[beads] ✗ ${message}`);
      return { code: 1, stdout, stderr };
    }
    throw err;
  }
}
