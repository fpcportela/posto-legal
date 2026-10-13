// Núcleo do .beads no modelo por bead — contrato em aiteam/docs/beads-schema.md.
//
// Puro: recebe textos, devolve estado e visões. Quem lê disco e git são
// beads-io.mjs, as CLIs de aiteam/scripts/ e os hooks.
//
// Só depende de node:* e do js-yaml vendorizado. Hooks, CLIs, o brief e o guard
// carregam este módulo em node puro, numa worktree que pode não ter
// aiteam/node_modules; um import de pacote aqui desligaria esses gates em
// silêncio. O teste de dependências de beads-core.test.ts fixa a regra.
//
// Sem shebang: o vite-node quebra um módulo importado que tenha `#!` num
// checkout CRLF (ver session-brief-core.mjs).

import { createHash } from "node:crypto";
import { CORE_SCHEMA, dump, load } from "../vendor/js-yaml.mjs";

export const VIEW_VERSION = "2";
export const TASK_STATUSES = ["pending", "in_progress", "completed", "blocked"];
export const IMPL_MODELS = ["sonnet", "opus", "haiku"];
export const MAX_PATH_CHARS = 160;
export const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;
export const MAX_DESCRIPTION_CHARS = 140;
export const MAX_CONTEXT_SUMMARY_CHARS = 600;
// `trello` (§3.3): o shortLink do card de origem, só letras e números — nunca a URL inteira, que
// convida a variantes (`/c/x`, `/c/x/12-titulo`) que quebram a comparação por igualdade.
export const TRELLO_SHORTLINK = /^[A-Za-z0-9]+$/;
// O `id` do card na API do Trello (24 hex) também casa o regex acima, mas não é o shortLink (8 caracteres): o
// reconcile compara com o shortLink, então um id no campo nunca casaria. Recusa só o que é inequivocamente
// o id — o regex do shortLink não é apertado.
export const TRELLO_CARD_ID = /^[0-9a-f]{24}$/i;
// `trello_scope` (§3.3): `partial` = o card pede MENOS que o bead cobre. Ausente = escopos iguais.
export const TRELLO_SCOPES = ["partial"];
export const VIEW_HEADER = "# GERADO por aiteam/scripts/beads-views.mjs";
export const ACTIVE_PATH = ".beads/active.yaml";
export const INDEX_PATH = ".beads/index.yaml";

// §2: o que fica fora do git. A migração e o install.mjs garantem estas
// linhas com mergeGitignore — e só as acrescentam, nunca reescrevem o arquivo.
export const GITIGNORE_PATH = ".beads/.gitignore";
export const GITIGNORE = [
  "# .beads — aiteam/docs/beads-schema.md §2: visões geradas e estado local ficam fora do git.",
  "/active.yaml",
  "/index.yaml",
  "/*.editado-*",
  "/*.tmp-*",
  "/*.corrupt-*",
  "/session.local.json",
  "/cost-log.json",
  "/session-log.ndjson",
  "",
].join("\n");

/**
 * O .beads/.gitignore com as regras canônicas: vazio (ou ausente) vira o
 * canônico; senão acrescenta no fim só as regras que faltam, na quebra de
 * linha que o arquivo já usa. Idempotente.
 */
export function mergeGitignore(current) {
  if (current == null || current.trim() === "") return GITIGNORE;
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE.split("\n").filter((l) => l.startsWith("/") && !have.has(l));
  if (missing.length === 0) return current;
  const base = /\r?\n$/.test(current) ? current : `${current}${eol}`;
  return `${base}${missing.join(eol)}${eol}`;
}

const STATE_FIELDS = new Set(["status", "stage", "context_summary", "blockers", "note"]);
const DERIVED_FIELDS = new Set(["updated_at", "branches", "done", "updated"]);
const PROJECT_FIELDS = new Set(["phases", "focus_note"]);
const TEXT_FIELDS = new Set(["title", "description", "context_summary", "note", "focus_note"]);
const HTML = /<[a-z][^>]*>/i;

// Mesma tabela de aiteam/src/beads-schema.ts e do Bead Board (§5 do contrato).
const ROUTING_KEYWORDS = [
  "ui", "web", "design", "creative", "content", "landing", "panel", "social", "blog",
  "api", "infra", "database", "scaffold",
  "data", "etl", "rag", "vector",
  "sre", "finops", "observability", "sla", "cloud",
  "ux", "a11y", "journey", "wcag", "cro",
  "spec", "plan", "brainstorm", "research", "funnel",
  "devops", "docker", "terraform", "topology", "vps",
  "deploy", "release", "rollout", "rollback", "ship",
  "debug", "bugfix", "hotfix", "troubleshoot",
  "qa", "security", "audit", "review", "compliance",
];

// A ordem dos campos na visão: identidade, estado, definição, log, calculados.
const FIELD_ORDER = [
  "title", "description", "status", "stage", "phase", "effort", "impl_model",
  "estimated_time_m", "estimated_cost_usd", "context_summary", "related_files", "tags", "trello", "trello_scope", "blockers", "note",
];

const ACTIVE_HEADER = [
  `${VIEW_HEADER} — NÃO EDITE (ignorado pelo git; reescrito a cada hook).`,
  "# Registre estado em .beads/tasks/<id>/<sua-branch>.yaml · contrato: aiteam/docs/beads-schema.md",
];
const INDEX_HEADER = [`${VIEW_HEADER} — NÃO EDITE. grep aqui → id → .beads/tasks/<id>/`];

// forceQuotes: todo texto sai entre aspas, então um leitor com o schema padrão
// do js-yaml (o board, o zod) nunca transforma um timestamp em Date.
const VIEW_DUMP = { lineWidth: -1, noRefs: true, quotingType: '"', forceQuotes: true };
const INDEX_DUMP = { flowLevel: 1, lineWidth: -1, noRefs: true, quotingType: '"' };

