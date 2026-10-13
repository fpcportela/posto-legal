// I/O do .beads: lê a árvore, o índice do git e o HEAD, e escreve as visões.
// A lógica (formato, combinação, render) é de beads-core.mjs; aqui só o disco
// e o git. Contrato: aiteam/docs/beads-schema.md.
//
// Mesma regra do núcleo: só node:*, caminhos relativos e o vendor — as CLIs,
// os hooks, o brief e o guard rodam este módulo sem aiteam/node_modules.
// Sem shebang (ver beads-core.mjs).

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { CORE_SCHEMA, load } from "../vendor/js-yaml.mjs";
import { extractFrontmatter } from "./frontmatter.mjs";
import {
  ACTIVE_PATH,
  INDEX_PATH,
  buildState,
  combineBead,
  appendOnlyProblem,
  combineProject,
  renderActiveView,
  renderIndexView,
  sanitizeBranch,
  VIEW_HEADER,
  viewIntegrity,
} from "./beads-core.mjs";

export const LOCAL_SESSION_PATH = ".beads/session.local.json";
const LOCAL_FILES = new Set(["session.local.json", "cost-log.json", "session-log.ndjson"]);
const FREE_FILES = new Set(["SCHEMA.md", "BACKLOG.md", ".gitignore"]);

// ── git ──────────────────────────────────────────────────────────────────────

/** Roda git no repo; nunca lança. */
export function git(root, args, opts = {}) {
  try {
    // Saída em Buffer: sem `encoding` (o padrão já é buffer) e com o input já
    // em Buffer — `encoding: "buffer"` com input texto lança no Node.
    const r = spawnSync("git", args, {
      cwd: root,
      input: opts.input === undefined ? undefined : Buffer.from(opts.input, "utf8"),
      ...(opts.buffer ? {} : { encoding: "utf8" }),
      ...(opts.timeout ? { timeout: opts.timeout } : {}),
      maxBuffer: 512 * 1024 * 1024,
      windowsHide: true,
    });
    return { status: r.status ?? 1, stdout: r.stdout ?? (opts.buffer ? Buffer.alloc(0) : ""), stderr: r.stderr ?? "" };
  } catch (err) {
    return { status: 1, stdout: opts.buffer ? Buffer.alloc(0) : "", stderr: String(err?.message ?? err) };
  }
}

/** Raiz do repo (git toplevel) a partir de um diretório; null fora de um repo. */
export function gitTopLevel(cwd) {
  const r = git(cwd, ["rev-parse", "--show-toplevel"]);
  return r.status === 0 && r.stdout.trim() ? path.resolve(r.stdout.trim()) : null;
}

/**
 * A branch atual. `git symbolic-ref` funciona até em branch sem commit; em
 * HEAD destacado no meio de um rebase, a branch vem de rebase-merge/head-name
 * ou rebase-apply/head-name. Sem branch: `{branch: null, sha}`.
 */
