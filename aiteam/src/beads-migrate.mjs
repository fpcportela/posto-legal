// Migração do .beads do modelo antigo (active.yaml + espelhos por branch +
// archive/) para o modelo por bead — contrato em aiteam/docs/beads-schema.md §11.
//
// planMigration e planPort são puros (textos entram, arquivos e relatório
// saem); readLegacySources, applyMigration e applyPort fazem o disco e o git.
// Mesmas regras do núcleo: só node:*, caminhos relativos e o vendor; sem shebang.

import * as fs from "node:fs";
import * as path from "node:path";
import { CORE_SCHEMA, dump, load } from "../vendor/js-yaml.mjs";
import {
  ACTIVE_PATH,
  appendEntry,
  buildState,
  byteCompare,
  combineBead,
  combineProject,
  GITIGNORE_PATH,
  idProblems,
  isoText,
  mergeGitignore,
  sanitizeBranch,
  VIEW_HEADER,
} from "./beads-core.mjs";
import { catFiles, currentBranch, git, indexPaths, readIndexInputs, readTreeInputs, regenerateViews } from "./beads-io.mjs";

// O .gitignore canônico mora no núcleo (o install.mjs também o garante);
// reexportado aqui por quem já o importava da migração.
export { GITIGNORE, GITIGNORE_PATH } from "./beads-core.mjs";

const DUMP = { lineWidth: -1, noRefs: true, quotingType: '"', forceQuotes: true };
// Campos do nó antigo que não vão para o topo da definição: o id vira a pasta,
// os de estado vão para a entrada e os de tempo viram created_at/at.
const NOT_DEFINITION = new Set(["id", "status", "stage", "context_summary", "blockers", "note", "created_at", "updated_at"]);
const LIST_FIELDS = new Set(["tags", "related_files"]);

const lf = (s) => String(s ?? "").replace(/\r\n/g, "\n");
const firstLine = (s) => String(s ?? "").split("\n")[0];

/**
 * Instante de um timestamp do modelo antigo, tolerante ao que os arquivos
 * reais têm: com ou sem aspas, com ou sem milissegundos, só a data. Data e
 * hora sem fuso são lidas como UTC.
 */