const lf = (s) => String(s ?? "").replace(/\r\n/g, "\n");
const firstLine = (s) => String(s ?? "").split("\n")[0];

const encoder = new TextEncoder();
/** Ordem de bytes (UTF-8): a mesma em qualquer SO e em qualquer locale. */
export function byteCompare(a, b) {
  const x = encoder.encode(String(a));
  const y = encoder.encode(String(b));
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Texto de outra branch (título, origem, etapa) chega ao brief, ao terminal e ao board:
// é dado, nunca instrução (LLM01). O que o humano não vê e o modelo lê — tag chars
// (U+E0000…, que contrabandeiam ASCII), marcas de direção, largura zero, hífen suave,
// preenchimentos, seletores de variação, uso privado — sai inteiro, sem deixar espaço
// no meio da palavra; controle e separador de linha viram espaço.
const TO_SPACE = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const INVISIBLE = /[\p{Cf}\p{Co}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u034F\u115F\u1160\u3164\uFFA0]/gu;

/** Uma linha de texto de outra branch: sem invisível nem controle, em uma linha e com teto. Nunca confie nele como instrução. */
export function cleanText(value, max = 140) {
  const t = String(value ?? "").replace(INVISIBLE, "").replace(TO_SPACE, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(t); // pontos de código: o teto nunca parte um emoji ao meio
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : t;
}

// ── Tempo ────────────────────────────────────────────────────────────────────

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/** Milissegundos de um timestamp `YYYY-MM-DDTHH:MM:SS(.sss)?Z`, ou null. */
export function parseInstant(value) {
  if (typeof value !== "string" || !INSTANT.test(value)) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  // Date.parse rola data inexistente (30/02 vira 02/03, 24:00 vira o dia
  // seguinte); a volta para texto denuncia o rolamento.
  const expected = value.includes(".") ? value : value.replace(/Z$/, ".000Z");
  return new Date(ms).toISOString() === expected ? ms : null;
}

export function isoText(ms) {
  return new Date(ms).toISOString().replace(/\.000Z$/, "Z");
}

// ── Nomes ────────────────────────────────────────────────────────────────────

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BRANCH_CHARSET = /^[A-Za-z0-9._/-]+$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

function nameProblems(name, what) {
  if (typeof name !== "string" || name === "") return [`${what} vazio`];
  const problems = [];
  if (!NAME.test(name)) problems.push(`${what} "${name}" fora do charset [A-Za-z0-9._-] (começando por letra ou número)`);
  if (name.includes("..")) problems.push(`${what} "${name}" contém ".."`);
  if (name.endsWith(".")) problems.push(`${what} "${name}" termina em ponto (o Windows corta)`);
  if (WINDOWS_RESERVED.test(name.split(".")[0])) problems.push(`${what} "${name}" é nome reservado do Windows`);
  return problems;
}

/** Problemas de um id como nome de pasta (§3.4 item 5). */
export function idProblems(id) {
  return nameProblems(id, "id (nome da pasta)");
}

/** Problemas do nome de um arquivo de branch, sem o `.yaml` (§3.4 item 6). */
export function branchFileProblems(name) {
  return nameProblems(name, "nome de arquivo de branch");
}

/** Nome de arquivo de uma branch: `/` vira `-`; charset fora de [A-Za-z0-9._/-] não escreve. */
export function sanitizeBranch(branch) {
  const b = String(branch ?? "");
  if (b === "") return { file: null, reason: "sem branch (HEAD destacado?)" };
  if (!BRANCH_CHARSET.test(b)) {
    return { file: null, reason: `a branch "${b}" tem caractere fora de [A-Za-z0-9._/-] e não pode escrever beads` };
  }
  const file = b.replace(/\//g, "-");
  const problems = branchFileProblems(file);
  return problems.length ? { file: null, reason: problems.join("; ") } : { file };
}

// ── Formato de um arquivo (§3) ───────────────────────────────────────────────

function typeProblem(key, value) {
  switch (key) {
    case "title":
    case "description":
    case "context_summary":
    case "note":
    case "stage":
    case "effort":
    case "focus_note":
      return typeof value === "string" ? null : "tem de ser texto";
    case "status":
      return TASK_STATUSES.includes(value) ? null : `tem de ser um de ${TASK_STATUSES.join(" | ")} (veio ${JSON.stringify(value)})`;
    case "impl_model":
      return IMPL_MODELS.includes(value) ? null : `tem de ser um de ${IMPL_MODELS.join(" | ")} (veio ${JSON.stringify(value)})`;
    case "phase":
      return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
        ? null
        : "tem de ser número ou a key de uma fase";
    case "estimated_time_m":
    case "estimated_cost_usd":
      return typeof value === "number" && Number.isFinite(value) ? null : "tem de ser número sem aspas";
    case "related_files":
    case "tags":
    case "blockers":
      return Array.isArray(value) && value.every((v) => typeof v === "string") ? null : "tem de ser lista de texto";
    case "trello":
      return trelloProblem(value);
    case "trello_scope":
      return TRELLO_SCOPES.includes(value)
        ? null
        : `tem de ser ${TRELLO_SCOPES.join(" | ")} (veio ${show(value)}) — com o card cobrindo o bead inteiro, omita o campo`;
    case "phases":
      return phasesProblem(value);
    default:
      return null;
  }
}

// O valor num diagnóstico: em JSON e com teto, porque o texto vem de um arquivo qualquer.
function show(value) {
  const s = JSON.stringify(value) ?? String(value);
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}

function shortLinkProblem(v) {
  if (typeof v === "string") {
    if (TRELLO_CARD_ID.test(v)) return `esse é o id do card, não o shortLink — o shortLink é o último trecho de https://trello.com/c/<shortLink> (veio ${show(v)})`;
    return TRELLO_SHORTLINK.test(v) ? null : `tem de ser só o shortLink do card — letras e números, sem URL nem espaço (veio ${show(v)})`;
  }
  return `tem de ser o shortLink do card em texto, entre aspas — um shortLink só de dígitos, sem aspas, vira número no YAML (veio ${show(v)})`;
}

// `trello`: um shortLink ou uma lista deles (o bead que absorve mais de um card).
function trelloProblem(value) {
  if (!Array.isArray(value)) return shortLinkProblem(value);
  if (value.length === 0) return "tem de ter pelo menos um shortLink — sem card, omita o campo";
  for (const [i, v] of value.entries()) {
    const problem = shortLinkProblem(v);
    if (problem) return `[${i}] ${problem}`;
  }
  return null;
}

function phasesProblem(value) {
  if (!Array.isArray(value)) return "tem de ser uma lista de {key, name, subtitle?}";
  const keys = new Set();
  for (const [i, p] of value.entries()) {
    if (!p || typeof p !== "object" || Array.isArray(p)) return `[${i}] tem de ser {key, name, subtitle?}`;
    if (typeof p.key !== "string" || p.key === "") return `[${i}] sem key`;
    if (typeof p.name !== "string" || p.name === "") return `[${i}] sem name`;
    if (p.subtitle !== undefined && typeof p.subtitle !== "string") return `[${i}].subtitle tem de ser texto`;
    if (keys.has(p.key)) return `key "${p.key}" duplicada — as keys de fase são únicas`;
    keys.add(p.key);
  }
  return null;
}

function topProblem(kind, key, value) {
  if (kind === "project") {
    if (!PROJECT_FIELDS.has(key)) return `${key} não é campo de projeto (só phases e focus_note)`;
  } else {
    if (DERIVED_FIELDS.has(key)) return `${key} é calculado — não se escreve`;
    if (key === "at") return "at só vale dentro de entries";
    if (STATE_FIELDS.has(key) && key !== "status") return `${key} é campo de estado: vai numa entrada de entries`;
  }
  const problem = typeProblem(key, value);
  return problem ? `${key} ${problem}` : null;
}

function entryProblem(kind, key, value) {
  if (key === "created_at") return "created_at só vale no topo";
  if (kind === "project") {
    if (!PROJECT_FIELDS.has(key)) return `${key} não é campo de projeto (só phases e focus_note)`;
  } else {
    if (key === "id") return "id não vai em entries (é o nome da pasta)";
    if (DERIVED_FIELDS.has(key)) return `${key} é calculado — não se escreve`;
  }
  const problem = typeProblem(key, value);
  return problem ? `${key} ${problem}` : null;
}

function textWarnings(where, key, value) {
  if (!TEXT_FIELDS.has(key) || typeof value !== "string") return [];
  const warnings = [];
  if (value.includes("\n")) warnings.push(`${where}: ${key} tem mais de uma linha — use uma linha só`);
  if (HTML.test(value)) warnings.push(`${where}: ${key} contém HTML — use texto puro`);
  if (key === "description" && value.length > MAX_DESCRIPTION_CHARS) {
    warnings.push(`${where}: description passa de ${MAX_DESCRIPTION_CHARS} caracteres — o card do Kanban transborda`);
  }
  if (key === "context_summary" && value.length > MAX_CONTEXT_SUMMARY_CHARS) {
    warnings.push(`${where}: context_summary passa de ${MAX_CONTEXT_SUMMARY_CHARS} caracteres — até 3 frases`);
  }
  return warnings;
}

// `entries` tem de ser a última chave e uma lista em bloco: é o que faz o
// acréscimo de uma entrada ser um acréscimo no fim do arquivo (§3.4 itens 1-2).
// A checagem é no texto porque o objeto do js-yaml não guarda a ordem de chave
// numérica.
function entriesLayoutProblems(where, src) {
  const lines = src.split("\n");
  const i = lines.findIndex((l) => /^entries[ \t]*:/.test(l));
  if (i < 0) return [`${where}: escreva "entries:" no início da linha, sem aspas`];
  const problems = [];
  const rest = lines[i]
    .replace(/^entries[ \t]*:/, "")
    .replace(/(^|[ \t])#.*$/, "")
    .trim();
  if (rest !== "") {
    problems.push(
      `${where}: entries tem de ser lista em bloco (uma entrada por "- at: …"); flow style (entries: [] ou [{…}]) impede o acréscimo no fim — sem entradas, omita a chave`
    );
  }
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l === "" || /^[ \t]/.test(l) || l.startsWith("#") || /^-([ \t]|$)/.test(l)) continue;
    problems.push(`${where}: entries tem de ser a última chave do arquivo — o arquivo só cresce no fim`);
    break;
  }
  return problems;
}

// Aliases YAML custam pouco no load — o js-yaml reaproveita a mesma
// referência —, mas a visão expande tudo no dump. Um campo desconhecido com
// aliases aninhados (a "bomba de aliases") derrubaria todo hook e o início de
// sessão. A contagem anda pela árvore expandida e para no limite, então custa
// no máximo `limit` passos.
export const MAX_EXPANDED_NODES = 10_000;

function expandsBeyond(value, limit) {
  let count = 0;
  const stack = [value];
  while (stack.length) {
    const v = stack.pop();
    if (++count > limit) return true;
    if (v && typeof v === "object") {
      for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push(child);
    }
  }
  return false;
}

function parseFile(where, text, { kind, id, nowMs }) {
  const errors = [];
  const warnings = [];
  const out = { errors, warnings, assertions: [], definition: false, createdMs: null };
  const src = lf(text);

  let doc;
  try {
    doc = load(src, { schema: CORE_SCHEMA, filename: where });
  } catch (err) {
    errors.push(`${where}: YAML inválido — ${firstLine(err?.message)}`);
    return out;
  }
  if (doc === undefined || doc === null) {
    errors.push(`${where}: arquivo vazio`);
    return out;
  }
  if (typeof doc !== "object" || Array.isArray(doc)) {
    errors.push(`${where}: o topo tem de ser um mapeamento (campo: valor)`);
    return out;
  }
  if (expandsBeyond(doc, MAX_EXPANDED_NODES)) {
    errors.push(`${where}: estrutura grande demais (mais de ${MAX_EXPANDED_NODES} nós ao expandir — aliases YAML aninhados?)`);
    return out;
  }

  const hasEntries = Object.prototype.hasOwnProperty.call(doc, "entries");
  if (hasEntries) errors.push(...entriesLayoutProblems(where, src));

  const top = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key === "entries" || key === "created_at") continue;
    if (kind === "bead" && key === "id") {
      if (value !== id) errors.push(`${where}: id "${value}" no topo difere da pasta "${id}"`);
      continue;
    }
    const problem = topProblem(kind, key, value);
    if (problem) {
      errors.push(`${where}: ${problem}`);
      continue;
    }
    top[key] = value;
    warnings.push(...textWarnings(where, key, value));
  }

  const hasCreatedAt = Object.prototype.hasOwnProperty.call(doc, "created_at");
  if (Object.keys(top).length > 0 || hasCreatedAt) {
    out.definition = true;
    if (!hasCreatedAt) {
      errors.push(`${where}: o topo traz campos e falta created_at — o topo vale como asserção nessa data`);
    } else {
      const t = parseInstant(doc.created_at);
      if (t === null) {
        errors.push(`${where}: created_at ${JSON.stringify(doc.created_at)} fora do formato YYYY-MM-DDTHH:MM:SS(.sss)Z`);
      } else if (t > nowMs + FUTURE_TOLERANCE_MS) {
        errors.push(`${where}: created_at ${doc.created_at} está mais de 24 h no futuro`);
      } else {
        out.createdMs = t;
        if (Object.keys(top).length > 0) out.assertions.push({ t, pos: 0, fields: top });
      }
    }
  }

  if (hasEntries) {
    if (!Array.isArray(doc.entries)) {
      errors.push(`${where}: entries tem de ser uma lista`);
    } else {
      doc.entries.forEach((entry, i) => {
        const at = `${where} entries[${i}]`;
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          errors.push(`${at}: cada entrada é um mapeamento com at`);
          return;
        }
        let t = null;
        if (!Object.prototype.hasOwnProperty.call(entry, "at")) {
          errors.push(`${at}: falta at`);
        } else {
          t = parseInstant(entry.at);
          if (t === null) errors.push(`${at}: at ${JSON.stringify(entry.at)} fora do formato YYYY-MM-DDTHH:MM:SS(.sss)Z`);
          else if (t > nowMs + FUTURE_TOLERANCE_MS) {
            errors.push(`${at}: at ${entry.at} está mais de 24 h no futuro`);
            t = null;
          }
        }
        const fields = {};
        for (const [key, value] of Object.entries(entry)) {
          if (key === "at") continue;
          const problem = entryProblem(kind, key, value);
          if (problem) {
            errors.push(`${at}: ${problem}`);
            continue;
          }
          fields[key] = value;
          warnings.push(...textWarnings(at, key, value));
        }
        if (Object.keys(fields).length === 0) warnings.push(`${at}: entrada sem asserção (só at)`);
        if (t !== null) out.assertions.push({ t, pos: i + 1, fields });
      });
    }
  }

  if (!out.definition && !hasEntries) errors.push(`${where}: arquivo sem definição e sem entries`);
  return out;
}