export function currentBranch(root) {
  // Sem --short: com uma tag de mesmo nome ele devolveria "heads/<branch>".
  const sym = git(root, ["symbolic-ref", "-q", "HEAD"]);
  const ref = sym.status === 0 ? sym.stdout.trim().replace(/^refs\/heads\//, "") : "";
  if (ref) return { branch: ref, sha: null };
  const gitDir = git(root, ["rev-parse", "--git-dir"]);
  if (gitDir.status === 0) {
    for (const f of ["rebase-merge/head-name", "rebase-apply/head-name"]) {
      try {
        const ref = fs.readFileSync(path.resolve(root, gitDir.stdout.trim(), f), "utf8").trim();
        if (ref) return { branch: ref.replace(/^refs\/heads\//, ""), sha: null };
      } catch {
        /* sem rebase em curso */
      }
    }
  }
  const sha = git(root, ["rev-parse", "--short=7", "HEAD"]);
  return { branch: null, sha: sha.status === 0 ? sha.stdout.trim() : null };
}

export function isTracked(root, rel, opts = {}) {
  return git(root, ["ls-files", "--error-unmatch", "--", rel], { timeout: opts.timeout }).status === 0;
}

/**
 * Modo legado (§11): o HEAD tem o .beads/active.yaml do modelo antigo (não a
 * visão gerada) E o índice ainda o tem. A decisão vem do HEAD, nunca só do
 * índice: criar .beads/tasks/ num consumidor legado não desliga o modo, e
 * forçar um active.yaml no stage de um repo migrado não o religa. O commit da
 * migração tira o arquivo do índice — por isso sai do legado.
 */
export function isLegacy(root, opts = {}) {
  const head = catFiles(root, [`HEAD:${ACTIVE_PATH}`], opts).get(`HEAD:${ACTIVE_PATH}`);
  if (typeof head !== "string") return false;
  if (head.replace(/\r\n/g, "\n").startsWith(VIEW_HEADER)) return false;
  return isTracked(root, ACTIVE_PATH, opts);
}

/**
 * Lê vários objetos de uma vez (`git cat-file --batch`). Nomes como
 * `:<caminho>` (índice) ou `HEAD:<caminho>`. Ausente → null.
 */
export function catFiles(root, names, opts = {}) {
  const out = new Map();
  if (names.length === 0) return out;
  const r = git(root, ["cat-file", "--batch"], { input: `${names.join("\n")}\n`, buffer: true, timeout: opts.timeout });
  if (r.status !== 0) throw new Error(`git cat-file --batch falhou: ${String(r.stderr).trim()}`);
  const buf = r.stdout;
  let pos = 0;
  for (const name of names) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = buf.subarray(pos, nl).toString("utf8");
    pos = nl + 1;
    // "<sha> <tipo> <tamanho>" traz conteúdo; "<nome> missing" não traz.
    const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
    if (!m) {
      out.set(name, null);
      continue;
    }
    const size = Number(m[2]);
    out.set(name, m[1] === "blob" ? buf.subarray(pos, pos + size).toString("utf8") : null);
    pos += size + 1;
  }
  return out;
}

/**
 * O tamanho de vários blobs sem ler o conteúdo (`git cat-file --batch-check`):
 * nome → bytes, ou null se ausente ou se não é blob. Quem lê arquivo de outra
 * branch confere isto antes — um blob de centenas de MB não pode entrar na
 * memória nem estourar o buffer do `--batch`. Um nome com caractere de controle
 * (quebra de linha, principalmente) desalinharia a saída: fica null, sem ir ao git.
 */
export function catSizes(root, names, opts = {}) {
  const out = new Map();
  const safe = names.filter((n) => !/[\u0000-\u001f\u007f]/.test(n));
  for (const n of names) if (!safe.includes(n)) out.set(n, null);
  if (safe.length === 0) return out;
  const r = git(root, ["cat-file", "--batch-check=%(objecttype) %(objectsize)"], { input: `${safe.join("\n")}\n`, timeout: opts.timeout });
  if (r.status !== 0) throw new Error(`git cat-file --batch-check falhou: ${String(r.stderr).trim()}`);
  // Um objeto corrompido o git conta como "missing" e só reclama no stderr, com
  // status 0: quem quiser saber pede `diag`, e o erro vira aviso, não silêncio.
  if (opts.diag && String(r.stderr).trim()) opts.diag.push(String(r.stderr).trim());
  const lines = String(r.stdout).split("\n");
  safe.forEach((name, i) => {
    const m = /^blob (\d+)$/.exec(lines[i] ?? "");
    out.set(name, m ? Number(m[1]) : null);
  });
  return out;
}

/** Mudanças staged sob .beads/: `[{status, path}]`, sem detecção de rename. */
export function stagedChanges(root) {
  const r = git(root, ["diff", "--cached", "--name-status", "--no-renames", "-z", "--", ".beads"]);
  const parts = String(r.stdout).split("\0");
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (!parts[i]) break;
    out.push({ status: parts[i][0], path: parts[i + 1] });
  }
  return out;
}

/** Caminhos no índice do git sob os pathspecs dados. */
export function indexPaths(root, specs) {
  const r = git(root, ["ls-files", "-z", "--", ...specs]);
  return String(r.stdout).split("\0").filter(Boolean);
}

// ── Caminhos ─────────────────────────────────────────────────────────────────

/**
 * Classe de um caminho relativo à raiz, nos termos da tabela da §8 do contrato.
 * task/project trazem o id e o nome do arquivo de branch.
 */
export function classifyBeadsPath(rel) {
  const p = String(rel).replace(/\\/g, "/");
  if (!p.startsWith(".beads/")) return { kind: "outside" };
  const sub = p.slice(".beads/".length);
  let m;
  if ((m = /^tasks\/([^/]+)\/([^/]+)\.yaml$/.exec(sub))) return { kind: "task", id: m[1], branchFile: m[2] };
  if (sub === "tasks" || sub.startsWith("tasks/")) return { kind: "stray" };
  if ((m = /^project\/([^/]+)\.yaml$/.exec(sub))) return { kind: "project", branchFile: m[1] };
  if (sub === "project" || sub.startsWith("project/")) return { kind: "stray" };
  if (sub === "active.yaml" || sub === "index.yaml") return { kind: "view" };
  if (!sub.includes("/") && sub.includes(".editado-")) return { kind: "backup" };
  // .tmp-<pid>: escrita atômica em curso; .corrupt-<ts>: cópia de um
  // session.local.json ilegível guardada pelo FileCostStore (§10).
  if (LOCAL_FILES.has(sub) || /\.tmp-\d+$/.test(sub) || (!sub.includes("/") && sub.includes(".corrupt-"))) return { kind: "local" };
  if (sub.startsWith("archive/")) return { kind: "archive" };
  if (/^[^/]+\.yaml$/.test(sub)) return { kind: "mirror" };
  if (FREE_FILES.has(sub)) return { kind: "free" };
  return { kind: "other" };
}

/** O arquivo certo para a branch atual escrever, dado um caminho de bead ou de projeto. */
export function ownPathFor(c, branchFile) {
  return c.kind === "project" ? `.beads/project/${branchFile}.yaml` : `.beads/tasks/${c.id}/${branchFile}.yaml`;
}

// ── Leitura da árvore ────────────────────────────────────────────────────────

function dirEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Os arquivos de bead e de projeto da árvore, mais o que não devia estar lá. */
export function readTreeInputs(root) {
  const beads = [];
  const project = [];
  const strays = [];
  const tasksDir = path.join(root, ".beads", "tasks");
  for (const d of dirEntries(tasksDir)) {
    if (!d.isDirectory()) {
      strays.push(`.beads/tasks/${d.name}`);
      continue;
    }
    for (const f of dirEntries(path.join(tasksDir, d.name))) {
      const rel = `.beads/tasks/${d.name}/${f.name}`;
      if (f.isFile() && f.name.endsWith(".yaml")) {
        beads.push({ bead: d.name, branchFile: f.name.slice(0, -5), text: fs.readFileSync(path.join(tasksDir, d.name, f.name), "utf8") });
      } else {
        strays.push(rel);
      }
    }
  }
  const projectDir = path.join(root, ".beads", "project");
  for (const f of dirEntries(projectDir)) {
    if (f.isFile() && f.name.endsWith(".yaml")) {
      project.push({ branchFile: f.name.slice(0, -5), text: fs.readFileSync(path.join(projectDir, f.name), "utf8") });
    } else {
      strays.push(`.beads/project/${f.name}`);
    }
  }
  return { beads, project, strays };
}

/** Os ids (nomes de pasta) de `.beads/tasks/`, sem ler nenhum arquivo. */
export function listBeadIds(root) {
  return dirEntries(path.join(root, ".beads", "tasks"))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/** Os arquivos `<branch>.yaml` de um bead, lidos do disco: `[{branchFile, text}]`. */
export function readBeadFiles(root, id) {
  const dir = path.join(root, ".beads", "tasks", id);
  const out = [];
  for (const f of dirEntries(dir)) {
    if (!f.isFile() || !f.name.endsWith(".yaml")) continue;
    try {
      out.push({ branchFile: f.name.slice(0, -5), text: fs.readFileSync(path.join(dir, f.name), "utf8") });
    } catch {
      /* sumiu entre a listagem e a leitura */
    }
  }
  return out;
}

/** Os arquivos de bead e de projeto como estão no índice do git (o que vai no commit). */
export function readIndexInputs(root) {
  const paths = indexPaths(root, [".beads/tasks", ".beads/project"]);
  const blobs = catFiles(root, paths.map((p) => `:${p}`));
  const beads = [];
  const project = [];
  const strays = [];
  for (const p of paths) {
    const c = classifyBeadsPath(p);
    const text = blobs.get(`:${p}`);
    if (c.kind === "task" && text != null) beads.push({ bead: c.id, branchFile: c.branchFile, text });
    else if (c.kind === "project" && text != null) project.push({ branchFile: c.branchFile, text });
    else if (c.kind === "stray") strays.push(p);
  }
  return { beads, project, strays };
}

/**
 * Resto do modelo antigo rastreado num repo já migrado (§11): espelho,
 * archive/, visão ou estado local no índice ao lado de .beads/tasks/. É o que
 * uma branch aberta antes da migração traz num merge limpo.
 */
export function legacyResidue(root) {
  if (indexPaths(root, [".beads/tasks", ".beads/project"]).length === 0) return [];
  return indexPaths(root, [".beads"]).filter((p) => UNTRACKED_KINDS.has(classifyBeadsPath(p).kind));
}

// ── Metadados da sessão ──────────────────────────────────────────────────────

/** "Agora" — `BEADS_NOW` é a costura dos testes. */
export function nowFromEnv(env = process.env) {
  const t = env.BEADS_NOW ? Date.parse(env.BEADS_NOW) : NaN;
  return Number.isFinite(t) ? t : Date.now();
}

/**
 * project e budget do frontmatter do SPEC.md, com a mesma precedência do
 * readBudget do circuit breaker: SPEC (número finito e positivo) → env
 * AI_SESSION_BUDGET_USD → 2.
 */
export function readSpecMeta(root, env = process.env) {
  let project = "";
  let budget = null;
  try {
    const fm = extractFrontmatter(fs.readFileSync(path.join(root, "SPEC.md"), "utf8"));
    const doc = fm ? load(fm, { schema: CORE_SCHEMA }) : null;
    if (typeof doc?.project === "string") project = doc.project;
    const b = doc?.budget_usd;
    if (typeof b === "number" && Number.isFinite(b) && b > 0) budget = b;
  } catch {
    /* sem SPEC.md ou frontmatter inválido: valem os padrões */
  }
  if (budget === null) {
    const e = parseFloat(env.AI_SESSION_BUDGET_USD ?? "");
    if (Number.isFinite(e) && e > 0) budget = e;
  }
  return { project, budgetUsd: budget ?? 2 };
}

/** Custo e circuit breaker da sessão, do arquivo local (§10). */
export function readLocalSession(root) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, ...LOCAL_SESSION_PATH.split("/")), "utf8"));
    const c = j?.cost_accumulated_usd;
    return {
      costUsd: typeof c === "number" && Number.isFinite(c) && c >= 0 ? c : 0,
      circuitOpen: j?.circuit_open === true,
    };
  } catch {
    return { costUsd: 0, circuitOpen: false };
  }
}

