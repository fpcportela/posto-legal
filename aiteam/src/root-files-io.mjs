// I/O dos arquivos de raiz × upstream (rb-ai-team#39): o que o doctor e o
// upstream-marker.mjs leem do git e do disco. O julgamento é puro e vive em
// root-files-core.mjs; esta cola vive aqui para ser testada de verdade, num repo
// temporário com um remote `upstream` local (root-files-io.test.ts).
//
// SÓ LEITURA e SEM REDE: nada aqui roda `git fetch`, `git remote update` ou
// qualquer comando que fale com o servidor. Só refs que o clone já tem. Quem
// quer a ref fresca roda `git fetch upstream` antes; o doctor só diz isso.
//
// Toda função recebe `runGit(args) => stdout` (lança em status != 0), como o
// overlayFramework do aiteam-sync: o doctor passa o git do repo do consumidor, o
// sync passa o do seu worktree (com os hooks desligados), e o teste passa um repo.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { isLegacy } from "./beads-io.mjs";
import {
  MARKER_PATH,
  ROOT_SOURCES,
  SHIMS,
  UPSTREAM_BRANCHES,
  UPSTREAM_REMOTE,
  parseUpstreamMarker,
  pointsAtFramework,
} from "./root-files-core.mjs";

/**
 * O git de um diretório, no formato que as funções abaixo esperam.
 *
 * GIT_NO_LAZY_FETCH=1 (git >= 2.44; antes ele é ignorado): num clone PARCIAL do upstream (--filter=blob:none, o
 * remote é promisor) o `git show ref:arquivo` de um blob que falta buscaria o blob no remote: rede e packs novos,
 * um fetch que o doctor nunca faz. Com a variável o git falha, o resultado degrada para null e a comparação diz
 * "não comparado" (QA da #39, A2).
 */