// ── Combinação (§4) ──────────────────────────────────────────────────────────

const compareAssertion = (a, b) => a.t - b.t || byteCompare(a.file, b.file) || a.pos - b.pos;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Campo → asserção vencedora: a de instante maior; no empate, a do arquivo de
 * nome maior em ordem de bytes; no mesmo arquivo, a mais abaixo. O aviso de
 * empate entre branches é de combinação: vai também para `combination`.
 */
function winners(all, label, warnings, combination) {
  const won = new Map();
  for (const a of [...all].sort(compareAssertion)) {
    for (const key of Object.keys(a.fields)) won.set(key, a);
  }
  for (const [key, w] of won) {
    const rivals = all.filter((a) => a.file !== w.file && a.t === w.t && key in a.fields && !same(a.fields[key], w.fields[key]));
    if (rivals.length) {
      const files = [...new Set([w.file, ...rivals.map((r) => r.file)])].sort(byteCompare);
      const msg = `${label}: empate de horário em ${key} (${isoText(w.t)}) entre ${files.join(" e ")} — vence ${w.file}, o nome maior em ordem de bytes`;
      warnings.push(msg);
      combination.push(msg);
    }
  }
  return won;
}

function caseTwins(names) {
  const byLower = new Map();
  for (const n of names) {
    const k = n.toLowerCase();
    byLower.set(k, [...(byLower.get(k) ?? []), n]);
  }
  return [...byLower.values()].filter((g) => g.length > 1);
}