// ── Escrita ──────────────────────────────────────────────────────────────────

const RETRY_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);
const RETRY_DELAYS_MS = [25, 50, 100, 200, 400];

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Temporário + rename, com novas tentativas em EBUSY/EPERM (antivírus,
 * indexador e sync de nuvem seguram arquivos no Windows). Se falhar, o
 * arquivo anterior fica intacto e o temporário some.
 */
export function writeFileAtomic(target, content) {
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, "utf8");
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (err) {
      if (RETRY_CODES.has(err?.code) && i < RETRY_DELAYS_MS.length) {
        sleep(RETRY_DELAYS_MS[i]);
        continue;
      }
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* o erro que importa é o do rename */
      }
      throw err;
    }
  }
}

function compactStamp(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

function backupPath(root, rel, nowMs) {
  const base = `${rel}.editado-${compactStamp(nowMs)}`;
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!fs.existsSync(path.join(root, ...candidate.split("/")))) return candidate;
  }
}

function writeView(root, rel, content, nowMs) {
  const target = path.join(root, ...rel.split("/"));
  let prev = null;
  try {
    prev = fs.readFileSync(target, "utf8");
  } catch {
    prev = null;
  }
  if (prev === content) {
    // Mesmo conteúdo: só o mtime anda, para o board não achar a visão velha.
    try {
      const now = new Date();
      fs.utimesSync(target, now, now);
    } catch {
      /* best effort */
    }
    return { rel, action: "unchanged" };
  }
  let backup = null;
  if (prev !== null && viewIntegrity(prev) !== "intact") {
    backup = backupPath(root, rel, nowMs);
    try {
      fs.writeFileSync(path.join(root, ...backup.split("/")), prev, { encoding: "utf8", flag: "wx" });
    } catch (err) {
      return { rel, action: "failed", error: `não consegui guardar a edição em ${backup}: ${err?.message ?? err}` };
    }
  }
  try {
    writeFileAtomic(target, content);
    return { rel, action: "wrote", backup };
  } catch (err) {
    return { rel, action: "failed", backup, error: String(err?.message ?? err) };
  }
}

