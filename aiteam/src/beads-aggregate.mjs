// Agregação do estado dos beads entre branches e worktrees (fase 2 da #37).
// Contrato: aiteam/docs/beads-schema.md §13.
//
// O estado combinado das visões (active.yaml, index.yaml) é só o da árvore
// atual. Com despachos isolados em worktrees, o trabalho de outra branch só
// aparece depois do merge. Este módulo lê, sob demanda, o que as outras
// branches e worktrees já fizeram nos beads — e NUNCA o grava: o resultado não
// vai para arquivo versionado nem para as visões, e aparece sempre marcado
// como "não mergeado". Quem consome (o comando beads, o brief, o board) mostra
// a origem de cada linha.
//
// Fontes (D2/D3 do plano):
//   - heads locais (refs/heads) ainda não mergeados em HEAD;
//   - outras worktrees: o estado não commitado, lido do disco;
//   - refs remotos, só com `remotes: true`.
// Os arquivos de bead só crescem no fim, então as versões de um mesmo arquivo
// formam uma cadeia por prefixo e vence a mais longa (pickVersions, no núcleo).
//
// Só node:*, o núcleo e o io — roda sem aiteam/node_modules. Sem shebang.
// Nada aqui escreve no .git/config nem faz fetch; nas outras worktrees o git
// roda com --no-optional-locks, para nunca disputar o index.lock com o
// commit de quem está trabalhando lá.

import * as fs from "node:fs";
import * as path from "node:path";
import { byteCompare, cleanText, combineBead, pickVersions, sanitizeBranch, sourceLabel } from "./beads-core.mjs";
import { catFiles, catSizes, classifyBeadsPath, currentBranch, git, isLegacy, listBeadIds, readBeadFiles } from "./beads-io.mjs";

export { cleanText };

export const DEFAULT_SINCE_DAYS = 30;
export const DEFAULT_MAX_REFS = 50;
/** Arquivo de bead maior que isto não é lido de outra worktree nem de um ref. */
export const MAX_FILE_BYTES = 256 * 1024;

const DAY_MS = 24 * 60 * 60 * 1000;
const DETACHED = "(HEAD destacado)";
const lf = (s) => String(s ?? "").replace(/\r\n/g, "\n");
const TASKS = ".beads/tasks";

// ── git ──────────────────────────────────────────────────────────────────────