function parseAll(files, dirLabel, kind, id, nowMs, errors, warnings) {
  const parsed = [];
  for (const twins of caseTwins(files.map((f) => f.branchFile))) {
    errors.push(`${dirLabel}: arquivos ${twins.join(", ")} só diferem em maiúsculas e minúsculas`);
  }
  for (const f of files) {
    const where = `${dirLabel}${f.branchFile}.yaml`;
    const nameProblemsFound = branchFileProblems(f.branchFile);
    if (nameProblemsFound.length) {
      errors.push(...nameProblemsFound.map((p) => `${where}: ${p}`));
      continue;
    }
    if (where.length > MAX_PATH_CHARS) {
      warnings.push(`${where}: caminho com ${where.length} caracteres (> ${MAX_PATH_CHARS}) — no Windows, considere git config core.longpaths true`);
    }
    const r = parseFile(where, f.text, { kind, id, nowMs });
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    parsed.push({ ...r, file: f.branchFile });
  }
  return parsed;
}

/**
 * Combina os arquivos de branch de um bead (`.beads/tasks/<id>/*.yaml`).
 * `combination` é o subconjunto de `warnings` que nasce da combinação de
 * branches (empate, definição dupla, bead sem status) — o que o post-merge mostra.
 */
export function combineBead(id, files, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const dir = `.beads/tasks/${id}/`;
  const errors = idProblems(id).map((p) => `${dir}: ${p}`);
  const warnings = [];
  const combination = [];
  const both = (msg) => {
    warnings.push(msg);
    combination.push(msg);
  };
  if (!files || files.length === 0) errors.push(`${dir}: pasta sem arquivo de branch`);
  const parsed = parseAll(files ?? [], dir, "bead", id, nowMs, errors, warnings);
  if (errors.length) return { bead: null, errors, warnings, combination };

  const all = parsed.flatMap((p) => p.assertions.map((a) => ({ ...a, file: p.file })));
  if (all.length === 0) {
    errors.push(`${dir}: nenhuma asserção — o bead precisa de definição ou de entradas`);
    return { bead: null, errors, warnings, combination };
  }

  const definitions = parsed.filter((p) => p.definition);
  if (definitions.length > 1) {
    const by = definitions.map((p) => p.file).sort(byteCompare);
    both(`${dir}: definido por ${by.join(" e ")} — as definições valem, cada uma no seu created_at`);
  }
  const createdMs = definitions.length
    ? Math.min(...definitions.map((p) => p.createdMs))
    : Math.min(...all.map((a) => a.t));
  const updatedMs = Math.max(createdMs, ...all.map((a) => a.t));

  const won = winners(all, dir, warnings, combination);
  const fields = {};
  for (const [key, a] of won) fields[key] = a.fields[key];

  let status = fields.status;
  let doneMs;
  if (status === undefined) {
    status = "pending";
    both(`${dir}: nenhum status em lugar nenhum — fica pending`);
  } else if (status === "completed") {
    doneMs = won.get("status").t;
  }
  delete fields.status;

  if (fields.title === undefined && fields.description === undefined) {
    errors.push(`${dir}: sem title nem description — o card do Kanban fica sem texto`);
    return { bead: null, errors, warnings, combination };
  }
  // §3.3: a marca "o card cobre só parte" não existe sem o card. A regra é do bead combinado, não do
  // arquivo — o trello pode estar numa branch e o trello_scope em outra.
  if (fields.trello_scope !== undefined && fields.trello === undefined) {
    errors.push(`${dir}: trello_scope sem trello — a marca "${fields.trello_scope}" só tem sentido junto do card de origem (beads-schema.md §3.3)`);
    return { bead: null, errors, warnings, combination };
  }

  const bead = {
    id,
    status,
    created_at: isoText(createdMs),
    updated_at: isoText(updatedMs),
    createdMs,
    updatedMs,
    branches: parsed.map((p) => p.file).sort(byteCompare),
    fields,
  };
  if (doneMs !== undefined) {
    bead.done = isoText(doneMs);
    bead.doneMs = doneMs;
  }
  return { bead, errors, warnings, combination };
}