/** Visões que existem na árvore, não são rastreadas e saíram intactas do gerador. */
function generatedLeftovers(root) {
  return [INDEX_PATH, ACTIVE_PATH].filter((rel) => {
    const abs = path.join(root, ...rel.split("/"));
    try {
      return viewIntegrity(fs.readFileSync(abs, "utf8")) === "intact" && !isTracked(root, rel);
    } catch {
      return false;
    }
  });
}

/**
 * Regenera .beads/active.yaml e .beads/index.yaml (§7). Em modo legado não
 * gera nada; só remove uma visão gerada (intacta e não rastreada) que tenha
 * sobrado de um checkout do modelo novo, para a árvore da branch antiga
 * ficar limpa.
 */
export function regenerateViews(root, opts = {}) {
  const env = opts.env ?? process.env;
  const nowMs = opts.nowMs ?? nowFromEnv(env);
  if (!fs.existsSync(path.join(root, ".beads"))) return { skipped: "sem .beads/", results: [] };

  if (isLegacy(root)) {
    const removed = [];
    for (const rel of generatedLeftovers(root)) {
      try {
        fs.unlinkSync(path.join(root, ...rel.split("/")));
        removed.push(rel);
      } catch {
        /* best effort */
      }
    }
    return { legacy: true, removed, results: [] };
  }

  // Sem .beads/tasks nem .beads/project o repo ainda não está no modelo novo
  // (projeto sem bead nenhum, ou um active.yaml solto fora do git): o que
  // estiver ali é do usuário, e o gerador não toca.
  if (!fs.existsSync(path.join(root, ".beads", "tasks")) && !fs.existsSync(path.join(root, ".beads", "project"))) {
    return { skipped: "sem .beads/tasks/ nem .beads/project/", results: [] };
  }

  const inputs = readTreeInputs(root);
  const state = buildState(inputs.beads, inputs.project, { nowMs });
  const spec = readSpecMeta(root, env);
  const session = readLocalSession(root);
  const active = renderActiveView(state, { project: spec.project, budgetUsd: spec.budgetUsd, costUsd: session.costUsd });
  const index = renderIndexView(state);
  const results = [writeView(root, ACTIVE_PATH, active, nowMs), writeView(root, INDEX_PATH, index, nowMs)];
  return { state, strays: inputs.strays, results };
}