/** `git worktree list --porcelain` em registros: `{dir, head, branch, detached, bare, prunable}`. */
export function parseWorktreeList(text, sep) {
  const out = [];
  let cur = null;
  const flush = () => {
    if (cur?.dir) out.push(cur);
    cur = null;
  };
  for (const field of String(text).split(sep)) {
    if (field === "") {
      flush();
      continue;
    }
    if (field.startsWith("worktree ")) {
      flush();
      cur = { dir: field.slice("worktree ".length), head: null, branch: null, detached: false, bare: false, prunable: false };
    } else if (cur) {
      if (field.startsWith("HEAD ")) cur.head = field.slice(5);
      else if (field.startsWith("branch ")) cur.branch = field.slice(7).replace(/^refs\/heads\//, "");
      else if (field === "detached") cur.detached = true;
      else if (field === "bare") cur.bare = true;
      else if (field === "prunable" || field.startsWith("prunable ")) cur.prunable = true;
    }
  }
  flush();
  return out;
}

function listWorktrees(root, timeout) {
  // -z (git >= 2.36) protege caminhos com quebra de linha; sem ele, o formato antigo.
  let r = git(root, ["worktree", "list", "--porcelain", "-z"], { timeout });
  let sep = "\0";
  if (r.status !== 0) {
    r = git(root, ["worktree", "list", "--porcelain"], { timeout });
    sep = "\n";
  }
  return r.status === 0 ? parseWorktreeList(r.stdout, sep) : [];
}

/**
 * O que cada ref mudou nos beads desde que HEAD o deixou para trás. `revList` é a
 * saída de `git rev-list --parents <refs> --not HEAD` (os commits que HEAD não
 * tem, com os pais) e `logText` a de `git log -c --name-only -z --format=%x01%H
 * … -- .beads/tasks` (os caminhos que cada um tocou; num merge, só o que ele mudou
 * em relação a todos os pais — o `-m` listaria tudo o que a main trouxe). O conjunto
 * de um ref é a união dos caminhos dos ancestrais dele que HEAD não tem: uma branch
 * empilhada sobre outra herda os caminhos da de baixo. Caminho com caractere de
 * controle fica de fora (desalinharia o cat-file). Devolve `Map<sha, Set<caminho>>`.
 */
export function pathsByRef(shas, revList, logText) {
  const parents = new Map();
  for (const line of String(revList).split("\n")) {
    if (!line) continue;
    const [commit, ...ps] = line.split(" ");
    parents.set(commit, ps.filter(Boolean));
  }
  const touched = new Map();
  let current = null;
  for (const token of String(logText).split("\0")) {
    if (token === "") continue;
    if (token.startsWith("\u0001")) {
      current = token.slice(1).trim();
      if (!touched.has(current)) touched.set(current, new Set());
      continue;
    }
    const rel = token.replace(/^\n/, "");
    if (current && rel.startsWith(`${TASKS}/`) && !/[\u0000-\u001f\u007f]/.test(rel)) touched.get(current).add(rel);
  }
  const out = new Map();
  for (const sha of shas) {
    const paths = new Set();
    const seen = new Set();
    const stack = [sha];
    while (stack.length) {
      const c = stack.pop();
      if (seen.has(c) || !parents.has(c)) continue; // fora do intervalo: HEAD já o tem
      seen.add(c);
      for (const p of touched.get(c) ?? []) paths.add(p);
      stack.push(...parents.get(c));
    }
    out.set(sha, paths);
  }
  return out;
}

const comparable = (p) => {
  let abs = path.resolve(p);
  try {
    abs = fs.realpathSync(abs);
  } catch {
    /* o caminho não existe: compara como veio */
  }
  return process.platform === "win32" || process.platform === "darwin" ? abs.toLowerCase() : abs;
};

/** Os refs de `refs/heads` (e `refs/remotes`, se pedido) não mergeados em HEAD, do mais recente ao mais antigo. */
export function parseRefList(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    if (!line) continue;
    const [name, sha, ts] = line.split("\0");
    if (!name || !/^[0-9a-f]{7,64}$/.test(sha ?? "")) continue;
    if (name.startsWith("refs/heads/")) {
      out.push({ name, kind: "head", branch: name.slice("refs/heads/".length), display: name.slice("refs/heads/".length), sha, ts: Number(ts) || 0 });
    } else if (name.startsWith("refs/remotes/")) {
      const rest = name.slice("refs/remotes/".length);
      const slash = rest.indexOf("/");
      const branch = slash < 0 ? rest : rest.slice(slash + 1);
      if (slash < 0 || branch === "HEAD") continue; // origin/HEAD não é uma branch
      out.push({ name, kind: "remote", branch, display: rest, sha, ts: Number(ts) || 0 });
    }
  }
  return out;
}

// ── Leitura de outra worktree (estado não commitado) ─────────────────────────

const insideOf = (parent, child) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);

/** Só arquivo regular, dentro da worktree e de tamanho razoável; o resto vira `{problem}`. */
function readWorktreeFile(dir, rel, maxBytes) {
  const abs = path.join(dir, ...rel.split("/"));
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return { problem: "sumiu enquanto eu lia" };
  }
  if (st.isSymbolicLink()) return { problem: "é um link simbólico" };
  if (!st.isFile()) return { problem: "não é arquivo regular" };
  if (st.size > maxBytes) return { problem: `passa de ${Math.round(maxBytes / 1024)} KB` };
  try {
    if (!insideOf(fs.realpathSync(dir), fs.realpathSync(abs))) return { problem: "fica fora da worktree" };
    return { text: fs.readFileSync(abs, "utf8") };
  } catch {
    return { problem: "ilegível agora" };
  }
}