/** Combina `.beads/project/<branch>.yaml`: fases e foco (§6). */
export function combineProject(files, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const dir = ".beads/project/";
  const errors = [];
  const warnings = [];
  const combination = [];
  const parsed = parseAll(files ?? [], dir, "project", null, nowMs, errors, warnings);
  if (errors.length) return { errors, warnings, combination };
  const all = parsed.flatMap((p) => p.assertions.map((a) => ({ ...a, file: p.file })));
  const won = winners(all, dir, warnings, combination);
  const out = { errors, warnings, combination };
  if (won.has("phases")) out.phases = won.get("phases").fields.phases;
  if (won.has("focus_note")) out.focus_note = won.get("focus_note").fields.focus_note;
  return out;
}

/**
 * O estado combinado de todos os beads. `beadInputs` é a lista
 * `{bead, branchFile, text}` — a fase 2 só soma entradas vindas de refs.
 */
export function buildState(beadInputs, projectInputs = [], opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const groups = new Map();
  for (const x of beadInputs ?? []) {
    groups.set(x.bead, [...(groups.get(x.bead) ?? []), { branchFile: x.branchFile, text: x.text }]);
  }
  const twinsOf = new Map();
  for (const g of caseTwins([...groups.keys()])) for (const id of g) twinsOf.set(id, g.filter((x) => x !== id));

  const beads = [];
  const invalid = [];
  const errors = [];
  const warnings = [];
  const combination = [];
  for (const id of [...groups.keys()].sort(byteCompare)) {
    const r = combineBead(id, groups.get(id), { nowMs });
    warnings.push(...r.warnings);
    combination.push(...r.combination);
    const errs = [...r.errors];
    const twins = twinsOf.get(id);
    if (twins) errs.push(`.beads/tasks/${id}/: id colide com ${twins.join(", ")} ignorando maiúsculas e minúsculas — renomeie um deles`);
    if (errs.length || !r.bead) {
      invalid.push({ id, errors: errs });
      errors.push(...errs);
    } else {
      beads.push(r.bead);
    }
  }

  const project = combineProject(projectInputs ?? [], { nowMs });
  errors.push(...project.errors);
  warnings.push(...project.warnings);
  combination.push(...project.combination);

  const ids = new Set(groups.keys());
  const phaseKeys = new Set((project.phases ?? []).map((p) => p.key));
  for (const b of beads) {
    for (const blocker of Array.isArray(b.fields.blockers) ? b.fields.blockers : []) {
      if (!ids.has(blocker)) warnings.push(`.beads/tasks/${b.id}/: blocker "${blocker}" não casa id de bead nenhum`);
    }
    if (typeof b.fields.phase === "string" && phaseKeys.size > 0 && !phaseKeys.has(b.fields.phase)) {
      warnings.push(`.beads/tasks/${b.id}/: phase "${b.fields.phase}" não casa nenhuma key de phases`);
    }
    const idLower = b.id.toLowerCase();
    if (b.status !== "completed" && !idLower.startsWith("orch-") && !ROUTING_KEYWORDS.some((k) => idLower.includes(k))) {
      warnings.push(`.beads/tasks/${b.id}/: o id não tem palavra-chave de mesa — cai na mesa do Orchestrator (beads-schema.md §5)`);
    }
  }

  const projectOut = {};
  if (project.phases !== undefined) projectOut.phases = project.phases;
  if (project.focus_note !== undefined) projectOut.focus_note = project.focus_note;
  return { beads, invalid, errors, warnings, combination, project: projectOut };
}