// ── Mensagens ────────────────────────────────────────────────────────────────

export const LEGACY_HINT =
  "[beads] modo legado: .beads/active.yaml ainda é rastreado pelo git — os hooks não mexem no backlog. " +
  "Migre com: node aiteam/scripts/migrate-beads.mjs --dry-run (aiteam/docs/beads-schema.md §11)";

/**
 * O que imprimir depois de regenerateViews: `loud` pede atenção (bead pulado,
 * edição guardada, escrita que falhou, arquivo estranho) e sai sempre; `info`
 * é o resumo e os avisos, que o `quiet` cala. `merge` (o modo do post-merge)
 * mostra só os avisos que a combinação de branches causou — os de conteúdo são
 * do autor e saem no validate:beads, não a cada pull.
 */
export function describeRegeneration(summary, { quiet = false, merge = false } = {}) {
  const loud = [];
  const info = [];
  if (summary.legacy) {
    info.push(LEGACY_HINT);
    for (const rel of summary.removed ?? []) info.push(`[beads] removi ${rel}: visão gerada que sobrou do modelo novo`);
    return { loud, info: quiet ? [] : info };
  }
  if (summary.skipped) return { loud, info: quiet ? [] : [`[beads] nada a gerar (${summary.skipped})`] };
  const { state, strays = [], results } = summary;
  for (const inv of state.invalid) {
    loud.push(`[beads] ⚠⚠ BEAD PULADO: ${inv.id} — fora das visões até ser corrigido:`);
    for (const e of inv.errors) loud.push(`[beads]      ${e}`);
  }
  const projectErrors = state.errors.filter((e) => e.startsWith(".beads/project/"));
  if (projectErrors.length) {
    loud.push("[beads] ⚠⚠ fases/foco do projeto ignorados até a correção:");
    for (const e of projectErrors) loud.push(`[beads]      ${e}`);
  }
  for (const s of strays) loud.push(`[beads] ⚠ ${s}: arquivo fora do contrato (só <branch>.yaml em .beads/tasks/<id>/ e .beads/project/)`);
  for (const r of results) {
    if (r.backup) {
      loud.push(
        `[beads] ⚠⚠ ${r.rel} tinha edição à mão — guardada em ${r.backup}. Passe o que importa para .beads/tasks/<id>/<sua-branch>.yaml e apague o backup: o pre-commit bloqueia enquanto ele existir.`
      );
    }
    if (r.action === "failed") loud.push(`[beads] ⚠⚠ não consegui escrever ${r.rel} (${r.error}) — a visão anterior ficou.`);
  }
  if (!quiet) {
    const live = state.beads.filter((b) => b.status !== "completed").length;
    info.push(`[beads] visões: ${state.beads.length} beads (${live} vivos) → ${ACTIVE_PATH}, ${INDEX_PATH}`);
    for (const w of merge ? (state.combination ?? []) : state.warnings) info.push(`[beads] ⚠ ${w}`);
  }
  return { loud, info };
}