/** Os arquivos de bead mudados (ou novos) na worktree, lidos do disco. */
function readDirty(wt, maxBytes, warnings, timeout) {
  // --no-optional-locks: o status comum atualiza o índice, e isso toma o
  // index.lock da worktree — que quebraria um commit em andamento lá.
  const r = git(wt.dir, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", TASKS], { timeout });
  if (r.status !== 0) {
    warnings.push(`worktree ${wt.branch ?? wt.dir}: não consegui ler o estado não commitado (git status falhou)`);
    return [];
  }
  const out = [];
  for (const rec of String(r.stdout).split("\0")) {
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const rel = rec.slice(3);
    if (xy.includes("D")) continue;
    const c = classifyBeadsPath(rel);
    if (c.kind !== "task") continue;
    const f = readWorktreeFile(wt.dir, rel, maxBytes);
    if (f.problem) {
      warnings.push(`worktree ${wt.branch ?? wt.dir}: ${rel} ignorado (${f.problem})`);
      continue;
    }
    out.push({ bead: c.id, branchFile: c.branchFile, text: f.text, rel });
  }
  return out;
}

// ── A árvore desta worktree ──────────────────────────────────────────────────

// Ids e arquivos por bead. Sem `given` (o readTreeInputs de quem já leu tudo),
// lê do disco só o que se pede: listar as pastas é barato, ler 600 arquivos não.
function makeTree(root, given) {
  if (given) {
    const byBead = new Map();
    for (const f of given.beads) byBead.set(f.bead, [...(byBead.get(f.bead) ?? []), { branchFile: f.branchFile, text: f.text }]);
    return { ids: () => [...byBead.keys()], has: (id) => byBead.has(id), files: (id) => byBead.get(id) ?? [] };
  }
  const ids = listBeadIds(root);
  const known = new Set(ids);
  const cache = new Map();
  return {
    ids: () => ids,
    has: (id) => known.has(id),
    files(id) {
      if (!cache.has(id)) cache.set(id, known.has(id) ? readBeadFiles(root, id) : []);
      return cache.get(id);
    },
  };
}

// ── A agregação ──────────────────────────────────────────────────────────────

const KIND_TIPO = { worktree: "worktree", head: "local", remote: "remoto" };
const KIND_ORDER = { worktree: 0, head: 1, remote: 2 };

const stageOf = (bead) => (typeof bead.fields.stage === "string" ? bead.fields.stage : null);
const blockersOf = (bead) => (Array.isArray(bead.fields.blockers) ? bead.fields.blockers : []);
const summary = (bead) => ({ status: bead.status, stage: stageOf(bead), blockers: blockersOf(bead), updated_at: bead.updated_at });

// Colisão de nomes (feat/x × feat-x → feat-x.yaml): todo head, todo remoto (só
// os nomes — não custa leitura) e as branches das worktrees, como o aviso do pre-commit.
function collisionWarnings(root, current, wts) {
  const names = new Set();
  const refs = git(root, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]);
  for (const name of String(refs.stdout).split("\n")) {
    if (name.startsWith("refs/heads/")) names.add(name.slice("refs/heads/".length));
    else if (name.startsWith("refs/remotes/")) {
      const rest = name.slice("refs/remotes/".length);
      const branch = rest.slice(rest.indexOf("/") + 1);
      if (rest.includes("/") && branch !== "HEAD") names.add(branch);
    }
  }
  if (current) names.add(current);
  for (const wt of wts) if (wt.branch) names.add(wt.branch);
  const byFile = new Map();
  for (const n of names) {
    const f = sanitizeBranch(n).file;
    if (f) byFile.set(f, [...(byFile.get(f) ?? []), n]);
  }
  const out = [];
  for (const [file, group] of [...byFile].sort((a, b) => byteCompare(a[0], b[0]))) {
    if (group.length < 2) continue;
    const sorted = group.sort(byteCompare);
    out.push(`as branches ${sorted.map((n) => `"${n}"`).join(" e ")} viram o mesmo arquivo ${file}.yaml — renomeie uma delas`);
  }
  return out;
}