export function legacyInstant(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value !== "string" || value.trim() === "") return null;
  let s = value.trim();
  if (/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s += "Z";
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

function parseLegacy(text, label) {
  const doc = load(lf(text), { schema: CORE_SCHEMA, filename: label });
  const tasks = Array.isArray(doc?.tasks) ? doc.tasks.filter((t) => t && typeof t === "object" && !Array.isArray(t)) : [];
  return { doc: doc && typeof doc === "object" ? doc : {}, tasks };
}

function parseIndexIds(text) {
  const doc = load(lf(text), { schema: CORE_SCHEMA });
  if (!Array.isArray(doc)) return { ids: [], archived: new Map() };
  const ids = [];
  const archived = new Map();
  for (const e of doc) {
    if (!e || typeof e !== "object" || e.id === undefined || e.id === null) continue;
    ids.push(String(e.id));
    if (e.archived) archived.set(String(e.id), String(e.archived));
  }
  return { ids, archived };
}

function nodeTimes(node, fallbacks) {
  const updated = legacyInstant(node.updated_at) ?? legacyInstant(node.created_at) ?? fallbacks.find((f) => f !== null) ?? null;
  const created = legacyInstant(node.created_at) ?? updated;
  return { createdMs: created, updatedMs: updated };
}

/** O arquivo de bead de um nó antigo: a definição no topo e uma entrada com o estado. */
export function beadFileFromLegacy(node, createdMs, updatedMs) {
  const top = {};
  for (const [k, v] of Object.entries(node)) {
    if (NOT_DEFINITION.has(k) || v === null || v === undefined) continue;
    if (LIST_FIELDS.has(k) && Array.isArray(v) && v.length === 0) continue;
    top[k] = v;
  }
  top.created_at = isoText(createdMs);
  const entry = { at: isoText(updatedMs) };
  if (typeof node.status === "string") entry.status = node.status;
  if (typeof node.stage === "string" && node.stage) entry.stage = node.stage;
  if (typeof node.context_summary === "string" && node.context_summary) entry.context_summary = node.context_summary;
  if (Array.isArray(node.blockers) && node.blockers.length) entry.blockers = node.blockers;
  if (typeof node.note === "string" && node.note) entry.note = node.note;
  return dump({ ...top, entries: [entry] }, DUMP);
}

/**
 * Os nós do modelo antigo, um por id (§11): completed e active, com o
 * updated_at maior em caso de duplicata; os que só existem em espelho entram
 * com `recoverMirrors`. Devolve também o relatório e os erros de leitura.
 */
function selectLegacyNodes(sources, opts) {
  // `errors`: o que impede de ler a fonte (YAML inválido). `unreadable`: um nó que não dá para
  // portar (sem id, sem data legível) — a migração aborta com ele, mas o porte e a conferência
  // seguem com os nós válidos e só avisam (A4).
  const errors = [];
  const unreadable = [];
  const report = {
    sources: { active: 0, completed: 0, mirrors: (sources.mirrors ?? []).length, unreadableMirrors: [] },
    duplicates: [],
    outsideIndex: [],
    indexOrphans: [],
    mirrorOnly: [],
    recoverMirrors: Boolean(opts.recoverMirrors),
    unique: 0,
    folders: 0,
    withMirrors: 0,
  };

  let active = { doc: {}, tasks: [] };
  let completed = { doc: {}, tasks: [] };
  let index = null;
  try {
    if (sources.active != null) active = parseLegacy(sources.active, ".beads/active.yaml");
  } catch (err) {
    errors.push(`.beads/active.yaml: YAML inválido — ${firstLine(err?.message)}`);
  }
  try {
    if (sources.completed != null) completed = parseLegacy(sources.completed, ".beads/archive/completed.yaml");
  } catch (err) {
    errors.push(`.beads/archive/completed.yaml: YAML inválido — ${firstLine(err?.message)}`);
  }
  try {
    if (sources.index != null) index = parseIndexIds(sources.index);
  } catch (err) {
    errors.push(`.beads/archive/index.yaml: YAML inválido — ${firstLine(err?.message)} (só serve ao relatório; corrija ou apague)`);
  }
  report.sources.active = active.tasks.length;
  report.sources.completed = completed.tasks.length;

  const fileStamp = (doc) => legacyInstant(doc?.last_updated);
  const archivedAt = (id) => legacyInstant(index?.archived.get(id) ?? "");

  const primary = new Map();
  const consider = (map, node, origin, docStamp, onDuplicate) => {
    const id = node.id === undefined || node.id === null ? "" : String(node.id);
    if (id === "") {
      unreadable.push(`${origin}: nó sem id`);
      return;
    }
    const { createdMs, updatedMs } = nodeTimes(node, [archivedAt(id), docStamp]);
    if (updatedMs === null) {
      unreadable.push(`${origin}: ${id} sem updated_at nem created_at legíveis`);
      return;
    }
    const cand = { id, node, origin, createdMs, updatedMs };
    const prev = map.get(id);
    if (!prev) map.set(id, cand);
    else onDuplicate(prev, cand);
  };

  // completed primeiro e active depois: no empate de updated_at, fica o vivo.
  for (const [tasks, origin, doc] of [
    [completed.tasks, "archive/completed.yaml", completed.doc],
    [active.tasks, "active.yaml", active.doc],
  ]) {
    for (const node of tasks) {
      consider(primary, node, origin, fileStamp(doc), (prev, cand) => {
        const keep = cand.updatedMs >= prev.updatedMs ? cand : prev;
        const drop = keep === cand ? prev : cand;
        primary.set(cand.id, keep);
        report.duplicates.push({ id: cand.id, kept: keep.origin, keptAt: isoText(keep.updatedMs), dropped: drop.origin, droppedAt: isoText(drop.updatedMs) });
      });
    }
  }

  const mirrorOnly = new Map();
  for (const m of [...(sources.mirrors ?? [])].sort((a, b) => byteCompare(a.name, b.name))) {
    let parsed;
    try {
      parsed = parseLegacy(m.text, `.beads/${m.name}`);
    } catch (err) {
      report.sources.unreadableMirrors.push({ name: m.name, error: firstLine(err?.message) });
      continue;
    }
    for (const node of parsed.tasks) {
      const id = node.id === undefined || node.id === null ? "" : String(node.id);
      if (id === "" || primary.has(id)) continue;
      consider(mirrorOnly, node, m.name, fileStamp(parsed.doc), (prev, cand) => {
        if (cand.updatedMs > prev.updatedMs) {
          mirrorOnly.set(cand.id, { ...cand, alsoIn: [...(prev.alsoIn ?? []), prev.origin] });
        } else {
          prev.alsoIn = [...(prev.alsoIn ?? []), cand.origin];
        }
      });
    }
  }

  const indexIds = new Set(index?.ids ?? []);
  const completedIds = new Set(completed.tasks.map((t) => String(t.id ?? "")).filter(Boolean));
  if (index) {
    report.outsideIndex = [...completedIds].filter((id) => !indexIds.has(id)).sort(byteCompare);
    report.indexOrphans = [...indexIds].filter((id) => !completedIds.has(id)).sort(byteCompare);
  }
  report.mirrorOnly = [...mirrorOnly.values()]
    .sort((a, b) => byteCompare(a.id, b.id))
    .map((c) => ({
      id: c.id,
      origin: c.origin,
      status: typeof c.node.status === "string" ? c.node.status : "?",
      date: isoText(c.updatedMs).slice(0, 10),
      alsoIn: c.alsoIn ?? [],
    }));

  const selected = [...primary.values(), ...(opts.recoverMirrors ? mirrorOnly.values() : [])].sort((a, b) =>
    byteCompare(a.id, b.id)
  );
  report.unique = selected.length;
  report.withMirrors = primary.size + mirrorOnly.size;
  return { errors, unreadable, report, selected, activeDoc: active.doc };
}

/**
 * Planeja a migração (§11). `sources`: textos de active.yaml, de
 * archive/completed.yaml e de archive/index.yaml (cada um pode faltar) e os
 * espelhos `{name, text}`. Nada é escrito aqui; se `errors` não vier vazio, a
 * migração não pode prosseguir.
 */
export function planMigration(sources, opts) {
  const nowMs = opts.nowMs ?? Date.now();
  const as = opts.as;
  const sel = selectLegacyNodes(sources, opts);
  const { report, selected, activeDoc } = sel;
  // A migração é tudo ou nada: um nó que não dá para portar a aborta, como sempre.
  const errors = [...sel.errors, ...sel.unreadable];
  const fileStamp = (doc) => legacyInstant(doc?.last_updated);

  for (const c of selected) {
    for (const p of idProblems(c.id)) errors.push(`${c.origin}: ${p} — corrija o id antes de migrar`);
  }
  const byLower = new Map();
  for (const c of selected) byLower.set(c.id.toLowerCase(), [...(byLower.get(c.id.toLowerCase()) ?? []), c.id]);
  for (const group of byLower.values()) {
    if (group.length > 1) errors.push(`ids ${group.join(", ")} só diferem em maiúsculas e minúsculas — viram a mesma pasta; renomeie antes de migrar`);
  }
  // Pastas que o disco de fato criaria (ignorando maiúsculas): tem de bater com os ids únicos.
  report.folders = byLower.size;
  if (report.folders !== report.unique) errors.push(`ids únicos ${report.unique} ≠ pastas ${report.folders} — nada foi escrito`);

  const files = [];
  if (errors.length === 0) {
    for (const c of selected) {
      const rel = `.beads/tasks/${c.id}/${as}.yaml`;
      const text = beadFileFromLegacy(c.node, c.createdMs, c.updatedMs);
      const check = combineBead(c.id, [{ branchFile: as, text }], { nowMs });
      if (check.errors.length) errors.push(...check.errors.map((e) => `${e} (nó de ${c.origin})`));
      files.push({ path: rel, text });
    }
    const phases = activeDoc.phases;
    const focus = activeDoc.session?.focus_note;
    if (phases !== undefined || focus !== undefined) {
      const created = fileStamp(activeDoc) ?? nowMs;
      const doc = { created_at: isoText(created) };
      if (phases !== undefined) doc.phases = phases;
      if (focus !== undefined) doc.focus_note = focus;
      const text = dump(doc, DUMP);
      const check = combineProject([{ branchFile: as, text }], { nowMs });
      if (check.errors.length) errors.push(...check.errors);
      files.push({ path: `.beads/project/${as}.yaml`, text });
    }
  }
  return { errors, report, files: errors.length ? [] : files };
}

const none = (xs) => (xs.length ? xs.join(", ") : "nenhum");

/** O relatório da §11 em linhas, para o terminal e para o PR. */
export function formatReport(report) {
  const s = report.sources;
  const unreadable = s.unreadableMirrors.length
    ? ` (${s.unreadableMirrors.length} ilegível: ${s.unreadableMirrors.map((m) => m.name).join(", ")})`
    : "";
  const lines = [`fontes: active ${s.active} · completed ${s.completed} · espelhos ${s.mirrors} arquivos${unreadable}`];
  const ok = report.unique === report.folders ? "✓" : "✗";
  lines.push(
    report.recoverMirrors
      ? `únicos ${report.unique} → pastas ${report.folders} ${ok}  (com --recover-mirrors: ${report.mirrorOnly.length} recuperado(s) dos espelhos)`
      : `únicos ${report.unique} → pastas ${report.folders} ${ok}  (${report.withMirrors} com --recover-mirrors)`
  );
  if (report.duplicates.length) {
    lines.push("duplicatas (fica o updated_at maior):");
    for (const d of report.duplicates) lines.push(`  ${d.id}: ${d.kept} ${d.keptAt} sobre ${d.dropped} ${d.droppedAt}`);
  }
  lines.push(`no completed.yaml e FORA do índice antigo (#30): ${none(report.outsideIndex)}`);
  lines.push(`no índice sem nó no completed.yaml: ${none(report.indexOrphans)}`);
  lines.push(`só em espelhos: ${report.mirrorOnly.length}${report.mirrorOnly.length && !report.recoverMirrors ? " (ficam de fora sem --recover-mirrors)" : ""}`);
  for (const m of report.mirrorOnly) {
    const also = m.alsoIn.length ? ` (também em ${m.alsoIn.join(", ")})` : "";
    lines.push(`  ${m.id} · ${m.origin} · ${m.status} · ${m.date}${also}`);
  }
  for (const m of s.unreadableMirrors) lines.push(`espelho ilegível, fora da conta: ${m.name} — ${m.error}`);
  return lines;
}

// ── Disco e git ──────────────────────────────────────────────────────────────

const isMirrorName = (name) => name.endsWith(".yaml") && name !== "active.yaml" && name !== "index.yaml";

/**
 * As fontes do modelo antigo: os blobs de HEAD (padrão), de outro commit
 * (`rev`, o --port-from) ou a árvore. Um active.yaml que é visão gerada não é
 * fonte: num commit do modelo novo ele nem devia estar no git.
 */
export function readLegacySources(root, { fromWorktree = false, rev = "HEAD" } = {}) {
  if (fromWorktree) {
    const read = (rel) => {
      try {
        return fs.readFileSync(path.join(root, ...rel.split("/")), "utf8");
      } catch {
        return null;
      }
    };
    let names = [];
    try {
      names = fs
        .readdirSync(path.join(root, ".beads"), { withFileTypes: true })
        .filter((d) => d.isFile() && isMirrorName(d.name))
        .map((d) => d.name);
    } catch {
      names = [];
    }
    return {
      active: read(".beads/active.yaml"),
      completed: read(".beads/archive/completed.yaml"),
      index: read(".beads/archive/index.yaml"),
      mirrors: names.map((name) => ({ name, text: read(`.beads/${name}`) ?? "" })),
    };
  }
  const listed = git(root, ["ls-tree", "-r", "--name-only", "-z", rev, "--", ".beads"]);
  const paths = String(listed.stdout).split("\0").filter(Boolean);
  const mirrorPaths = paths.filter((p) => /^\.beads\/[^/]+$/.test(p) && isMirrorName(p.slice(".beads/".length)));
  const wanted = [".beads/active.yaml", ".beads/archive/completed.yaml", ".beads/archive/index.yaml", ...mirrorPaths];
  // Pelo stdin do cat-file: "<rev>:<caminho>" em argumento seria convertido
  // pelo bash do Git for Windows.
  const blobs = catFiles(root, wanted.map((p) => `${rev}:${p}`));
  const active = blobs.get(`${rev}:.beads/active.yaml`) ?? null;
  return {
    active: active !== null && lf(active).startsWith(VIEW_HEADER) ? null : active,
    completed: blobs.get(`${rev}:.beads/archive/completed.yaml`) ?? null,
    index: blobs.get(`${rev}:.beads/archive/index.yaml`) ?? null,
    mirrors: mirrorPaths.map((p) => ({ name: p.slice(".beads/".length), text: blobs.get(`${rev}:${p}`) ?? "" })),
  };
}

/** Há algo do modelo antigo nestas fontes? */
export function hasLegacySources(sources) {
  return sources.active !== null || sources.completed !== null || sources.mirrors.length > 0;
}

/** Por que a migração não pode rodar agora (lista vazia: pode). */
export function migrationBlockers(root, { fromWorktree = false } = {}) {
  const problems = [];
  const tree = readTreeInputs(root);
  if (indexPaths(root, [".beads/tasks", ".beads/project"]).length) {
    problems.push(".beads/tasks/ (ou .beads/project/) já está no git — este repo já está no modelo novo");
  } else if (tree.beads.length || tree.project.length) {
    problems.push(
      "há arquivos não rastreados em .beads/tasks/ (ou .beads/project/), criados antes da migração — mova-os para fora do repo, migre e recrie o que faltar como entrada nova"
    );
  }
  const staged = git(root, ["diff", "--cached", "--name-only", "--", ".beads"]);
  if (String(staged.stdout).trim()) problems.push(`há mudanças staged em .beads/ — commite ou tire do stage antes:\n${String(staged.stdout).trim()}`);
  if (!fromWorktree) {
    const dirty = git(root, ["diff", "--name-only", "HEAD", "--", ".beads"]);
    if (String(dirty.stdout).trim()) {
      problems.push(
        `a árvore difere de HEAD em .beads/ — a migração lê HEAD e essas mudanças se perderiam. Commite-as ou rode com --from-worktree:\n${String(dirty.stdout).trim()}`
      );
    }
  }
  return problems;
}

function writeRel(root, rel, text) {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
}

function mustGit(root, args) {
  const r = git(root, args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} falhou: ${String(r.stderr).trim()}`);
  return r;
}

/**
 * Tira do git o modelo antigo, escreve as pastas e prepara o stage — sem
 * commitar (§11 passo 6). O que é do git vem primeiro e só com --cached, que
 * não falha com arquivo modificado na árvore (o caso do --from-worktree); só
 * depois os arquivos antigos saem do disco e os novos entram. O conteúdo
 * antigo já está nas pastas novas e continua em HEAD. cost-log.json e
 * session-log.ndjson ficam no disco: viram estado local, ignorado.
 */
export function applyMigration(root, plan, opts = {}) {
  const tracked = indexPaths(root, [".beads"]);
  const archive = tracked.filter((p) => p.startsWith(".beads/archive/"));
  const mirrors = tracked.filter((p) => /^\.beads\/[^/]+$/.test(p) && isMirrorName(p.slice(".beads/".length)));
  const local = [".beads/active.yaml", ".beads/cost-log.json", ".beads/session-log.ndjson"].filter((p) => tracked.includes(p));
  const untrack = [...archive, ...mirrors, ...local];
  if (untrack.length) mustGit(root, ["rm", "-q", "--cached", "--", ...untrack]);
  for (const rel of [...archive, ...mirrors, ".beads/active.yaml"]) {
    try {
      fs.unlinkSync(path.join(root, ...rel.split("/")));
    } catch {
      /* já não estava no disco */
    }
  }
  try {
    fs.rmdirSync(path.join(root, ".beads", "archive"));
  } catch {
    /* não vazia (arquivo não rastreado) ou inexistente: fica */
  }

  for (const f of plan.files) writeRel(root, f.path, f.text);
  let current = "";
  try {
    current = fs.readFileSync(path.join(root, ".beads", ".gitignore"), "utf8");
  } catch {
    current = "";
  }
  const gitignore = mergeGitignore(current);
  if (gitignore !== current) writeRel(root, GITIGNORE_PATH, gitignore);

  // Só o que foi escrito: com backlog vazio não há .beads/tasks, e um pathspec
  // que não casa nada faria o git add falhar.
  const add = [GITIGNORE_PATH];
  if (plan.files.some((f) => f.path.startsWith(".beads/tasks/"))) add.push(".beads/tasks");
  if (plan.files.some((f) => f.path.startsWith(".beads/project/"))) add.push(".beads/project");
  mustGit(root, ["add", "--", ...add]);
  return regenerateViews(root, opts);
}

// ── --port: um active.yaml antigo trazido depois da migração ─────────────────

/**
 * O coração do --port e do --port-from: para cada nó antigo, cria a pasta de
 * um id que ainda não existe ou acrescenta, no arquivo da branch `as`, uma
 * entrada com o que mudou — só se o nó for mais novo que o estado combinado.
 * `cands`: `{id, node, createdMs, updatedMs}`; o mesmo id duas vezes fica com
 * o updated_at maior.
 */
function planPortNodes(cands, current, opts) {
  const nowMs = opts.nowMs ?? Date.now();
  const as = opts.as;
  const label = opts.label ?? "--port";
  const errors = [];
  // Um nó sem data legível não dá para portar, mas não impede os outros: só avisa (A4).
  const warnings = [];
  const created = [];
  const appended = [];
  const skipped = [];
  const byId = new Map(current.state.beads.map((b) => [b.id, b]));
  const invalid = new Set(current.state.invalid.map((b) => b.id));
  // Num disco que ignora maiúsculas, API-Foo e api-foo são a mesma pasta: um
  // id novo que colide assim sobrescreveria o arquivo de outro bead.
  const byLower = new Map([...byId.keys(), ...invalid].map((id) => [id.toLowerCase(), id]));
  const newest = new Map();
  for (const c of cands) {
    const prev = newest.get(c.id);
    if (!prev || prev.updatedMs === null || (c.updatedMs !== null && c.updatedMs >= prev.updatedMs)) newest.set(c.id, c);
  }
  const files = [];
  for (const { id, node, createdMs, updatedMs } of newest.values()) {
    const problems = idProblems(id);
    if (problems.length) {
      errors.push(...problems.map((p) => `${label}: ${p}`));
      continue;
    }
    if (updatedMs === null) {
      warnings.push(`${label}: ${id} sem updated_at nem created_at legíveis — ficou de fora`);
      continue;
    }
    if (invalid.has(id)) {
      errors.push(`${label}: .beads/tasks/${id}/ está inválido — corrija antes de portar`);
      continue;
    }
    const twin = byLower.get(id.toLowerCase());
    if (twin !== undefined && twin !== id) {
      errors.push(`${label}: ${id} colide com .beads/tasks/${twin}/ ignorando maiúsculas e minúsculas — use o id existente`);
      continue;
    }
    const rel = `.beads/tasks/${id}/${as}.yaml`;
    const bead = byId.get(id);
    if (!bead) {
      files.push({ path: rel, text: beadFileFromLegacy(node, createdMs, updatedMs) });
      created.push(id);
      continue;
    }
    if (updatedMs <= bead.updatedMs) {
      skipped.push(id);
      continue;
    }
    const entry = { at: isoText(updatedMs) };
    if (typeof node.status === "string" && node.status !== bead.status) entry.status = node.status;
    // Lista vazia e campo ausente dizem o mesmo: a migração omite as vazias.
    const norm = (k, v) => (LIST_FIELDS.has(k) || k === "blockers") && Array.isArray(v) && v.length === 0 ? undefined : v;
    for (const [k, v] of Object.entries(node)) {
      if (k === "id" || k === "status" || k === "created_at" || k === "updated_at" || v === null || v === undefined) continue;
      if (JSON.stringify(norm(k, v)) !== JSON.stringify(norm(k, bead.fields[k]))) entry[k] = v;
    }
    if (Object.keys(entry).length === 1) {
      skipped.push(id);
      continue;
    }
    files.push({ path: rel, text: appendEntry(current.ownFiles.get(id) ?? null, entry) });
    appended.push(id);
  }
  for (const f of files) {
    const id = f.path.split("/")[2];
    const others = current.filesOf(id).filter((x) => x.branchFile !== as);
    const check = combineBead(id, [...others, { branchFile: as, text: f.text }], { nowMs });
    if (check.errors.length) errors.push(...check.errors);
  }
  return { errors, warnings, files: errors.length ? [] : files, created, appended, skipped };
}

/** O --port: os nós de um arquivo do modelo antigo (active.yaml, espelho ou archive/completed.yaml). */
export function planPort(oldText, current, opts) {
  let old;
  try {
    old = parseLegacy(oldText, "--port");
  } catch (err) {
    return { errors: [`--port: YAML inválido — ${firstLine(err?.message)}`], warnings: [], files: [], created: [], appended: [], skipped: [] };
  }
  // Um nó sem id não dá para portar, mas não impede os outros do arquivo (A4): só avisa.
  const noId = old.tasks.filter((node) => node.id === undefined || node.id === null || String(node.id) === "").length;
  const cands = old.tasks
    .filter((node) => node.id !== undefined && node.id !== null && String(node.id) !== "")
    .map((node) => ({
      id: String(node.id),
      node,
      ...nodeTimes(node, [legacyInstant(old.doc.last_updated)]),
    }));
  const plan = planPortNodes(cands, current, opts);
  return noId ? { ...plan, warnings: [`--port: ${noId} nó(s) sem id — ficaram de fora`, ...plan.warnings] } : plan;
}

/**
 * O --port-from: todo o modelo antigo de um commit (active.yaml e
 * archive/completed.yaml; os espelhos com `recoverMirrors`), unido por id como
 * na migração, e portado contra o estado atual.
 */
export function planPortFrom(sources, current, opts) {
  const sel = selectLegacyNodes(sources, { recoverMirrors: opts.recoverMirrors });
  // Fonte ilegível (YAML inválido) aborta o porte; a conferência (`lenient`) segue com as outras
  // fontes e leva o problema como aviso. Um nó sem id ou sem data nunca aborta (A4): os nós
  // válidos são portados e o que ficou de fora vai nos avisos.
  if (sel.errors.length && !opts.lenient) {
    return { errors: sel.errors, warnings: sel.unreadable, files: [], created: [], appended: [], skipped: [], report: sel.report };
  }
  const plan = planPortNodes(sel.selected, current, opts);
  return {
    ...plan,
    errors: [...sel.errors, ...plan.errors],
    warnings: [...sel.unreadable, ...plan.warnings],
    // Com uma fonte ilegível no meio da conferência não há arquivo a escrever: ninguém usa `files` aqui.
    files: sel.errors.length ? [] : plan.files,
    report: sel.report,
  };
}

// ── --scan-history: o que sumiu do HEAD e continua no histórico ───────────────

const isLegacyBeadsPath = (p) =>
  p === ".beads/active.yaml" || p === ".beads/archive/completed.yaml" || (/^\.beads\/[^/]+$/.test(p) && isMirrorName(p.slice(".beads/".length)));

/**
 * Lê toda versão do modelo antigo no histórico de `rev` (§11): cada blob de
 * active.yaml, espelho e archive/completed.yaml que algum commit introduziu —
 * com --full-history e -m, para não perder o lado de um merge que o descartou.
 * Devolve, por id, a versão com o updated_at maior, e de onde ela veio.
 */
export function scanHistory(root, { rev = "HEAD" } = {}) {
  const log = git(root, ["log", "--full-history", "-m", "--raw", "--no-abbrev", "--no-renames", "--format=%x00%H %ct", rev, "--", ".beads"]);
  if (log.status !== 0) throw new Error(`git log falhou: ${String(log.stderr).trim()}`);
  const commits = new Set();
  const blobs = new Map(); // sha → {commit, file, commitMs}: o commit mais novo que o introduziu
  let current = null;
  for (const line of String(log.stdout).split("\n")) {
    if (line.startsWith("\0")) {
      const [sha, ct] = line.slice(1).trim().split(" ");
      current = { sha, ms: Number(ct) * 1000 };
      commits.add(sha);
      continue;
    }
    const m = /^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) [AMT]\w*\t(.+)$/.exec(line);
    if (!m || !current || /^0+$/.test(m[1]) || !isLegacyBeadsPath(m[2])) continue;
    if (!blobs.has(m[1])) blobs.set(m[1], { commit: current.sha, file: m[2], commitMs: current.ms });
  }
  const texts = catFiles(root, [...blobs.keys()]);
  const best = new Map();
  const unreadable = [];
  let versions = 0;
  for (const [sha, where] of blobs) {
    const text = texts.get(sha);
    if (typeof text !== "string" || lf(text).startsWith(VIEW_HEADER)) continue;
    let parsed;
    try {
      parsed = parseLegacy(text, where.file);
    } catch (err) {
      unreadable.push(`${where.commit.slice(0, 7)} ${where.file}: ${firstLine(err?.message)}`);
      continue;
    }
    versions++;
    for (const node of parsed.tasks) {
      if (node.id === undefined || node.id === null) continue;
      const id = String(node.id);
      const { createdMs, updatedMs } = nodeTimes(node, [legacyInstant(parsed.doc.last_updated), where.commitMs]);
      const prev = best.get(id);
      // Empate de updated_at: fica o commit mais novo.
      if (!prev || updatedMs > prev.updatedMs || (updatedMs === prev.updatedMs && where.commitMs > prev.commitMs)) {
        best.set(id, { id, node, createdMs, updatedMs, commit: where.commit, file: where.file, commitMs: where.commitMs });
      }
    }
  }
  return { commits: commits.size, versions, unreadable, best };
}

/**
 * Planeja o --scan-history (puro): só os ids que faltam no estado atual
 * voltam, como pasta nova; id que não vira pasta ou que colide ignorando
 * maiúsculas é listado e fica de fora. Os ids que existem mas têm versão
 * mais nova no histórico só aparecem no relatório.
 */
export function planScanHistory(scan, current, opts) {
  const have = new Map(current.state.beads.map((b) => [b.id, b]));
  for (const inv of current.state.invalid) have.set(inv.id, null);
  const haveLower = new Map([...have.keys()].map((id) => [id.toLowerCase(), id]));
  const missing = [];
  const ignored = [];
  const newer = [];
  const takenLower = new Map();
  for (const c of [...scan.best.values()].sort((a, b) => byteCompare(a.id, b.id))) {
    if (have.has(c.id)) {
      const bead = have.get(c.id);
      if (bead && c.updatedMs > bead.updatedMs) newer.push(c);
      continue;
    }
    const problems = idProblems(c.id);
    if (problems.length) {
      ignored.push({ ...c, reason: problems[0] });
      continue;
    }
    const twin = haveLower.get(c.id.toLowerCase()) ?? takenLower.get(c.id.toLowerCase());
    if (twin !== undefined) {
      ignored.push({ ...c, reason: `colide com ${twin} ignorando maiúsculas e minúsculas` });
      continue;
    }
    takenLower.set(c.id.toLowerCase(), c.id);
    missing.push(c);
  }
  const plan = planPortNodes(missing, current, { ...opts, label: "--scan-history" });
  return { plan, missing, ignored, newer };
}

/**
 * O estado atual para o --port: a árvore (padrão) ou o índice do git
 * (`fromIndex`, o que o pre-commit confere).
 */
export function portContext(root, as, nowMs, { fromIndex = false } = {}) {
  const tree = fromIndex ? readIndexInputs(root) : readTreeInputs(root);
  return {
    state: buildState(tree.beads, tree.project, { nowMs }),
    ownFiles: new Map(tree.beads.filter((b) => b.branchFile === as).map((b) => [b.bead, b.text])),
    filesOf: (id) => tree.beads.filter((b) => b.bead === id).map((b) => ({ branchFile: b.branchFile, text: b.text })),
  };
}

/**
 * Escreve e põe no stage o que o --port planejou. `regenerate: false` no meio
 * de um merge: a árvore ainda tem o active.yaml antigo da outra branch, e
 * regenerar agora o guardaria como edição à mão — o post-commit regenera.
 */
export function applyPort(root, portPlan, { regenerate = true } = {}) {
  for (const f of portPlan.files) writeRel(root, f.path, f.text);
  if (portPlan.files.length) mustGit(root, ["add", "--", ...portPlan.files.map((f) => f.path)]);
  return regenerate ? regenerateViews(root) : null;
}

const COMPLETED_PATH = ".beads/archive/completed.yaml";
const NONE = { errors: [], warnings: [] };

/**
 * Os espelhos (`.beads/<branch>.yaml`) que um lado do merge — `tip`, o
 * MERGE_HEAD ou o HEAD — mudou desde a base: o da própria branch antiga. Os
 * outros espelhos do repo são de antes da migração e ficaram de fora dela de
 * propósito — conferi-los acusaria o que nunca foi desta branch. Sem base em
 * comum, vale todo espelho que o lado tem.
 */
function mirrorsChangedBy(root, tip, vs = "MERGE_HEAD") {
  const base = git(root, ["merge-base", "HEAD", vs]);
  const baseSha = base.status === 0 ? String(base.stdout).trim() : "";
  const glob = ":(glob).beads/*.yaml";
  const r = baseSha
    ? git(root, ["diff", "--name-only", "--no-renames", "-z", baseSha, tip, "--", glob])
    : git(root, ["ls-tree", "-r", "--name-only", "-z", tip, "--", glob]);
  return new Set(
    String(r.stdout)
      .split("\0")
      .filter(Boolean)
      .map((p) => p.slice(".beads/".length))
      .filter(isMirrorName)
  );
}

/**
 * Num squash não há MERGE_HEAD, logo nem base: o único espelho que dá para
 * atribuir à branch é o que leva o nome dela.
 */
function mirrorOfCurrentBranch(root) {
  const { branch } = currentBranch(root);
  const file = branch ? sanitizeBranch(branch).file : null;
  return new Set(file ? [`${file}.yaml`] : []);
}

/**
 * Como portar o que a recusa lista: um comando por arquivo que sai — `--port <rev>:<arquivo>`
 * lê do commit e vale com o arquivo já apagado do disco — e, de uma vez, o `--port-from`, que
 * com `--recover-mirrors` lê TODOS os espelhos do commit (num repo real criou 32 beads onde o
 * `--port` do arquivo criou 1).
 */
function portHow(rev, files, withMirrors) {
  const cmd = "node aiteam/scripts/migrate-beads.mjs";
  const each = files.map((f) => `${cmd} --port ${rev}:${f}`).join(" ; ");
  const all = `${cmd} --port-from ${rev}${withMirrors ? " --recover-mirrors" : ""}`;
  const extra = withMirrors ? " (o --recover-mirrors traz também o que só existe nos espelhos de outras branches)" : "";
  return `um comando por arquivo que sai (lê do commit, vale com o arquivo já apagado): ${each} — ou, de uma vez, ${all}${extra}`;
}

/** O que a conferência não conseguiu ler (nó sem id ou sem data, fonte com YAML inválido), junto da recusa. */
function unreadNote(unread) {
  return unread.length ? ` — e ficaram de fora desta conta ${unread.length} item(ns) que não deu para ler (${unread[0]})` : "";
}

/** Sem bead faltando, o que não deu para ler vira aviso — não desliga nem trava a conferência. */
function unreadWarning(rev, unread) {
  return unread.length
    ? [`não consegui conferir todo o modelo antigo de ${rev} (${unread[0]}${unread.length > 1 ? ` e mais ${unread.length - 1}` : ""}) — confira à mão se algum bead dele ficou de fora`]
    : [];
}

// O espelho ilegível mais comum: o driver antigo (merge=union) unia os dois lados do arquivo e
// deixava uma chave repetida (branch:, last_updated:), que o YAML não aceita.
const DUP_KEY = "O caso comum é a chave duplicada que o merge=union do driver antigo deixou no arquivo: apague a repetida.";

const MAX_IDS = 10;

/** Os ids da recusa, com teto: num repo real a linha chegava a 8 KB. Passou de 10, "… +N". */
function idList(ids) {
  return ids.length <= MAX_IDS ? ids.join(", ") : `${ids.slice(0, MAX_IDS).join(", ")}, … +${ids.length - MAX_IDS}`;
}

// Não há outro jeito de descartar de propósito: a conferência não tem opt-out, e o --no-verify
// pula o pre-commit inteiro.
const NO_VERIFY = "Descartar de propósito só tem o git commit --no-verify, que também pula o secret scan e o drift das personas";

// O lado "de lá" de um merge (MERGE_HEAD), de um rebase (REBASE_HEAD, o commit que ele
// está aplicando) ou de um cherry-pick (CHERRY_PICK_HEAD): como falar dele nas mensagens.
const THEIRS = {
  MERGE_HEAD: { who: "a branch mergeada (MERGE_HEAD)", mirror: "o espelho da branch mergeada (MERGE_HEAD)", from: "do merge" },
  REBASE_HEAD: { who: "o commit que o rebase aplica (REBASE_HEAD)", mirror: "o espelho do commit que o rebase aplica (REBASE_HEAD)", from: "do rebase" },
  CHERRY_PICK_HEAD: { who: "o commit do cherry-pick (CHERRY_PICK_HEAD)", mirror: "o espelho do commit do cherry-pick (CHERRY_PICK_HEAD)", from: "do cherry-pick" },
};

/**
 * Lado de lá do merge (§11): a branch mergeada — ou o commit que um rebase ou um
 * cherry-pick aplica — está no modelo antigo. O que ela traz (active.yaml,
 * archive/completed.yaml e o espelho dela) tem de estar refletido no resultado
 * staged antes do commit — senão o `git rm` do arquivo antigo perde o bead calado.
 */
function mergeHeadProblems(root, nowMs, tip = "MERGE_HEAD") {
  const t = THEIRS[tip];
  const all = readLegacySources(root, { rev: tip });
  const own = mirrorsChangedBy(root, tip, tip);
  const sources = { ...all, mirrors: all.mirrors.filter((m) => own.has(m.name)) };
  if (sources.active === null && sources.completed === null && sources.mirrors.length === 0) return NONE;
  // Só importa o que falta, não onde seria escrito: nada aqui vai para o disco.
  const as = "port-check";
  const plan = planPortFrom(sources, portContext(root, as, nowMs, { fromIndex: true }), {
    as,
    nowMs,
    label: tip,
    recoverMirrors: true,
    lenient: true,
  });
  // O que não deu para ler (nó sem id ou sem data, fonte com YAML inválido) não pode desligar a
  // conferência dos nós válidos (A4): fica de fora da conta e sai como aviso — ou, se há bead
  // faltando, junto da recusa.
  const unread = [...plan.errors, ...plan.warnings];
  const errors = [];
  // O espelho da própria branch antiga que não dá para ler: o bead dele talvez
  // só exista ali, e o `git rm` o perderia calado. É erro, não aviso (A-A8).
  const unreadable = plan.report?.sources.unreadableMirrors ?? [];
  if (unreadable.length) {
    errors.push(
      `${t.mirror} está ilegível — ${unreadable.map((m) => `.beads/${m.name}: ${m.error}`).join("; ")} — não dá para provar que o bead dele foi portado, e o git rm o perderia calado. ${DUP_KEY} Corrija o YAML (o arquivo está na árvore durante o merge) e rode node aiteam/scripts/migrate-beads.mjs --port-from ${tip} --recover-mirrors; só se ele for lixo e você já portou o que importava, confirme com git commit --no-verify (contrato §11)`
    );
  }
  const missing = [...plan.created, ...plan.appended];
  if (missing.length) {
    const files = [
      ...(sources.active !== null ? [ACTIVE_PATH] : []),
      ...(sources.completed !== null ? [COMPLETED_PATH] : []),
      ...sources.mirrors.map((m) => `.beads/${m.name}`),
    ];
    const how = portHow(tip, files, sources.mirrors.length > 0);
    errors.push(
      `${t.who} está no modelo antigo e traz ${missing.length} bead(s) que o resultado não reflete: ${idList(missing)} — porte antes de tirar o modelo antigo ${t.from}, ${how}. ${NO_VERIFY}${unreadNote(unread)} (contrato §11)`
    );
  }
  if (errors.length) return { errors, warnings: [] };
  // Fonte ilegível, nó sem id ou id que não vira pasta: não dá para provar
  // que nada se perde, e travar o merge para sempre também não serve — vira aviso.
  return { errors: [], warnings: unreadWarning(tip, unread) };
}

/**
 * Lado de cá do merge (§11): o HEAD, a sua branch, está no modelo antigo e o
 * commit tira do índice o que ela tem nele — o caso da branch antiga que recebe
 * a default já migrada (modify/delete do active.yaml) e o `git rm --cached`
 * resolve o conflito. Sem o porte, o bead que só existia aqui some do estado.
 *
 * Confere só o que este commit tira do índice: o que continua rastreado fica no
 * git (e o validate:beads o aponta). Vale o active.yaml e o archive/completed.yaml
 * inteiros, como no lado de lá; dos espelhos, só os que o HEAD mudou desde a base
 * (os velhos de outras branches, que a migração deixou de fora de propósito, não
 * acusam) — e, sem base (squash), só o que leva o nome da branch atual.
 *
 * O mesmo critério vale num commit COMUM (`merge: false`), para o resíduo que um
 * merge limpo deixou rastreado num repo já migrado (o espelho ou o archive/ de uma
 * branch antiga): o post-merge só avisa, e o `git rm --cached` do resíduo, depois,
 * perdia o bead calado. Sem base de merge, o que o commit apaga já basta — todo
 * espelho que sai conta, e o que o resultado já reflete (a limpeza do que foi
 * portado, ou de um espelho velho cujos beads já estão em .beads/tasks/) passa.
 *
 * Com o HEAD ainda legado (A5), o commit comum que tira o active.yaml ou o
 * archive/completed.yaml do índice é a migração — que passa, porque leva os nós deles —
 * ou um `git rm --cached` à mão, que perdia tudo: confere esses dois, e só eles; os
 * espelhos, que a migração deixa de fora de propósito, não entram.
 */
function headProblems(root, nowMs, { merge, hasMergeHead, rewrite = false }) {
  // Num rebase concluído (`rewrite`) o lado a conferir é o ORIG_HEAD — a branch como
  // era antes de ser reescrita —, e não mais o HEAD.
  const rev = rewrite ? "ORIG_HEAD" : "HEAD";
  const all = readLegacySources(root, { rev });
  if (all.active === null && all.completed === null && all.mirrors.length === 0) return NONE;
  // HEAD legado: a branch antiga mesma. Migrado, o que ele rastreia do modelo antigo é resíduo.
  const headLegacy = all.active !== null;
  const tracked = new Set(indexPaths(root, [".beads"]));
  const leaves = (rel) => !tracked.has(rel);
  // Só um HEAD legado se restringe à base do merge: os espelhos velhos de OUTRAS branches
  // ficaram de fora da migração de propósito, e é o HEAD legado que os traz de antes. Com o
  // HEAD migrado, todo espelho que ele rastreia é resíduo, e vale todo espelho que sai —
  // dentro de um commit de merge também (A2): o resíduo anterior à base não sai de graça.
  //
  // Commit comum com o HEAD ainda legado (A5): é a migração, ou um `git rm --cached` à mão.
  // O active.yaml e o archive/completed.yaml a migração sempre leva — um nó deles que o
  // resultado não reflete é perda, e sem o migrate o commit perdia tudo. Os espelhos ela deixa
  // de fora de propósito (o relatório os lista, e o --recover-mirrors os traz): não entram.
  const own = rewrite
    ? mirrorsChangedBy(root, rev, rev)
    : !headLegacy
      ? new Set(all.mirrors.map((m) => m.name))
      : !merge
        ? new Set()
        : hasMergeHead
          ? mirrorsChangedBy(root, "HEAD")
          : mirrorOfCurrentBranch(root);
  const sources = {
    active: all.active !== null && leaves(ACTIVE_PATH) ? all.active : null,
    completed: all.completed !== null && leaves(COMPLETED_PATH) ? all.completed : null,
    // Só serve ao relatório da migração; nada a conferir aqui.
    index: null,
    mirrors: all.mirrors.filter((m) => own.has(m.name) && leaves(`.beads/${m.name}`)),
  };
  const leaving = [
    ...(sources.active !== null ? [ACTIVE_PATH] : []),
    ...(sources.completed !== null ? [COMPLETED_PATH] : []),
    ...sources.mirrors.map((m) => `.beads/${m.name}`),
  ];
  if (leaving.length === 0) return NONE;
  const as = "port-check";
  const plan = planPortFrom(sources, portContext(root, as, nowMs, { fromIndex: true }), {
    as,
    nowMs,
    label: rev,
    recoverMirrors: true,
    lenient: true,
  });
  // Ver o mesmo comentário em mergeHeadProblems: o que não deu para ler não desliga a conferência (A4).
  const unread = [...plan.errors, ...plan.warnings];
  const errors = [];
  const unreadable = plan.report?.sources.unreadableMirrors ?? [];
  if (unreadable.length) {
    const whose = rewrite
      ? "o espelho da branch antes do rebase (ORIG_HEAD)"
      : headLegacy
        ? "o espelho da sua branch (HEAD)"
        : "o espelho do modelo antigo que o HEAD rastreia";
    errors.push(
      `${whose} está ilegível — ${unreadable.map((m) => `.beads/${m.name}: ${m.error}`).join("; ")} — não dá para provar que o bead dele foi portado, e tirá-lo do índice o perderia calado. ${DUP_KEY} Mantenha-o no índice (não rode git rm --cached nele) até corrigir o YAML e portar o que ele traz (node aiteam/scripts/migrate-beads.mjs --port <arquivo>); só se ele for lixo e você já portou o que importava, confirme com git commit --no-verify (contrato §11)`
    );
  }
  const missing = [...plan.created, ...plan.appended];
  if (missing.length) {
    // Um comando por arquivo que sai; o --port-from (com --recover-mirrors, se um espelho sai)
    // fica como alternativa de uma vez só, com o aviso do que ele traz a mais.
    const how = portHow(rev, leaving, sources.mirrors.length > 0);
    const gone = `${leaving.join(", ")} do índice sem portar ${missing.length} bead(s) que o resultado não reflete: ${idList(missing)}`;
    errors.push(
      rewrite
        ? `a branch antes do rebase (ORIG_HEAD) estava no modelo antigo e o rebase tirou ${gone} — eles sumiram do estado, e o git não roda o pre-commit no rebase --continue, então nada recusou. Porte agora e commite (o commit antigo continua em ORIG_HEAD), ${how}${unreadNote(unread)} (contrato §11)`
        : `${headLegacy ? "a sua branch (HEAD) está no modelo antigo" : "o HEAD ainda rastreia o modelo antigo (resíduo de um merge)"} e este commit tira ${gone} — eles sumiriam do estado. Porte antes, ${how}${!merge && headLegacy ? " — ou, se a intenção é migrar, rode node aiteam/scripts/migrate-beads.mjs (ele leva o active.yaml e o archive/)" : ""}. ${NO_VERIFY}${unreadNote(unread)} (contrato §11)`
    );
  }
  if (errors.length) return { errors, warnings: [] };
  return { errors: [], warnings: unreadWarning(rev, unread) };
}

/**
 * Merge ou squash que mexe com o modelo antigo (§11), nos dois sentidos: a
 * branch mergeada (MERGE_HEAD) no modelo antigo, entrando numa já migrada, e a
 * sua própria branch (HEAD) no modelo antigo, recebendo a default migrada. Em
 * qualquer um, o que o modelo antigo tem tem de estar refletido no resultado
 * staged antes do commit — senão o `git rm` do arquivo antigo perde o bead
 * calado. Sem MERGE_HEAD (squash) só o lado do HEAD tem o que conferir.
 */
export function legacyMergeProblems(root, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const hasMergeHead = git(root, ["rev-parse", "-q", "--verify", "MERGE_HEAD^{commit}"]).status === 0;
  const theirs = hasMergeHead ? mergeHeadProblems(root, nowMs, "MERGE_HEAD") : NONE;
  const mine = headProblems(root, nowMs, { merge: true, hasMergeHead });
  return { errors: [...theirs.errors, ...mine.errors], warnings: [...theirs.warnings, ...mine.warnings] };
}

/**
 * O commit que um rebase ou um cherry-pick está aplicando, se há um em curso: o
 * REBASE_HEAD (só com o rebase de fato em andamento — um REBASE_HEAD esquecido não
 * conta) ou o CHERRY_PICK_HEAD. É o lado "de lá" desses dois, como o MERGE_HEAD é o
 * de um merge.
 */
function pickHead(root) {
  const exists = (ref) => git(root, ["rev-parse", "-q", "--verify", `${ref}^{commit}`]).status === 0;
  const rebasing = ["rebase-merge", "rebase-apply"].some((d) => {
    const r = git(root, ["rev-parse", "--git-path", d]);
    return r.status === 0 && fs.existsSync(path.resolve(root, String(r.stdout).trim()));
  });
  if (rebasing && exists("REBASE_HEAD")) return "REBASE_HEAD";
  if (exists("CHERRY_PICK_HEAD")) return "CHERRY_PICK_HEAD";
  return null;
}

/**
 * Rebase ou cherry-pick de uma branch do modelo antigo sobre uma já migrada (§11):
 * o HEAD é a default, não há MERGE_HEAD, e depois do `git rm --cached` do
 * active.yaml e do espelho o diff do commit nem tem .beads — o hook voltava cedo e
 * o bead sumia do estado (e do histórico de HEAD, onde o --scan-history o buscaria).
 * O lado "de lá" é o commit aplicado, conferido como o MERGE_HEAD num merge.
 */
export function legacyPickProblems(root, opts = {}) {
  try {
    const tip = pickHead(root);
    if (tip === null) return NONE;
    return mergeHeadProblems(root, opts.nowMs ?? Date.now(), tip);
  } catch (err) {
    // Um erro do git não pode travar todo --continue: sai como aviso, não como recusa.
    return { errors: [], warnings: [`não consegui conferir o modelo antigo do commit que o rebase ou o cherry-pick aplica (${firstLine(err?.message)})`] };
  }
}

/**
 * Rebase concluído (post-rewrite) de uma branch do modelo antigo sobre uma já
 * migrada (§11). O git roda os commits do rebase com `-n`: o `git rebase --continue`
 * NÃO chama o pre-commit, então não há como recusar o `git rm --cached` do
 * active.yaml e do espelho no momento em que ele acontece. O que dá para fazer é
 * conferir no fim, contra o ORIG_HEAD (a branch como era antes do rebase), e avisar
 * alto, com o comando que traz o bead de volta — o commit antigo continua lá.
 */
export function legacyRewriteProblems(root, opts = {}) {
  try {
    if (git(root, ["rev-parse", "-q", "--verify", "ORIG_HEAD^{commit}"]).status !== 0) return NONE;
    return headProblems(root, opts.nowMs ?? Date.now(), { merge: false, hasMergeHead: false, rewrite: true });
  } catch (err) {
    return { errors: [], warnings: [`não consegui conferir o modelo antigo da branch antes do rebase (${firstLine(err?.message)})`] };
  }
}

/**
 * Commit comum que apaga do índice o resíduo do modelo antigo (§11): o espelho ou
 * o archive/ que um merge limpo deixou rastreado num repo já migrado. O que ele
 * tem tem de estar refletido em .beads/tasks/ — senão o `git rm --cached`, que o
 * pre-commit permite como limpeza, perde o bead calado.
 */
export function legacyResidueProblems(root, opts = {}) {
  try {
    return headProblems(root, opts.nowMs ?? Date.now(), { merge: false, hasMergeHead: false });
  } catch (err) {
    // Um erro do git não pode travar todo commit: sai como aviso, não como recusa.
    return { errors: [], warnings: [`não consegui conferir o resíduo do modelo antigo que o commit apaga (${firstLine(err?.message)})`] };
  }
}