// ── Validação (§8) ───────────────────────────────────────────────────────────

const STRAY_HINT = "só <branch>.yaml vive em .beads/tasks/<id>/ e em .beads/project/ (contrato §3.4)";

// O que não pode estar no git no modelo novo (§2). Um merge é isento da regra
// de dono, então uma branch aberta antes da migração traz isso de volta sem
// conflito nenhum — e é aqui, no validate:beads da CI, que aparece.
const UNTRACKED_KINDS = new Set(["view", "backup", "local", "mirror", "archive"]);

/**
 * O que fazer com um resto rastreado. Espelho e archive/ podem trazer bead que
 * o modelo novo não tem (uma branch aberta antes da migração): porta-se antes
 * de tirar do git, ou o bead some calado.
 */
export function leftoverHint(p) {
  const kind = classifyBeadsPath(p).kind;
  if (kind === "mirror" || kind === "archive") {
    return `rastreado, mas é do modelo antigo (espelho ou archive/) — porte com --port ${p} antes do git rm --cached: node aiteam/scripts/migrate-beads.mjs --port ${p} && git rm --cached ${p} (contrato §11)`;
  }
  return `rastreado, mas não pertence ao modelo novo (visão, backup ou estado local) — tire do git: git rm --cached ${p}`;
}

/** Tudo o que está na árvore: o `validate:beads` da CI e do doctor. */
export function checkAll(root, opts = {}) {
  const nowMs = opts.nowMs ?? nowFromEnv(opts.env ?? process.env);
  if (isLegacy(root)) {
    // Pastas commitadas por fora (--no-verify, edição pelo site) num repo
    // legado: o backlog vive em dois lugares e nenhum deles é completo.
    const strays = indexPaths(root, [".beads/tasks", ".beads/project"]);
    const errors = strays.length
      ? [
          `modo legado, mas ${strays.length} arquivo(s) em .beads/tasks/ ou .beads/project/ estão no git — tire-os (git rm -r --cached .beads/tasks .beads/project), rode migrate-beads e porte o conteúdo deles depois`,
        ]
      : [];
    return { legacy: true, errors, warnings: [] };
  }
  const inputs = readTreeInputs(root);
  const state = buildState(inputs.beads, inputs.project, { nowMs });
  const leftovers = indexPaths(root, [".beads"]).filter((p) => UNTRACKED_KINDS.has(classifyBeadsPath(p).kind));
  const errors = [
    ...inputs.strays.map((s) => `${s}: ${STRAY_HINT}`),
    ...leftovers.map((p) => `${p}: ${leftoverHint(p)}`),
    ...state.errors,
  ];
  return { state, errors, warnings: state.warnings };
}