/**
 * Agrega o que as outras branches e worktrees fizeram nos beads.
 *
 * Opções: `sinceDays` (30) e `maxRefs` (50) limitam os heads lidos — a branch
 * de uma worktree ativa entra sempre; `remotes` inclui refs/remotes;
 * `deadlineMs` é o prazo: estourado, a leitura para e `partial` vem true;
 * `collisions` lista também as colisões de nome de branch; `tree` reaproveita
 * a leitura da árvore (readTreeInputs); `nowMs` é a costura dos testes.
 *
 * Devolve `{skipped, partial, elsewhere, warnings, stats}`. `skipped` (texto)
 * vale em modo legado e em HEAD sem commit — nada é agregado. Cada item de
 * `elsewhere`: `{id, title, aqui, la, fontes}`, onde `aqui` é o estado desta
 * árvore (null se o bead é novo) e `la` o estado combinado com o que as outras
 * fontes trazem.
 */
export function aggregate(root, opts = {}) {
  const started = Date.now();
  const result = {
    skipped: null,
    partial: false,
    elsewhere: [],
    warnings: [],
    stats: { refsListed: 0, refsRead: 0, refsOutOfWindow: 0, refsOverLimit: 0, blobsRead: 0, blobsOversize: 0, worktrees: 0, ms: 0 },
  };
  // Nunca lança: um git que falha, um objeto ilegível ou uma worktree que some
  // no meio da leitura viram aviso e `partial` — quem consome (o comando, o
  // brief, o board) segue sem a seção, em vez de cair junto.
  try {
    return aggregateRun(root, opts, result, started);
  } catch (err) {
    result.partial = true;
    result.warnings.push(`agregação falhou: ${cleanText(err?.message, 200)}`);
    result.stats.ms = Date.now() - started;
    return result;
  }
}