// ── Visões (§7) ──────────────────────────────────────────────────────────────

function taskNode(b) {
  const f = { ...b.fields, status: b.status };
  const node = { id: b.id };
  for (const k of FIELD_ORDER) if (f[k] !== undefined) node[k] = f[k];
  for (const k of Object.keys(f).filter((k) => !FIELD_ORDER.includes(k)).sort(byteCompare)) node[k] = f[k];
  node.created_at = b.created_at;
  node.updated_at = b.updated_at;
  node.branches = b.branches;
  return node;
}

function withHeader(lines, state, body) {
  const skipped = state.invalid?.length ? ` · ${state.invalid.length} inválido(s) pulado(s)` : "";
  return `${[...lines, `# fonte: ${state.beads.length} beads${skipped} · sha256:${sha256(body)}`].join("\n")}\n${body}`;
}

/** `.beads/active.yaml`: só os beads vivos, no formato que o board e o brief leem. */
export function renderActiveView(state, meta) {
  const live = state.beads
    .filter((b) => b.status !== "completed")
    .sort((a, b) => a.createdMs - b.createdMs || byteCompare(a.id, b.id));
  const done = state.beads.filter((b) => b.status === "completed");
  const current = state.beads
    .filter((b) => b.status === "in_progress")
    .sort((a, b) => b.updatedMs - a.updatedMs || byteCompare(a.id, b.id))[0];

  const session = { budget_usd: meta.budgetUsd, cost_accumulated_usd: meta.costUsd };
  if (typeof current?.fields.stage === "string") session.current_task_phase = current.fields.stage;
  if (state.project?.focus_note !== undefined) session.focus_note = state.project.focus_note;

  const body = { version: VIEW_VERSION, project: meta.project ?? "", session };
  if (state.project?.phases !== undefined) body.phases = state.project.phases;
  body.archive = { count: done.length, index: INDEX_PATH };
  if (done.length) body.archive.last_archived_at = isoText(Math.max(...done.map((b) => b.doneMs)));
  body.tasks = live.map(taskNode);
  return withHeader(ACTIVE_HEADER, state, dump(body, VIEW_DUMP));
}

/** `.beads/index.yaml`: um bead por linha, do menos ao mais recente. */
export function renderIndexView(state) {
  const rows = [...state.beads]
    .sort((a, b) => a.updatedMs - b.updatedMs || byteCompare(a.id, b.id))
    .map((b) => {
      const e = { id: b.id, status: b.status };
      if (b.status === "completed") e.done = b.done.slice(0, 10);
      e.updated = b.updated_at.slice(0, 10);
      if (b.fields.effort !== undefined) e.effort = b.fields.effort;
      if (b.fields.impl_model !== undefined) e.model = b.fields.impl_model;
      if (Array.isArray(b.fields.tags) && b.fields.tags.length) e.tags = b.fields.tags;
      const title = b.fields.title ?? b.fields.description;
      if (title !== undefined) e.title = title;
      return e;
    });
  return withHeader(INDEX_HEADER, state, rows.length ? dump(rows, INDEX_DUMP) : "[]\n");
}

/**
 * "intact": visão gerada, corpo confere com o hash do cabeçalho.
 * "edited": tem o cabeçalho, mas o corpo foi mexido (ou o hash sumiu).
 * "foreign": não é visão gerada (o active.yaml do modelo antigo, por exemplo).
 */
export function viewIntegrity(text) {
  const src = lf(text);
  if (!src.startsWith(VIEW_HEADER)) return "foreign";
  const lines = src.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].startsWith("#")) i++;
  const m = lines
    .slice(0, i)
    .map((l) => / · sha256:([0-9a-f]{64})$/.exec(l))
    .find(Boolean);
  if (!m) return "edited";
  return sha256(lines.slice(i).join("\n")) === m[1] ? "intact" : "edited";
}

// ── Acréscimo só no fim (§3.4 item 2) ────────────────────────────────────────

// O que o doc parseado tem de comparável: aliases e erro de YAML saem da
// comparação — o erro de formato é de quem valida o arquivo (parseFile), e a
// checagem de prefixo já foi feita.
function docForCompare(text) {
  try {
    const doc = load(lf(text), { schema: CORE_SCHEMA });
    if (!doc || typeof doc !== "object" || Array.isArray(doc) || expandsBeyond(doc, MAX_EXPANDED_NODES)) return null;
    return doc;
  } catch {
    return null;
  }
}

// JSON com as chaves em ordem de bytes: igualdade semântica, sem depender da
// ordem em que o autor escreveu os campos.
function stable(value) {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => byteCompare(a, b))) : v
  );
}

// Quais campos de `a` para `b`: acrescentados, alterados e removidos.
function fieldDiff(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diff = { added: [], changed: [], removed: [] };
  for (const k of [...keys].sort(byteCompare)) {
    if (!(k in a)) diff.added.push(k);
    else if (!(k in b)) diff.removed.push(k);
    else if (stable(a[k]) !== stable(b[k])) diff.changed.push(k);
  }
  return diff;
}