// As entradas de `theirs` que não aparecem em `result` (comparadas já parseadas).
function missingEntries(theirs, result) {
  const entriesOf = (text) => {
    try {
      const doc = load(String(text).replace(/\r\n/g, "\n"), { schema: CORE_SCHEMA });
      return Array.isArray(doc?.entries) ? doc.entries : [];
    } catch {
      return null;
    }
  };
  const mine = entriesOf(result);
  const other = entriesOf(theirs);
  if (mine === null || other === null) return [];
  const have = new Set(mine.map((e) => JSON.stringify(e)));
  return other.filter((e) => !have.has(JSON.stringify(e))).map((e) => `at ${e?.at ?? "?"}`);
}

/**
 * O que está staged: dono por branch (defesa em profundidade da regra em bash
 * do pre-commit), acréscimo só no fim em relação a HEAD, formato e combinação
 * dos beads afetados — tudo sobre os blobs do índice, não sobre a árvore.
 */
export function checkStaged(root, branch, opts = {}) {
  const nowMs = opts.nowMs ?? nowFromEnv(opts.env ?? process.env);
  const errors = [];
  const warnings = [];
  const own = sanitizeBranch(branch);

  const touchedBeads = new Set();
  let touchedProject = false;
  const appendChecks = [];
  for (const { status, path: rel } of stagedChanges(root)) {
    if (status === "D") continue;
    const c = classifyBeadsPath(rel);
    if (c.kind === "stray") {
      errors.push(`${rel}: ${STRAY_HINT}`);
      continue;
    }
    if (c.kind !== "task" && c.kind !== "project") continue;
    // Merge e squash trazem arquivos de outras branches: só a regra de dono
    // fica isenta (§8). Acréscimo só no fim, formato e combinação valem igual.
    if (opts.merge) {
      // sem checagem de dono
    } else if (!own.file) {
      errors.push(`${rel}: ${own.reason} — nenhuma mudança em .beads/tasks ou .beads/project sem uma branch válida`);
    } else if (c.branchFile !== own.file) {
      errors.push(
        `${rel} é da branch "${c.branchFile}"; você está em "${branch}". Acrescente uma entrada em ${ownPathFor(c, own.file)}.`
      );
    }
    appendChecks.push(rel);
    if (c.kind === "task") touchedBeads.add(c.id);
    else touchedProject = true;
  }

  // Num merge de verdade, o lado de lá também conta: nenhuma entrada dele
  // pode sumir na resolução (em add/add, fica a versão mais longa).
  const mergeHead = opts.merge && git(root, ["rev-parse", "-q", "--verify", "MERGE_HEAD^{commit}"]).status === 0;
  const blobs = catFiles(root, [...appendChecks.map((p) => `HEAD:${p}`), ...appendChecks.map((p) => `:${p}`)]);
  for (const p of appendChecks) {
    const before = blobs.get(`HEAD:${p}`);
    const after = blobs.get(`:${p}`);
    const problem = before != null && after != null ? appendOnlyProblem(before, after) : null;
    if (problem) errors.push(`${p}: ${problem}`);
  }
  if (mergeHead) {
    // Todo arquivo de bead em que o resultado difere do lado de lá — inclusive
    // os que não mudaram em relação ao HEAD ("fiquei com o nosso lado").
    const differs = String(git(root, ["diff", "--cached", "--name-only", "-z", "MERGE_HEAD", "--", ".beads/tasks", ".beads/project"]).stdout)
      .split("\0")
      .filter(Boolean);
    const sides = catFiles(root, [...differs.map((p) => `MERGE_HEAD:${p}`), ...differs.map((p) => `:${p}`), ...differs.map((p) => `HEAD:${p}`)]);
    for (const p of differs) {
      const theirs = sides.get(`MERGE_HEAD:${p}`);
      if (theirs == null) continue;
      const result = sides.get(`:${p}`);
      if (result == null) {
        errors.push(`${p}: a resolução do merge apagou um arquivo de bead da outra branch — o histórico não se apaga`);
        continue;
      }
      const ours = sides.get(`HEAD:${p}`);
      const notPrefix = ours == null ? appendOnlyProblem(theirs, result) : null;
      const lost = notPrefix ? [`a versão da outra branch não é prefixo do resultado: ${notPrefix}`] : missingEntries(theirs, result);
      if (lost.length) {
        errors.push(
          `${p}: a resolução do merge perdeu entradas da outra branch (${lost.join("; ")}) — fique com as entradas dos dois lados (em add/add, com a versão mais longa)`
        );
      }
    }
  }

  const indexed = indexPaths(root, [".beads/tasks", ".beads/project"]);
  const byBead = new Map();
  const projectFiles = [];
  for (const p of indexed) {
    const c = classifyBeadsPath(p);
    if (c.kind === "task") byBead.set(c.id, [...(byBead.get(c.id) ?? []), { p, branchFile: c.branchFile }]);
    else if (c.kind === "project") projectFiles.push({ p, branchFile: c.branchFile });
  }
  const wanted = [...[...touchedBeads].flatMap((id) => byBead.get(id) ?? []), ...(touchedProject ? projectFiles : [])];
  const staged = catFiles(root, wanted.map((w) => `:${w.p}`));
  const text = (w) => staged.get(`:${w.p}`) ?? "";

  for (const id of touchedBeads) {
    const r = combineBead(id, (byBead.get(id) ?? []).map((w) => ({ branchFile: w.branchFile, text: text(w) })), { nowMs });
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    const twins = [...byBead.keys()].filter((x) => x !== id && x.toLowerCase() === id.toLowerCase());
    if (twins.length) errors.push(`.beads/tasks/${id}/: id colide com ${twins.join(", ")} ignorando maiúsculas e minúsculas — renomeie`);
  }
  if (touchedProject) {
    const r = combineProject(projectFiles.map((w) => ({ branchFile: w.branchFile, text: text(w) })), { nowMs });
    errors.push(...r.errors);
    warnings.push(...r.warnings);
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)], checked: appendChecks.length };
}