function aggregateRun(root, opts, result, started) {
  const nowMs = opts.nowMs ?? started;
  const sinceDays = opts.sinceDays ?? DEFAULT_SINCE_DAYS;
  const maxRefs = opts.maxRefs ?? DEFAULT_MAX_REFS;
  const maxBytes = opts.maxFileBytes ?? MAX_FILE_BYTES;
  const late = () => opts.deadlineMs != null && Date.now() - started >= opts.deadlineMs;
  // O que resta do prazo, para um git pendurado (disco de rede, repo enorme)
  // não passar dele: spawnSync mata o processo no timeout.
  const remaining = () => (opts.deadlineMs == null ? undefined : Math.max(100, opts.deadlineMs - (Date.now() - started)));

  const finish = () => {
    result.stats.ms = Date.now() - started;
    return result;
  };

  const headRev = git(root, ["rev-parse", "-q", "--verify", "HEAD^{commit}"], { timeout: remaining() });
  if (headRev.status !== 0) {
    if (late()) result.partial = true;
    else result.skipped = "HEAD sem commit";
    return finish();
  }
  const headSha = String(headRev.stdout).trim();
  if (isLegacy(root, { timeout: remaining() })) {
    result.skipped = "modo legado";
    return finish();
  }

  const current = currentBranch(root).branch;
  const tree = makeTree(root, opts.tree);
  const treeText = (bead, branchFile) => tree.files(bead).find((f) => f.branchFile === branchFile)?.text;

  const versions = []; // só as fontes que não são a árvore
  const addVersion = (bead, branchFile, text, source) => {
    // Um arquivo que é prefixo do nosso (a outra branch está atrás, ou é a mesma
    // versão) não traz nada: os arquivos só crescem no fim.
    const own = treeText(bead, branchFile);
    if (own !== undefined && lf(own).startsWith(lf(text))) return;
    versions.push({ bead, branchFile, text, source });
  };

  // 1. Outras worktrees: o estado não commitado, e as branches delas (que entram sempre).
  const me = comparable(root);
  const wts = listWorktrees(root, remaining()).filter((w) => !w.bare && !w.prunable && comparable(w.dir) !== me && fs.existsSync(w.dir));
  result.stats.worktrees = wts.length;
  const pinned = new Set(wts.map((w) => w.branch).filter(Boolean));
  // Worktree em HEAD destacado: o commit dela não tem branch, mas o trabalho conta do mesmo jeito.
  const detached = wts
    .filter((w) => w.detached && w.head)
    .map((w) => ({ name: `worktree:${w.dir}`, kind: "head", branch: DETACHED, display: `${path.basename(w.dir)} (HEAD destacado)`, sha: w.head, ts: nowMs / 1000 }));
  if (detached.length) pinned.add(DETACHED);
  for (const wt of wts) {
    if (late()) {
      result.partial = true;
      break;
    }
    for (const f of readDirty(wt, maxBytes, result.warnings, remaining())) {
      addVersion(f.bead, f.branchFile, f.text, { kind: "worktree", branch: wt.branch ?? DETACHED, dir: wt.dir });
    }
  }

  // 2. Refs não mergeados em HEAD: janela de dias, teto de refs, um por sha.
  const refArgs = ["for-each-ref", "--no-merged=HEAD", "--sort=-committerdate", "--format=%(refname)%00%(objectname)%00%(committerdate:unix)", "refs/heads"];
  if (opts.remotes) refArgs.push("refs/remotes");
  const listed = late() ? { status: 1, stdout: "" } : git(root, refArgs, { timeout: remaining() });
  if (late()) result.partial = true;
  const all = [...detached, ...parseRefList(listed.stdout).filter((r) => !(r.kind === "head" && r.branch === current))];
  result.stats.refsListed = all.length;

  const cutoff = nowMs - sinceDays * DAY_MS;
  const bySha = new Map(); // sha → ref escolhido (worktree ativa > head > remoto)
  const rank = (r) => (r.kind === "head" && pinned.has(r.branch) ? 0 : r.kind === "head" ? 1 : 2);
  for (const r of all) {
    const isPinned = r.kind === "head" && pinned.has(r.branch);
    if (!isPinned && r.ts * 1000 < cutoff) {
      result.stats.refsOutOfWindow++;
      continue;
    }
    const prev = bySha.get(r.sha);
    if (!prev) bySha.set(r.sha, { ...r, aliases: [] });
    else if (rank(r) < rank(prev)) bySha.set(r.sha, { ...r, aliases: [prev.branch, ...prev.aliases] });
    else prev.aliases.push(r.branch);
  }
  const ordered = [...bySha.values()].sort((a, b) => rank(a) - rank(b) || b.ts - a.ts);
  const chosen = [];
  let free = maxRefs;
  for (const r of ordered) {
    if (rank(r) === 0) chosen.push(r);
    else if (free > 0) {
      chosen.push(r);
      free--;
    } else result.stats.refsOverLimit++;
  }

  // 3. O que cada ref mudou nos beads desde a bifurcação com HEAD — e só isso.
  // Dois processos para todos os refs: `rev-list --parents` (o grafo dos
  // commits que HEAD não tem) e `log -c --name-only` (os caminhos que cada um
  // tocou; num merge, só o que ele mudou em relação a todos os pais); o conjunto
  // de cada ref é a união dos caminhos dos seus ancestrais fora de HEAD
  // (pathsByRef). Comparar a árvore do ref com a de HEAD trazia também tudo o que
  // HEAD andou depois do fork — milhares de nomes no cat-file — e o bead que HEAD
  // apagou "ressuscitava" como novo.
  const wanted = []; // {ref, rel, c}
  if (chosen.length && late()) result.partial = true;
  else if (chosen.length) {
    const shas = chosen.map((r) => r.sha);
    const range = [...shas, "--not", headSha];
    const graph = git(root, ["rev-list", "--parents", ...range], { timeout: remaining() });
    // `-c` (diff combinado), não `-m`: num commit de merge o `-m` lista tudo o que o outro
    // pai mudou — a main inteira, para um ref que a mesclou (A-R1b). O `-c` lista só o que
    // o merge mudou em relação a TODOS os pais (a resolução de conflito, o evil merge); o
    // que a main trouxe já está nos pais e nos commits dela.
    const log = graph.status === 0 ? git(root, ["log", "-c", "--name-only", "--no-renames", "-z", "--format=%x01%H", ...range, "--", TASKS], { timeout: remaining() }) : graph;
    result.stats.refsRead = chosen.length;
    if (graph.status !== 0 || log.status !== 0) {
      if (late()) result.partial = true;
      else result.warnings.push("não consegui ler o que os refs mudaram (git rev-list ou git log falhou)");
    } else {
      const byRef = pathsByRef(shas, graph.stdout, log.stdout);
      for (const r of chosen) {
        for (const rel of byRef.get(r.sha) ?? []) {
          const c = classifyBeadsPath(rel);
          if (c.kind === "task") wanted.push({ ref: r, rel, c });
        }
      }
    }
  }
  // O tamanho vem antes (batch-check): blob grande nem é lido, e um objeto
  // ilegível degrada para aviso em vez de derrubar o agregador.
  try {
    const names = wanted.map((w) => `${w.ref.sha}:${w.rel}`);
    const diag = [];
    const sizes = catSizes(root, names, { timeout: remaining(), diag });
    if (diag.length) {
      // Objeto ilegível (o git o conta como "missing" e só reclama no stderr): sem ele a leitura é parcial.
      result.partial = true;
      result.warnings.push(`o git relatou erro ao ler objetos dos refs: ${cleanText(diag[0].split("\n")[0], 200)}`);
    }
    const readable = [];
    for (const w of wanted) {
      const size = sizes.get(`${w.ref.sha}:${w.rel}`);
      if (size === null || size === undefined) continue; // apagado no ref, ou nome que não dá para ler
      if (size > maxBytes) {
        result.stats.blobsOversize++;
        result.warnings.push(`${w.ref.display}: ${w.rel} ignorado (passa de ${Math.round(maxBytes / 1024)} KB)`);
        continue;
      }
      readable.push(w);
    }
    const blobs = catFiles(root, readable.map((w) => `${w.ref.sha}:${w.rel}`), { timeout: remaining() });
    result.stats.blobsRead = readable.length;
    for (const w of readable) {
      const text = blobs.get(`${w.ref.sha}:${w.rel}`);
      if (typeof text !== "string") continue;
      addVersion(w.c.id, w.c.branchFile, text, {
        kind: w.ref.kind,
        branch: w.ref.branch,
        display: w.ref.display,
        aliases: w.ref.aliases,
        sha7: w.ref.sha.slice(0, 7),
        ref: w.ref.name,
      });
    }
  } catch (err) {
    result.partial = true;
    result.warnings.push(`não consegui ler os blobs dos refs: ${cleanText(err?.message, 200)}`);
  }

  // 4. Escolha da versão de cada arquivo e o estado combinado dos beads tocados.
  const touched = new Set(versions.map((v) => `${v.bead}\0${v.branchFile}`));
  const withTree = [...versions];
  for (const key of touched) {
    const [bead, branchFile] = key.split("\0");
    const t = treeText(bead, branchFile);
    if (t !== undefined) withTree.push({ bead, branchFile, text: t, source: { kind: "tree", branch: current ?? undefined } });
  }
  const { picked, warnings } = pickVersions(withTree);
  result.warnings.push(...warnings);

  const byBead = new Map();
  for (const p of picked) {
    const own = treeText(p.bead, p.branchFile);
    if (p.source.kind === "tree" || lf(p.text) === lf(own ?? "")) continue; // a árvore já tem tudo
    byBead.set(p.bead, [...(byBead.get(p.bead) ?? []), p]);
  }

  const localIds = new Map(tree.ids().map((id) => [id.toLowerCase(), id]));
  const newByLower = new Map();
  for (const id of byBead.keys()) {
    if (tree.has(id)) continue;
    newByLower.set(id.toLowerCase(), [...(newByLower.get(id.toLowerCase()) ?? []), id]);
  }

  for (const id of [...byBead.keys()].sort(byteCompare)) {
    const picks = byBead.get(id);
    const origin = picks.map((p) => sourceLabel(p.source)).join(", ");
    const twin = localIds.get(id.toLowerCase());
    if (twin !== undefined && twin !== id) {
      result.warnings.push(`.beads/tasks/${id}/ (em ${origin}) colide com ${twin} desta árvore ignorando maiúsculas e minúsculas — o merge vai falhar; renomeie um deles`);
      continue;
    }
    const siblings = newByLower.get(id.toLowerCase()) ?? [];
    if (siblings.length > 1) {
      result.warnings.push(`beads ${siblings.sort(byteCompare).join(", ")} só diferem em maiúsculas e minúsculas (${origin}) — o merge vai falhar; renomeie um deles`);
      continue;
    }

    const here = tree.has(id) ? tree.files(id) : null;
    const files = new Map((here ?? []).map((f) => [f.branchFile, f.text]));
    for (const p of picks) files.set(p.branchFile, p.text);
    const there = combineBead(id, [...files].map(([branchFile, text]) => ({ branchFile, text })), { nowMs });
    if (!there.bead) {
      result.warnings.push(`bead ${id} fica inválido combinado com ${origin}: ${there.errors[0] ?? "erro desconhecido"} — fora de "outras branches"`);
      continue;
    }
    let aqui = null;
    let aquiCombination = [];
    if (here) {
      const r = combineBead(id, here, { nowMs });
      aquiCombination = r.combination;
      aqui = r.bead ? summary(r.bead) : { status: "inválido", stage: null, blockers: [], updated_at: null };
    }
    const la = summary(there.bead);
    // Avisos que o merge destas fontes traria (definido por A e B, empate de horário…).
    for (const w of there.combination) {
      // "nenhum status" não é problema de merge: o `la.status` já mostra o pending.
      if (!aquiCombination.includes(w) && !/nenhum status/.test(w)) result.warnings.push(`${w} (ao mergear ${origin})`);
    }
    const changed = !aqui || aqui.status !== la.status || aqui.stage !== la.stage || JSON.stringify(aqui.blockers) !== JSON.stringify(la.blockers);
    if (!changed) continue;

    const fontes = [];
    const seen = new Set();
    for (const p of picks) {
      const own = treeText(p.bead, p.branchFile);
      for (const c of p.chain) {
        if (c.source.kind === "tree") continue;
        if (own !== undefined && lf(c.text).length <= lf(own).length) continue; // não traz nada além da árvore
        const arquivo = `.beads/tasks/${p.bead}/${p.branchFile}.yaml`;
        const ref = c.source.display ?? c.source.branch ?? "";
        const k = `${arquivo}|${c.source.kind}|${ref}`;
        if (seen.has(k)) continue;
        seen.add(k);
        fontes.push({
          arquivo,
          tipo: KIND_TIPO[c.source.kind] ?? c.source.kind,
          ref,
          sha7: c.source.sha7 ?? null,
          nao_commitado: c.source.kind === "worktree",
          origem: sourceLabel(c.source),
          kind: c.source.kind,
        });
      }
    }
    fontes.sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || byteCompare(a.ref, b.ref) || byteCompare(a.arquivo, b.arquivo));
    const title = there.bead.fields.title ?? there.bead.fields.description;
    result.elsewhere.push({
      id,
      title: typeof title === "string" ? title : "",
      aqui,
      la,
      fontes: fontes.map(({ kind: _kind, ...f }) => f),
    });
  }
  result.elsewhere.sort((a, b) => byteCompare(b.la.updated_at ?? "", a.la.updated_at ?? "") || byteCompare(a.id, b.id));

  if (opts.collisions && !late()) result.warnings.push(...collisionWarnings(root, current, wts));
  if (late()) result.partial = true;
  return finish();
}

// ── Texto para quem mostra (status, brief, board) ────────────────────────────

/** A origem de um item: a primeira fonte, mais `+N` se houver outras. */
export function originOf(entry) {
  const first = entry.fontes[0];
  if (!first) return "";
  const more = entry.fontes.length > 1 ? ` +${entry.fontes.length - 1}` : "";
  return `${cleanText(first.origem, 80)}${more}`;
}

/** `id  aqui → lá  ↗ origem  título` — a linha de uma branch que ainda não foi mergeada. */
export function elsewhereLine(entry, { titleMax = 140 } = {}) {
  const aqui = entry.aqui ? entry.aqui.status : "novo";
  const stage = entry.la.stage ? ` (${cleanText(entry.la.stage, 20)})` : "";
  const title = cleanText(entry.title, titleMax);
  return `${cleanText(entry.id, 60)}  ${aqui} → ${entry.la.status}${stage}  ↗ ${originOf(entry)}${title ? `  ${title}` : ""}`;
}