// `place` = {to, at, of}: "ao topo" / "no topo" / "do topo", ou o equivalente da entrada.
function describeDiff(diff, place, tail) {
  const parts = [];
  const plural = (list, word) => `${list.join(", ")} ${word}${list.length > 1 ? "s" : ""}`;
  if (diff.added.length) parts.push(`${plural(diff.added, "acrescentado")} ${place.to}`);
  if (diff.changed.length) parts.push(`${plural(diff.changed, "alterado")} ${place.at}`);
  if (diff.removed.length) parts.push(`${plural(diff.removed, "removido")} ${place.of}`);
  return `${parts.join("; ")}${tail}`;
}

const APPEND_HINT = 'o arquivo só cresce no fim (contrato §3.4): comece uma entrada nova com "- at:"';

/**
 * Por que `staged` não é um acréscimo no fim de `committed` (§3.4 item 2), ou
 * null se é. Duas camadas:
 *  1. o texto commitado é prefixo do novo, em LF — e o acréscimo começa em
 *     linha nova (sem quebra de linha no fim, "prefixo" deixaria editar a última
 *     linha acrescentando caracteres a ela);
 *  2. a comparação já parseada (R6): o topo (sem `entries`) é igual e as
 *     entradas que já estavam commitadas são iguais às N primeiras do novo. Sem
 *     isso, uma linha `stage: "review"` anexada à última entrada commitada
 *     passaria no prefixo e valeria com o `at` antigo.
 */
export function appendOnlyProblem(committed, staged) {
  const before = lf(committed);
  const after = lf(staged);
  if (!after.startsWith(before)) {
    return "o conteúdo já commitado mudou — o arquivo só cresce no fim (contrato §3.4). Desfaça a edição e acrescente uma entrada nova que corrija o campo; num merge ou squash, fique com a versão mais longa.";
  }
  if (!(after.length === before.length || before === "" || before.endsWith("\n") || after[before.length] === "\n")) {
    return `o acréscimo tem de começar em linha nova — ${APPEND_HINT}`;
  }
  if (after.length === before.length) return null;

  const was = docForCompare(before);
  const now = docForCompare(after);
  if (!was || !now) return null;

  const { entries: wasEntries, ...wasTop } = was;
  const { entries: nowEntries, ...nowTop } = now;
  const topDiff = fieldDiff(wasTop, nowTop);
  if (topDiff.added.length || topDiff.changed.length || topDiff.removed.length) {
    return `${describeDiff(topDiff, { to: "ao topo", at: "no topo", of: "do topo" }, ", já commitado")} — a definição não muda depois do commit: ${APPEND_HINT} (os campos de definição também valem dentro de entries)`;
  }
  const oldList = Array.isArray(wasEntries) ? wasEntries : [];
  if (!Array.isArray(nowEntries)) return oldList.length ? `entries deixou de ser uma lista — ${APPEND_HINT}` : null;
  if (nowEntries.length < oldList.length) {
    return `${oldList.length - nowEntries.length} entrada(s) já commitada(s) sumiram — ${APPEND_HINT}`;
  }
  for (let i = 0; i < oldList.length; i++) {
    if (stable(oldList[i]) === stable(nowEntries[i])) continue;
    const a = oldList[i] && typeof oldList[i] === "object" ? oldList[i] : {};
    const b = nowEntries[i] && typeof nowEntries[i] === "object" ? nowEntries[i] : {};
    const at = typeof a.at === "string" ? ` (at ${a.at})` : "";
    const place = { to: `à entrada ${i + 1}${at}`, at: `na entrada ${i + 1}${at}`, of: `da entrada ${i + 1}${at}` };
    return `${describeDiff(fieldDiff(a, b), place, ", já commitada")} — ${APPEND_HINT}`;
  }
  return null;
}

/** O conteúdo commitado é prefixo do novo, e as entradas já commitadas ficaram iguais (§3.4 item 2). */
export function isAppendOnly(committed, staged) {
  return appendOnlyProblem(committed, staged) === null;
}

// ── Escrita (§3, §9): o que o comando beads e a migração usam ────────────────
//
// Todo valor passa pelo dump do js-yaml com aspas forçadas (VIEW_DUMP): texto
// com `"`, `:`, `#` ou uma quebra de linha nunca vira estrutura do YAML.

// Os campos de definição, na ordem em que o arquivo do bead os escreve (§3.3).
const DEFINITION_ORDER = [
  "title", "description", "phase", "effort", "impl_model",
  "estimated_time_m", "estimated_cost_usd", "related_files", "tags", "trello", "trello_scope",
];

/**
 * O arquivo de definição de um bead novo: os campos de definição no topo e o
 * `created_at` por último, sem `entries` (o acréscimo de entradas cria a chave
 * no fim). Lista vazia e campo ausente dizem o mesmo e são omitidos. A
 * validade é de quem chama: rode o combineBead sobre o resultado.
 */
export function renderDefinition(fields, createdMs) {
  const top = {};
  const present = (k) => fields[k] !== undefined && !(Array.isArray(fields[k]) && fields[k].length === 0);
  for (const k of DEFINITION_ORDER) if (present(k)) top[k] = fields[k];
  const others = Object.keys(fields).filter((k) => !DEFINITION_ORDER.includes(k) && k !== "created_at" && k !== "entries");
  for (const k of others.sort(byteCompare)) if (present(k)) top[k] = fields[k];
  top.created_at = isoText(createdMs);
  return dump(top, VIEW_DUMP);
}

// A indentação dos itens de uma lista `entries:` que já existe no arquivo.
function entryIndent(text) {
  const lines = lf(text).split("\n");
  const i = lines.findIndex((l) => /^entries[ \t]*:/.test(l));
  for (let j = i + 1; i >= 0 && j < lines.length; j++) {
    const m = /^([ \t]*)-([ \t]|$)/.exec(lines[j]);
    if (m) return m[1];
  }
  return "  ";
}

/**
 * Acrescenta uma entrada no fim de um arquivo de bead, sem tocar no que já
 * existe: cria a chave `entries:` quando falta, segue a indentação da lista e
 * preserva a quebra de linha do arquivo (CRLF fica CRLF). `existing` null ou
 * vazio é o arquivo novo de um adendo.
 */