export function gitRunner(cwd) {
  const env = { ...process.env, GIT_NO_LAZY_FETCH: "1" };
  return (args) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/** O `git` que falha vira null, em vez de lançar. */
function soft(runGit, args) {
  try {
    return String(runGit(args));
  } catch {
    return null;
  }
}

/** O primeiro remote, em ordem alfabética e que não seja o origin, cujo URL aponta para o rb-ai-team; null se nenhum. */
function frameworkRemoteAlias(runGit) {
  const urls = soft(runGit, ["config", "--get-regexp", "^remote\\..*\\.url$"]);
  if (!urls) return null;
  const names = [];
  for (const line of urls.split(/\r?\n/)) {
    const m = /^remote\.(.+)\.url\s+(.+)$/.exec(line.trim());
    if (m && m[1] !== "origin" && m[1] !== UPSTREAM_REMOTE && pointsAtFramework(m[2])) names.push(m[1]);
  }
  return names.sort()[0] ?? null;
}

/**
 * Qual é a ref do upstream que este clone tem, e de que idade. O remote tem de se chamar `upstream`
 * (o guia de consumo manda); a ref é a `refs/remotes/upstream/HEAD` se existe, senão main, senão master.
 *
 * @param {(args: string[]) => string} runGit
 * @param {{now?: number}} [options] `now` (ms): só os testes o fixam
 * Sem o remote `upstream`: `no-remote`, e com `alias` quando OUTRO remote (nunca o origin) tem o URL do rb-ai-team
 * (o vigacapital chama o seu de `rb-ai-team`), para o doctor sugerir o `git remote rename` (QA da #39, A11).
 *
 * @returns {{state: "no-git"|"no-remote"|"no-ref"|"ok", alias?: string, ref?: string, sha?: string, ageDays?: number|null}}
 */
export function resolveUpstream(runGit, { now = Date.now() } = {}) {
  const remotes = soft(runGit, ["remote"]);
  if (remotes === null) return { state: "no-git" };
  if (!remotes.split(/\r?\n/).some((r) => r.trim() === UPSTREAM_REMOTE)) {
    const alias = frameworkRemoteAlias(runGit);
    return alias ? { state: "no-remote", alias } : { state: "no-remote" };
  }

  const candidates = [];
  const head = soft(runGit, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${UPSTREAM_REMOTE}/HEAD`]);
  if (head && head.trim()) candidates.push(head.trim());
  for (const b of UPSTREAM_BRANCHES) candidates.push(`${UPSTREAM_REMOTE}/${b}`);

  for (const ref of candidates) {
    const sha = soft(runGit, ["rev-parse", "--verify", "--quiet", `refs/remotes/${ref}^{commit}`]);
    if (!sha || !sha.trim()) continue;
    const iso = soft(runGit, ["log", "-1", "--format=%cI", `refs/remotes/${ref}`]);
    const ms = iso ? new Date(iso.trim()).getTime() : Number.NaN;
    return { state: "ok", ref, sha: sha.trim(), ageDays: Number.isFinite(ms) ? Math.max(0, Math.floor((now - ms) / 86_400_000)) : null };
  }
  return { state: "no-ref" };
}

/** O conteúdo de um arquivo numa ref, ou null se a ref não o tem. */
export function showAt(runGit, ref, file) {
  return soft(runGit, ["--literal-pathspecs", "show", `${ref}:${file}`]);
}

/** Lê um arquivo do disco, null se não existe ou não lê. */
function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Quais commits do upstream, entre o último sync (o marcador) e a ref, tocaram os arquivos de raiz.
 *
 * @param {(args: string[]) => string} runGit
 * @param {{marker: ReturnType<typeof parseUpstreamMarker>, ref: string, paths?: readonly string[]}} input
 * @returns {{status: "no-marker"|"malformed"|"unknown-commit"|"same"|"changes",
 *            previous: {commit: string, date: string|null}|null,
 *            current: {commit: string, date: string|null}|null,
 *            entries: Array<{hash: string, date: string, subject: string, files: string[]}>}}
 */
export function measureRootChanges(runGit, { marker, ref, paths = ROOT_SOURCES }) {
  const sha = soft(runGit, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const date = soft(runGit, ["log", "-1", "--format=%cs", ref]);
  const current = sha && sha.trim() ? { commit: sha.trim(), date: date ? date.trim() || null : null } : null;
  const none = { previous: null, current, entries: [] };
  if (marker.state === "absent") return { status: "no-marker", ...none };
  if (marker.state === "malformed") return { status: "malformed", ...none };

  const previous = { commit: marker.commit, date: marker.date };
  // O commit do marcador tem de existir e ser ancestral da ref: senão o `git log <sha>..<ref>` lista o que não
  // veio dele (um fetch pendente, ou histórico reescrito) e a medida mente.
  const full = soft(runGit, ["rev-parse", "--verify", "--quiet", `${marker.commit}^{commit}`]);
  if (!full || !full.trim() || soft(runGit, ["merge-base", "--is-ancestor", full.trim(), ref]) === null) {
    return { status: "unknown-commit", previous, current, entries: [] };
  }
  if (current && full.trim() === current.commit) return { status: "same", previous, current, entries: [] };

  const log = soft(runGit, [
    "--literal-pathspecs",
    "log",
    // --no-merges: um commit de merge que toca a raiz sai sem arquivo nenhum (o --name-only não lista os de um merge),
    // uma linha vazia que ainda inflava a contagem. O que ele trouxe já está nos commits dos ramos (QA da #39, A8).
    "--no-merges",
    "--format=>%h %cs %s",
    "--name-only",
    `${full.trim()}..${ref}`,
    "--",
    ...paths,
  ]);
  const entries = [];
  for (const line of String(log ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith(">")) {
      const m = /^>(\S+) (\S+) (.*)$/.exec(line);
      if (m) entries.push({ hash: m[1], date: m[2], subject: m[3], files: [] });
    } else if (entries.length > 0) {
      entries[entries.length - 1].files.push(line.trim());
    }
  }
  return { status: "changes", previous, current, entries };
}

/** O marcador gravado no repo (aiteam/UPSTREAM), lido do disco. */
export function readMarker(root) {
  return parseUpstreamMarker(readText(path.join(root, ...MARKER_PATH.split("/"))));
}

/**
 * Os fatos que checkRootFilesUpstream (root-files-core.mjs) julga. Nunca lança: o que o git ou o disco
 * não deram vira null, e o julgamento diz "não comparado".
 *
 * @param {string} root raiz do repo
 * @param {{yamlLoad?: ((text: string) => unknown)|null, runGit?: (args: string[]) => string, now?: number}} [options]
 *   `yamlLoad`: o `load` do js-yaml, quando o doctor o tem (sem ele o ci.yml não é comparado)
 */
export function readRootFilesFacts(root, { yamlLoad = null, runGit = gitRunner(root), now } = {}) {
  const upstream = resolveUpstream(runGit, now === undefined ? {} : { now });
  const facts = {
    upstream,
    marker: readMarker(root),
    since: null,
    legacy: false,
    local: {},
    remote: {},
    template: null,
    workflows: null,
    workflowsUnavailable: null,
  };
  if (upstream.state !== "ok") return facts;
  const ref = upstream.ref;

  facts.since = measureRootChanges(runGit, { marker: facts.marker, ref });
  // Modo legado (o active.yaml do modelo antigo ainda rastreado): ali o .beads/SCHEMA.md local é o contrato em vigor
  // até migrar, e o apontador do upstream manda escrever onde o pre-commit recusa. A decisão é a dos hooks (beads-io.mjs).
  try {
    facts.legacy = isLegacy(root);
  } catch {
    facts.legacy = false;
  }

  const files = [".beads/SCHEMA.md", ".gitattributes", ...SHIMS.map((s) => s.file)];
  for (const file of files) {
    facts.local[file] = readText(path.join(root, ...file.split("/")));
    facts.remote[file] = showAt(runGit, ref, file);
  }

  const parse = (text) => {
    try {
      return { doc: yamlLoad(text) };
    } catch (e) {
      return { error: String(e?.reason ?? e?.message ?? e) };
    }
  };
  if (!yamlLoad) {
    facts.workflowsUnavailable = "js-yaml indisponível (aiteam/node_modules ausente) — rode: cd aiteam && npm install";
    return facts;
  }
  const templateText = showAt(runGit, ref, "aiteam/templates/ci.yml.example");
  facts.template = templateText === null ? null : parse(templateText);
  const dir = path.join(root, ".github", "workflows");
  let names = [];
  try {
    names = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)) : [];
  } catch {
    names = [];
  }
  facts.workflows = names.map((file) => ({ file, ...parse(readText(path.join(dir, file)) ?? "") }));
  return facts;
}