export function appendEntry(existing, entry) {
  const src = existing == null ? "" : existing;
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const base = src === "" || src.endsWith("\n") ? src : `${src}${eol}`;
  const hasEntries = /^entries[ \t]*:/m.test(lf(base));
  const indent = hasEntries ? entryIndent(base) : "  ";
  const item = dump([entry], VIEW_DUMP)
    .split("\n")
    .map((l) => (l === "" ? l : `${indent}${l}`))
    .join("\n");
  const add = `${hasEntries ? "" : "entries:\n"}${item}`;
  return `${base}${eol === "\r\n" ? add.replace(/\n/g, "\r\n") : add}`;
}

/** Quanto à frente do relógio um `at` pode ficar antes de o comando avisar. */
export const AT_AHEAD_WARN_MS = 5 * 60 * 1000;

/**
 * O `at` da entrada nova: o maior entre o agora (em segundos inteiros) e 1 s
 * depois da maior asserção do bead (`assertedMs`). Com o relógio atrasado em
 * relação a quem escreveu antes, a entrada nova ainda vence (§4). `aheadMs` é
 * quanto o horário passou do agora.
 */
export function nextAt(nowMs, assertedMs = null) {
  const floorNow = Math.floor(nowMs / 1000) * 1000;
  const after = typeof assertedMs === "number" && Number.isFinite(assertedMs) ? Math.floor(assertedMs / 1000) * 1000 + 1000 : -Infinity;
  const ms = Math.max(floorNow, after);
  return { ms, at: isoText(ms), aheadMs: Math.max(0, ms - nowMs) };
}

// ── Escolha da versão de cada arquivo (fase 2: agregação entre branches) ─────

// Ordem de preferência entre fontes: a árvore é a verdade local; depois a
// worktree (estado não commitado, o mais recente), o head local e o remoto.
const SOURCE_RANK = { tree: 0, worktree: 1, head: 2, remote: 3 };
const rankOf = (source) => SOURCE_RANK[source?.kind] ?? 9;

/** Como uma fonte de versão aparece nas mensagens: `<branch> (local <sha7>)`. */
export function sourceLabel(source) {
  const name = source?.display ?? source?.branch;
  const branch = name ? `${name} ` : "";
  switch (source?.kind) {
    case "tree":
      return "esta árvore";
    case "worktree":
      return `${branch}(worktree, não commitado)`.trim();
    case "head":
      return `${branch}(local${source.sha7 ? ` ${source.sha7}` : ""})`.trim();
    case "remote":
      return `${branch}(remoto${source.sha7 ? ` ${source.sha7}` : ""})`.trim();
    default:
      return String(source?.kind ?? "?");
  }
}

// O dono do arquivo `<branchFile>.yaml` é a branch cujo nome, com `/` trocado por `-`, é aquele
// arquivo. Refs com o mesmo sha viram uma fonte só, que guarda os outros nomes em `aliases`.
const isOwner = (v) =>
  [v.source?.branch, ...(Array.isArray(v.source?.aliases) ? v.source.aliases : [])].some(
    (b) => typeof b === "string" && sanitizeBranch(b).file === v.branchFile
  );

const byRankThenLength = (a, b) => rankOf(a.source) - rankOf(b.source) || lf(b.text).length - lf(a.text).length;

/**
 * Para cada par (bead, arquivo de branch), escolhe a versão entre as que vêm
 * da árvore, dos refs e das outras worktrees. `versions`:
 * `{bead, branchFile, text, source: {kind: tree|worktree|head|remote, branch?, …}}`.
 *
 * Como os arquivos só crescem no fim, as versões de um mesmo arquivo formam uma
 * cadeia por prefixo (com o teste estrutural do appendOnlyProblem) e vence a
 * mais longa. Se não formam cadeia (amend, rebase, edição à mão), sai o aviso
 * "versões divergentes" e vence a versão do dono; sem dono, a da árvore; sem
 * árvore, a de melhor ordem. `chain` traz as fontes que concordam com a vencedora.
 */
export function pickVersions(versions) {
  const groups = new Map();
  for (const v of versions ?? []) {
    const key = `${v.bead}\0${v.branchFile}`;
    groups.set(key, [...(groups.get(key) ?? []), v]);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const [ab, af] = a.split("\0");
    const [bb, bf] = b.split("\0");
    return byteCompare(ab, bb) || byteCompare(af, bf);
  });

  const picked = [];
  const warnings = [];
  for (const key of keys) {
    const cands = groups.get(key);
    const { bead, branchFile } = cands[0];
    const longest = [...cands].sort((a, b) => lf(b.text).length - lf(a.text).length || rankOf(a.source) - rankOf(b.source))[0];
    const isChain = cands.every((c) => appendOnlyProblem(c.text, longest.text) === null);
    let winner;
    let chain;
    if (isChain) {
      const top = lf(longest.text);
      winner = cands.filter((c) => lf(c.text) === top).sort(byRankThenLength)[0];
      chain = [...cands].sort((a, b) => lf(b.text).length - lf(a.text).length || rankOf(a.source) - rankOf(b.source));
    } else {
      winner = cands.filter(isOwner).sort(byRankThenLength)[0] ?? cands.find((c) => c.source?.kind === "tree") ?? [...cands].sort(byRankThenLength)[0];
      chain = cands.filter((c) => appendOnlyProblem(c.text, winner.text) === null);
      const who = cands.map((c) => sourceLabel(c.source)).join(", ");
      warnings.push(
        `.beads/tasks/${bead}/${branchFile}.yaml: versões divergentes (${who}) — uma não é acréscimo da outra (amend, rebase ou edição à mão); vale a de ${sourceLabel(winner.source)}`
      );
    }
    picked.push({ bead, branchFile, text: winner.text, source: winner.source, chain: chain.map((c) => ({ source: c.source, text: c.text })) });
  }
  return { picked, warnings };
}
