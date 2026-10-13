// What counts as an EDIT OF THE GATE, and how to tell. Pure: no I/O, no node:* modules (the callers
// pass the reader and the repo-root test), and the only imports are the two pure modules the guard
// already loads (frontmatter.mjs, tier-core.mjs) — the hooks load this in plain node, without
// node_modules.
//
// F13. The tier-guard gates what an agent RUNS, but three files decide what the gate is, and the
// agent could rewrite them: `SPEC.md` (`tier_defaults` / `allow_tier3`, the break-glass),
// `.claude/tier-rules.json` (the Tier-3 pattern map) and `.claude/settings.json` (the hooks and
// permissions the gate runs on) — and with them `.claude/settings.local.json` and the MCP server lists
// (`.mcp.json`, `.cursor/mcp.json`): a server added there is an arbitrary command the NEXT session
// starts. The PO's decision: ask for a human's confirmation on every edit of them — by a
// Write/Edit/MultiEdit/NotebookEdit tool call (aiteam/hooks/gate-edit-guard.mjs) and by a shell command
// that writes to them (the tier-guard, through gateWriteInCommand). The ASK is the approval; there is
// no second gate.
//
// What is NOT the gate, so it never asks: an edit of SPEC.md that leaves `tier_defaults` and
// `allow_tier3` alone (the Overview, the roadmap...), an edit of `.claude/settings.json` that touches
// only a key of the short HARMLESS list below (`worktree`, `model`, `theme`...), the template copy
// aiteam/templates/tier-rules.json (it only backs the fallback), and the vendored code itself.
//
// The settings.json rule is an ALLOWLIST of harmless keys, not a list of dangerous ones: the file
// has keys that run a command (`statusLine`, `apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`,
// `otelHeadersHelper`, `fileSuggestion`), that start MCP servers (`enableAllProjectMcpServers`,
// `enabledMcpjsonServers`), that switch hooks off (`disableAllHooks`) or load code into the hook's
// process (`env`), and Claude Code adds more over time. A deny-list misses the next one on the day it
// ships; an allowlist makes the unknown key ask.
//
// Honest scope, as for the classifier: this catches the accidental and the obvious. A shell command
// that writes the file through an obfuscated path or an interpreter's indirection is not seen, and a
// `sed -i` over SPEC.md that does not NAME the gate keys is not asked (the script is the command text;
// a generic substitution says nothing about which line it hits). A guardrail, not a sandbox.

import { extractFrontmatter } from "./frontmatter.mjs";
import { readAllowTier3 } from "./tier-core.mjs";

/**
 * The top-level keys of `.claude/settings.json` that may change without asking: the ones that cannot run
 * code, start a server, move a permission or switch a hook off. Short on purpose — a key that is not here
 * asks, so the list can only be wrong by asking too much. `worktree` (baseRef, which directories to link),
 * `model`, `theme` and `language` (what the session looks like), `cleanupPeriodDays` (how long transcripts
 * are kept) and the editor's `$schema`.
 */
export const SETTINGS_HARMLESS_KEYS = Object.freeze(["$schema", "model", "theme", "language", "cleanupPeriodDays", "worktree"]);

// ---- paths --------------------------------------------------------------------------------------

// Forward slashes, no `.` and no `..` segments, no doubled separators. Case is kept (callers compare
// lowercased, so a case-insensitive file system cannot dodge the match).
function normalizePath(p) {
  let s = String(p ?? "").trim().replace(/\\/g, "/");
  s = s.replace(/^\/\/\?\//, ""); // the \\?\ prefix of a long Windows path
  s = s.replace(/^\/([A-Za-z])(?=\/|$)/, "$1:"); // /c/repo (Git Bash) is C:/repo
  const prefix = /^[A-Za-z]:/.test(s) ? s.slice(0, 2) : "";
  const absolute = s.slice(prefix.length).startsWith("/");
  const out = [];
  for (const part of s.slice(prefix.length).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(part);
  }
  return `${prefix}${absolute ? "/" : ""}${out.join("/")}`;
}

function isAbsolute(p) {
  return /^([A-Za-z]:)?[\\/]/.test(p) || p.startsWith("\\\\");
}

function resolvePath(p, cwd) {
  const raw = String(p ?? "").trim();
  if (raw === "") return "";
  return normalizePath(isAbsolute(raw) ? raw : `${cwd || "."}/${raw}`);
}

const dirnameOf = (p) => p.slice(0, Math.max(0, p.lastIndexOf("/")));

/**
 * Which gate file a path is, or null. `.claude/tier-rules.json`, `.claude/settings.json`,
 * `.claude/settings.local.json`, `.mcp.json` and `.cursor/mcp.json` are gate wherever they live (a repo, a
 * worktree under it, the user's ~/.claude). `SPEC.md` is the gate only at the root of a repo: the
 * directory of `cwd`, or one the caller says is a framework root (it has `.claude/` or `aiteam/`: a
 * worktree, another checkout) — a `docs/SPEC.md` is just a document.
 *
 * @param {string} filePath as the tool or the command gave it (relative to `cwd` or absolute)
 * @param {{cwd?: string, isFrameworkRoot?: (dir: string) => boolean}} [options]
 * @returns {"spec"|"tier-rules"|"settings"|"mcp"|null}
 */
export function gateFileKind(filePath, { cwd = "", root = cwd, isFrameworkRoot = () => false, guardCode = () => false } = {}) {
  const full = resolvePath(filePath, cwd);
  if (full === "") return null;
  const lower = full.toLowerCase();
  if (/(^|\/)\.claude\/tier-rules\.json$/.test(lower)) return "tier-rules";
  if (/(^|\/)\.claude\/settings(\.local)?\.json$/.test(lower)) return "settings";
  if (/(^|\/)\.mcp\.json$/.test(lower) || /(^|\/)\.cursor\/mcp\.json$/.test(lower)) return "mcp";
  // The gate's own code, in a CONSUMER (the caller says which paths: guardCodeMatcher). Rewriting it
  // switches the gate off without touching any file above.
  try {
    if (guardCode(full)) return "guard-code";
  } catch {
    // a matcher that throws matches nothing
  }
  if (/(^|\/)spec\.md$/.test(lower)) {
    const dir = dirnameOf(full);
    if (dir === "" || dir.toLowerCase() === normalizePath(root).toLowerCase()) return "spec";
    let framework = false;
    try {
      framework = Boolean(isFrameworkRoot(dir));
    } catch {
      framework = false;
    }
    return framework ? "spec" : null;
  }
  return null;
}

// ---- SPEC.md ------------------------------------------------------------------------------------

const BOM = /^\uFEFF/;
const lf = (text) => String(text ?? "").replace(BOM, "").replace(/\r\n?/g, "\n");

/**
 * The text of SPEC.md that IS the gate: the column-0 `tier_defaults:` block of the frontmatter (the
 * header and every blank, comment or indented line after it) and any other frontmatter line that
 * mentions `allow_tier3`. The body of the document is not part of it — prose may quote the flag.
 * "" when there is no frontmatter or nothing of the gate in it.
 */
export function specGateRegion(specText) {
  const fm = extractFrontmatter(specText);
  if (fm === null) return "";
  const lines = fm.split("\n");
  const region = [];
  let inBlock = false;
  for (const line of lines) {
    const blankOrComment = /^[ \t]*(?:#.*)?$/.test(line);
    const indented = /^[ \t]/.test(line);
    if (!blankOrComment && !indented) inBlock = /^tier_defaults[ \t]*:/.test(line);
    if (inBlock || /allow_tier3/i.test(line)) region.push(line);
  }
  return region.join("\n").replace(/\s+$/, "");
}

/**
 * Does going from `before` to `after` touch the gate of SPEC.md? Yes when the gate region differs (any
 * direction: turning the flag off is an edit of the gate too) or when what the guard reads from it
 * changes (a quote opened above the block can switch the reading without touching its text).
 */
export function touchesSpecGate(before, after) {
  if (specGateRegion(before) !== specGateRegion(after)) return true;
  return readAllowTier3(before).allowed !== readAllowTier3(after).allowed;
}

// ---- .claude/settings.json ----------------------------------------------------------------------

// A stable text for a JSON value: object keys sorted, so a reformat or a reorder is not a change.
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The gate part of a settings.json text as a stable string, or null when the text is not a JSON object:
 * EVERY top-level key except the ones in SETTINGS_HARMLESS_KEYS. An empty or missing file is `{}`.
 */
export function settingsGateRegion(text) {
  const source = lf(text);
  if (source.trim() === "") return stable({});
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  // A null-prototype object: the keys are the file's text, and `gate["__proto__"] = x` on a plain object sets the
  // prototype instead of creating the key (which then dropped out of the region, so adding it asked for nothing).
  const gate = Object.create(null);
  for (const key of Object.keys(parsed)) if (!SETTINGS_HARMLESS_KEYS.includes(key)) gate[key] = parsed[key];
  return stable(gate);
}

// ---- applying an edit ---------------------------------------------------------------------------

/**
 * The text after the edits of an Edit or MultiEdit tool call, applied in order the way the tool applies
 * them (the first occurrence, or all of them with replace_all), or null when an edit cannot be applied
 * (the old string is not there, or is empty): the tool will then refuse it, or the caller falls back to
 * the words of the edit. Line breaks are compared as LF.
 *
 * @param {string} text
 * @param {Array<{old_string?: unknown, new_string?: unknown, replace_all?: unknown}>} edits
 * @returns {string|null}
 */
export function applyEdits(text, edits) {
  let current = lf(text);
  for (const edit of Array.isArray(edits) ? edits : []) {
    const from = typeof edit?.old_string === "string" ? lf(edit.old_string) : "";
    const to = typeof edit?.new_string === "string" ? lf(edit.new_string) : "";
    if (from === "" || !current.includes(from)) return null;
    current = edit.replace_all === true ? current.split(from).join(to) : current.replace(from, () => to);
  }
  return current;
}

// ---- a tool call that edits a file --------------------------------------------------------------

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

const WHY = {
  spec: "it changes tier_defaults / allow_tier3 in SPEC.md, the break-glass of the Tier-3 gate",
  "tier-rules": "it edits .claude/tier-rules.json, the Tier-3 pattern map the gate classifies with",
  settings:
    "it changes .claude/settings.json beyond a harmless setting: hooks, permissions, env, helper commands (statusLine, apiKeyHelper...) and MCP switches run or loosen what the gate runs on",
  mcp: "it edits an MCP server list (.mcp.json, .cursor/mcp.json): a server added there is an arbitrary command the next session starts",
  "guard-code": "it edits the gate's own code (aiteam/hooks, the modules they import, the canonical tier-rules template): rewriting it switches the gate off",
};

/**
 * Does this tool call edit the gate? `null` when it does not (another tool, another file, an edit that
 * leaves the gate part of the file alone), else `{kind, file, why}`. The caller turns it into an ASK.
 *
 * @param {{tool: string, input: object, read: (file: string) => string|null, cwd?: string,
 *          isFrameworkRoot?: (dir: string) => boolean}} call
 *   `read` returns the current text of a file, or null when it does not exist.
 * @returns {{kind: "spec"|"tier-rules"|"settings", file: string, why: string}|null}
 */
export function gateEditVerdict({ tool, input, read, cwd = "", isFrameworkRoot, guardCode }) {
  if (!EDIT_TOOLS.has(tool) || input === null || typeof input !== "object") return null;
  const file = input.file_path ?? input.notebook_path;
  if (typeof file !== "string" || file === "") return null;
  const kind = gateFileKind(file, { cwd, isFrameworkRoot, guardCode });
  if (kind === null) return null;
  const hit = (why = WHY[kind]) => ({ kind, file, why });

  // The map, the MCP lists and the gate's own code: any edit of them asks. (An edit that changes nothing is
  // not worth a second code path.)
  if (kind === "tier-rules" || kind === "mcp" || kind === "guard-code") return hit();

  let before = null;
  try {
    before = read(file);
  } catch {
    before = null;
  }
  const beforeText = before ?? "";

  // The text after the call, when it can be known.
  let after = null;
  if (tool === "Write") after = typeof input.content === "string" ? lf(input.content) : null;
  else if (tool === "Edit") after = applyEdits(beforeText, [input]);
  else if (tool === "MultiEdit") after = applyEdits(beforeText, input.edits);
  else return hit(); // NotebookEdit on a gate file: not a notebook, not something to guess about

  if (kind === "spec") {
    if (after !== null) return touchesSpecGate(beforeText, after) ? hit() : null;
    // An edit this guard cannot apply: either the tool will refuse it, or the tool applies it by rules this guard does
    // not have — Edit matches curly quotes “ ” ‘ ’ with the straight ones of the file, so `false  # “x”` → `true  # “x”`
    // flips the break-glass without ever naming the key. What the edit WOULD do cannot be told, so it asks (the words
    // of the edit are no help: the one that matters is the value). Same as settings.json below.
    return hit("it edits SPEC.md in a way this guard cannot check (the old text is not found as written — the Edit tool also matches curly quotes with straight ones), and SPEC.md holds the break-glass of the Tier-3 gate");
  }

  // settings.json
  if (after === null) return hit("it edits .claude/settings.json in a way this guard cannot check, and the hooks and permissions the gate runs on live there");
  const was = settingsGateRegion(beforeText);
  const will = settingsGateRegion(after);
  if (was === null || will === null) {
    return hit("it leaves .claude/settings.json in a state this guard cannot parse, and the hooks and permissions the gate runs on live there");
  }
  return was === will ? null : hit();
}

/** The message of the ASK for a tool call: what it edits and why that needs a human. */
export function gateEditReason(verdict) {
  return (
    `Gate file edit — one-shot human approval required: ${verdict.file} (${verdict.why}). ` +
    `Approve in chat to apply it once; headless sessions fail closed.`
  );
}

// ---- the gate's own code, in a consumer -----------------------------------------------------------

// The relative imports of a module's source: the static `from` form, a bare `import`, and the dynamic call.
function relativeImportsOf(source) {
  const specs = [];
  for (const m of String(source ?? "").matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["'](\.{1,2}\/[^"']+)["']/gm)) specs.push(m[1]);
  for (const m of String(source ?? "").matchAll(/^\s*import\s+["'](\.{1,2}\/[^"']+)["']/gm)) specs.push(m[1]);
  for (const m of String(source ?? "").matchAll(/\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) specs.push(m[1]);
  return specs;
}

/**
 * Which paths are the GATE'S OWN CODE: the hooks (`aiteam/hooks/*.mjs`), the modules of `aiteam/src` that
 * those hooks import — the closure of their imports, read from the sources, so a module the hooks start
 * to import tomorrow is covered the day it does — and the canonical template
 * `aiteam/templates/tier-rules.json`. Rewriting any of them switches the gate off without touching the
 * files that are the gate by name: the agent edits `tier-core.mjs` so that `guardDecision` returns allow.
 *
 * Only in a CONSUMER (the PO's decision): in the upstream (rb-ai-team) the guard is DEVELOPED, and the
 * background subagents that develop it cannot answer an ASK. A consumer's copy of aiteam/ is vendored:
 * nobody edits it there, so an edit is worth a human's click.
 *
 * Which of the two this is does NOT come from a file the agent can create. A marker file (the manifest of
 * tools/aiteam-sync, say) would let an agent in a consumer write it and switch the ASK off. The caller passes
 * `upstream`, read from the `AITEAM_UPSTREAM=1` environment variable that only the upstream's own
 * `.claude/settings.json` (`env`) sets — a file that is itself a gate (an edit of its `env` asks), and that
 * the install never writes into a consumer.
 *
 * @param {string} root the repo root the hook runs in
 * @param {{exists: (p: string) => boolean, read: (p: string) => string|null, list: (dir: string) => string[]}} fsOps
 *   synchronous file system access, injected (this module does no I/O)
 * @param {{upstream?: boolean}} [options] `upstream`: this session develops the framework — nothing is the
 *   gate's own code then
 * @returns {(path: string) => boolean} true for a resolved path that is the gate's own code in a consumer
 */
export function guardCodeMatcher(root, fsOps, { upstream = false } = {}) {
  if (upstream === true) return Object.assign(() => false, { isGuardDirectory: () => false });
  const cache = new Map(); // repo root (lowercase) -> Set of paths relative to aiteam/
  const closureOf = (repo) => {
    const key = repo.toLowerCase();
    if (cache.has(key)) return cache.get(key);
    let result;
    try {
      const seen = new Set();
      const queue = [];
      for (const name of fsOps.list(`${repo}/aiteam/hooks`)) if (name.endsWith(".mjs")) queue.push(`hooks/${name}`);
      while (queue.length > 0) {
        const rel = queue.pop();
        if (seen.has(rel.toLowerCase())) continue;
        seen.add(rel.toLowerCase());
        const source = fsOps.read(`${repo}/aiteam/${rel}`);
        if (source === null) continue;
        for (const spec of relativeImportsOf(source)) {
          const next = normalizePath(`${dirnameOf(`/${rel}`)}/${spec}`).replace(/^\//, "");
          if (!next.startsWith("..") && !seen.has(next.toLowerCase())) queue.push(next);
        }
      }
      result = seen;
    } catch {
      result = new Set(); // unreadable: the hooks directory itself still matches below
    }
    cache.set(key, result);
    return result;
  };
  closureOf(normalizePath(root));
  const matcher = (full) => {
    const path = normalizePath(full);
    const at = path.toLowerCase().lastIndexOf("/aiteam/");
    if (at < 0) return false;
    const repo = path.slice(0, at);
    const rel = path.slice(at + "/aiteam/".length).toLowerCase();
    const closure = closureOf(repo);
    if (rel.startsWith("hooks/") && rel.endsWith(".mjs") && rel.split("/").length === 2) return true;
    if (rel === "templates/tier-rules.json") return true;
    return closure.has(rel);
  };
  // The DIRECTORIES that hold that code: `aiteam`, `aiteam/hooks` and `aiteam/src`. Deleting or moving one of them takes
  // the gate away without naming a file of it, so a delete or a move that names one asks. Not part of the file matcher:
  // writing a file into the directory is a different question.
  matcher.isGuardDirectory = (full) => /(^|\/)aiteam(\/(?:hooks|src))?$/.test(normalizePath(full).toLowerCase());
  return matcher;
}

// ---- a shell command that writes to a gate file -------------------------------------------------

// A small lexer: words, with the quoting taken off, and the redirection operators as words of their own
// (only outside quotes). Enough to tell `> file` from a `>` inside a string, which the sub-command
// splitter of tier-core leaves in place. `<` (a patch read from a file) is a word of its own too, unless
// it opens a heredoc or a process substitution.
function lex(sub) {
  const tokens = [];
  let cur = "";
  let started = false;
  let quote = null;
  const push = () => {
    if (started) tokens.push(cur);
    cur = "";
    started = false;
  };
  for (let i = 0; i < sub.length; i++) {
    const c = sub[i];
    if (quote) {
      if (c === quote) quote = null;
      // A backslash is a path separator on Windows (`.claude\tier-rules.json`): it only escapes the quote.
      else if (c === "\\" && quote === '"' && sub[i + 1] === '"') cur += sub[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      push();
      continue;
    }
    // `>`, `>>`, `>|`, `&>`, `2>`: a token of its own, with the file descriptor attached.
    if (c === ">") {
      const fd = /^(?:\d+|&)$/.test(cur) ? cur : null;
      if (fd !== null) {
        cur = "";
        started = false;
      } else {
        push();
      }
      let op = ">";
      if (sub[i + 1] === ">") {
        op = ">>";
        i++;
      } else if (sub[i + 1] === "|") {
        i++;
      }
      tokens.push(`${fd ?? ""}${op}`);
      continue;
    }
    if (c === "<" && sub[i + 1] !== "<" && sub[i + 1] !== "(" && sub[i - 1] !== "<") {
      push();
      tokens.push("<");
      continue;
    }
    cur += c;
    started = true;
  }
  push();
  return tokens;
}

const OUT_REDIRECT = /^(?:\d+|&)?>>?$/;
const IN_REDIRECT = /^<$/;
const isRedirect = (t) => OUT_REDIRECT.test(t) || IN_REDIRECT.test(t);

// The grammar of the shell that stands in front of a command inside a compound one. The sub-command splitter cuts at `;`,
// `&&`, `||` and the like, so what is left starts with it: `then sed -i ...`, `do rm x`, `else cp a b`, `{ rm x`, `(sed -i
// ...)`, `! cmd`, `f() { cmd`, `function f { cmd`, `case x in x) cmd`. The program is the word after it, and the closing `)` of
// a subshell is the last character of the last argument, so it comes off too.
const CONTROL_WORD = /^(?:if|then|else|elif|while|until|do|!|\{)(?=\s|$)/;
const FUNCTION_HEAD = /^(?:function\s+[\w.:+-]+(?:\s*\(\))?|[\w.:+-]+\s*\(\))/;
const CASE_HEAD = /^case\s+\S+\s+in(?=\s|$)/;
const CASE_LABEL = /^\(?[^\s()'"`$]+\)(?=\s|$)/;
// Returns null when there are more than 32 of them in a row: the guard does not follow that far, and a command it cannot
// follow asks (scanSub).
function unwrapControl(sub) {
  let s = sub.trimStart();
  let opened = 0;
  for (let n = 0; ; n++) {
    const m = CONTROL_WORD.exec(s) ?? CASE_HEAD.exec(s) ?? FUNCTION_HEAD.exec(s) ?? CASE_LABEL.exec(s);
    if (m) s = s.slice(m[0].length).trimStart();
    else if (s.startsWith("(")) {
      s = s.slice(1).trimStart();
      opened++;
    } else break;
    if (n >= 32) return null;
  }
  for (let k = 0; k < opened; k++) s = s.replace(/\s*\)\s*$/, "");
  return s;
}

// Words that put another word in front of the program: `sudo rm x`, `env A=1 sed ...`.
const WRAPPERS = new Set(["sudo", "env", "command", "nohup", "time", "exec", "doas", "builtin", "xargs"]);

function programOf(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || WRAPPERS.has(t.toLowerCase()) || (t.startsWith("-") && i > 0)) {
      i++;
      continue;
    }
    break;
  }
  return { name: (tokens[i] ?? "").toLowerCase().replace(/^.*[\\/]/, "").replace(/\.exe$/, ""), args: tokens.slice(i + 1) };
}

// The programs by what they do to a file named in their arguments.
const CP_LIKE = new Set(["cp", "mv", "install", "rsync", "copy", "move", "ren", "rename", "copy-item", "move-item", "rename-item", "cpi", "mi", "xcopy", "ditto"]);
const MOVES = new Set(["mv", "move", "ren", "rename", "move-item", "rename-item", "mi"]);
const LINKS = new Set(["ln", "mklink"]);
const OVERWRITE = new Set(["tee", "set-content", "sc", "out-file", "clear-content", "clc", "new-item", "ni", "set-item", "si", "dd", "truncate", "shred"]);
const APPEND = new Set(["add-content", "ac"]);
const DELETE = new Set(["rm", "del", "erase", "rd", "rmdir", "remove-item", "ri", "unlink", "trash"]);
const INPLACE = new Set(["sed", "gsed", "perl", "awk", "gawk", "ruby", "ed", "ex"]);
const INTERPRETERS = new Set(["node", "nodejs", "python", "python3", "py", "ruby", "perl", "php", "deno", "bun", "lua", "tclsh"]);
const SHELLS = new Set(["bash", "sh", "zsh", "ksh", "dash", "fish", "powershell", "pwsh", "cmd"]);

// What a gate keyword in the command text means for SPEC.md: the guard keys.
const SPEC_KEYS = /allow_tier3|tier_defaults/i;
// A file-writing API in an interpreter's inline code (`open(path)` alone reads: only a write mode counts).
const WRITE_API = /write|append|copy|rename|unlink|remove|\brm\b|truncate|open\([^)]*,\s*['"][^'"]*[wax+]|\bsed\b|>>?\s*['"`]/i;
const GATE_NAMES = /SPEC\.md|tier-rules\.json|settings(?:\.local)?\.json|\.mcp\.json|mcp\.json/i;
// What a copy into a repo root can carry: a gate file by name, or a whole `.claude`/`.cursor` directory.
const GATE_BASENAME = /^(?:SPEC\.md|tier-rules\.json|settings(?:\.local)?\.json|\.mcp\.json|mcp\.json|\.claude|\.cursor)$/i;
// The in-place flag of sed, perl, ruby and awk: `-i`, `-i.bak`, a cluster that holds an `i` (`-Ei`, `-pi`, `-0pi`,
// `-lpi`), `--in-place[=SUFFIX]` and gawk's `-i inplace`. perl's `-M`/`-m` load a module (`-MList::Util` has an `i`
// and writes nothing), so a word that starts with them is not a cluster.
const inplaceFlag = (args) =>
  args.some((a) => (/^-[A-Za-z0-9]*i/.test(a) && !/^-[Mm]/.test(a)) || /^--in-?place/i.test(a) || a.toLowerCase() === "inplace");

function bareTarget(word) {
  // `-Path:.claude/x`, `of=.claude/x`, `-Destination=...`
  return word.replace(/^-{1,2}[A-Za-z]+[:=]/, "").replace(/^of=/i, "");
}

const basenameOf = (p) => p.slice(p.lastIndexOf("/") + 1);

// `cd`-like commands: what they do to the directory the next commands run in.
const CD = new Set(["cd", "chdir", "pushd", "popd", "set-location", "sl", "push-location", "pushd", "pop-location", "popd"]);

// Follow a `cd`: the paths of the sub-commands after it resolve against the new directory. A `cd` to somewhere
// this module cannot resolve (`cd -`, `cd "$X"`, a glob, `~`, a `popd`) marks the directory unknown.
function followCd(name, words, ctx) {
  ctx.cwdChanged = true;
  const target = words.find((w) => !w.startsWith("-") || /^-(?:path|literalpath)[:=]/i.test(w));
  const dest = target === undefined ? "" : bareTarget(target);
  if (name === "popd" || name === "pop-location" || dest === "" || dest === "-" || /[$`*?[~(]/.test(dest)) {
    ctx.cwdUnknown = true;
    return;
  }
  ctx.cwd = resolvePath(dest, ctx.cwd);
}

// Remember what a sub-command writes, so a later `git apply` of a file the same command created is not read
// ahead of time.
function recordWrites(name, words, tokens, ctx) {
  const mark = (word) => {
    const resolved = resolvePath(bareTarget(word), ctx.cwd).toLowerCase();
    if (resolved !== "") ctx.written.add(resolved);
  };
  for (let i = 0; i < tokens.length - 1; i++) if (OUT_REDIRECT.test(tokens[i])) mark(tokens[i + 1]);
  const nonOptions = words.filter((w) => !w.startsWith("-"));
  if (CP_LIKE.has(name) || LINKS.has(name)) {
    if (nonOptions.length > 0) mark(nonOptions[nonOptions.length - 1]);
  } else if (OVERWRITE.has(name) || APPEND.has(name)) {
    if (name === "dd") {
      for (const w of words) if (/^of=/i.test(w)) mark(w);
    } else for (const w of nonOptions) mark(w);
  } else if (INPLACE.has(name) && inplaceFlag(words)) {
    for (const w of nonOptions) mark(w); // `sed -i … patch.diff` rewrites the patch before it is applied
  }
}

/**
 * The first sub-command of `command` that writes to a gate file, or null. `split` is tier-core's
 * splitSubCommands (heredoc bodies are data there, so a runbook that quotes `sed -i … settings.json` in a
 * `cat > doc.md <<'EOF'` is not a write). Returns `{sub, kind, file, why}`.
 *
 * A write is: a redirection (`>`, `>>`, `2>`) into the file; `tee`, `cp`, `mv`, `install`, `dd of=`,
 * `truncate` and the PowerShell `Set-Content`, `Out-File`, `Copy-Item`, `Move-Item`... over it; `sed -i`,
 * `perl -i`, `awk -i inplace`; `rm`, `del`, `Remove-Item`; an inline `node -e`/`python -c` whose code names
 * the file and a write API; the code of a `bash -c`/`powershell -Command`, read the same way; and the ways
 * AROUND the file name:
 *  - a copy or move INTO a directory that is `.claude`/`.cursor`, or into a repo root (a framework root)
 *    when what it carries is a gate file or a `.claude` directory (`cp x.json .claude/`);
 *  - a move or delete of the `.claude`/`.cursor` directory itself;
 *  - a link (`ln`, `mklink`, `New-Item -ItemType SymbolicLink`) that names a gate file — the link is a second
 *    door to it, and the SOURCE counts as much as the destination;
 *  - `git checkout`/`git restore` that name a gate file, or reach every file from a given source (`git
 *    checkout <ref> -- .`), `git apply` and `patch` whose patch touches one (the patch file is read, and a
 *    patch that cannot be read asks), and `git stash pop|apply`, which may bring a stashed gate back;
 *  - a path that is a symlink or junction to a gate file, when the caller can resolve it (`realpath`).
 *
 * For every gate file but SPEC.md every such write asks. For SPEC.md only the ones that overwrite or delete
 * it, run inline code on it, or NAME `allow_tier3` / `tier_defaults` do: an append (`>>`, `Add-Content`) or an
 * in-place `sed` that never says which line it hits is not the gate by itself.
 *
 * @param {string} command
 * @param {{split: (command: string) => string[], cwd?: string, isFrameworkRoot?: (dir: string) => boolean,
 *          realpath?: (p: string) => string|null, read?: (p: string) => string|null}} options
 *   `realpath` resolves a path through symlinks and junctions (null when it does not exist); `read` returns
 *   the text of a file (a patch), or null when it cannot be read.
 */
export function gateWriteInCommand(command, { split, cwd = "", isFrameworkRoot, realpath, read, guardCode } = {}) {
  const whole = String(command ?? "");
  // `cwd` moves with the `cd`s of the command; `written` holds the paths an earlier sub-command writes
  // (a patch the same command creates cannot be read ahead of time); `cwdUnknown` is a `cd` to somewhere
  // this module cannot resolve (`cd -`, `cd "$X"`).
  const ctx = { split, cwd, root: cwd, isFrameworkRoot, realpath, read, guardCode, whole, written: new Set(), cwdUnknown: false, cwdChanged: false };
  // `>|` (override noclobber) holds a `|` the sub-command splitter cuts at: look at the raw text for it.
  for (const m of whole.matchAll(/\d?>\|\s*(["']?)([^\s"'|;&<>()]+)\1/g)) {
    const kind = kindOfPath(m[2], ctx);
    if (kind) return { sub: whole.trim(), kind, file: m[2], why: WHY[kind] };
  }
  return scan(whole, ctx, 0);
}

// The gate kind of a word as the command gave it, and — when the caller can resolve it — of the file it
// really is: a symlink or junction named `notes.md` that points to SPEC.md is SPEC.md.
function kindOfPath(word, ctx) {
  const given = bareTarget(word);
  const options = { cwd: ctx.cwd, root: ctx.root ?? ctx.cwd, isFrameworkRoot: ctx.isFrameworkRoot, guardCode: ctx.guardCode };
  const direct = gateFileKind(given, options);
  if (direct) return direct;
  // After a `cd` this module cannot follow, a bare gate file name (`tier-rules.json`) may be the gate's.
  if (ctx.cwdUnknown) {
    const base = basenameOf(normalizePath(given)).toLowerCase();
    if (base === "tier-rules.json") return "tier-rules";
    if (/^settings(\.local)?\.json$/.test(base)) return "settings";
    if (base === ".mcp.json") return "mcp";
    if (base === "spec.md") return "spec";
  }
  if (typeof ctx.realpath !== "function" || !/[./\\]/.test(given)) return null;
  let real = null;
  try {
    real = ctx.realpath(given);
  } catch {
    real = null;
  }
  return typeof real === "string" && real !== "" ? gateFileKind(real, options) : null;
}

// Where a path really is, for the checks about directories: the path as written, and through links.
function pathsOf(word, ctx) {
  const given = resolvePath(bareTarget(word), ctx.cwd);
  const paths = given === "" ? [] : [given];
  if (typeof ctx.realpath === "function" && !bareTarget(word).startsWith("-")) {
    try {
      const real = ctx.realpath(bareTarget(word));
      if (typeof real === "string" && real !== "") paths.push(normalizePath(real));
    } catch {
      // the path does not resolve
    }
  }
  return paths;
}

// Does the directory this path names expose the gate through a link, a copy or a move? The `.claude` or
// `.cursor` directory (or anything inside them), a repo root (the directory of SPEC.md: a framework root), or
// an ANCESTOR of the repo root (a link to `..` reaches every file of the repo through the link).
function exposesGateDirectory(word, ctx) {
  const root = normalizePath(ctx.root ?? ctx.cwd).toLowerCase();
  for (const p of pathsOf(word, ctx)) {
    const lower = p.toLowerCase();
    if (/(^|\/)\.(?:claude|cursor)(\/|$)/.test(lower)) return true;
    const base = lower.replace(/\/$/, ""); // `/` and `c:/` are the ancestors of everything under them
    if (root !== "" && (root === base || root.startsWith(`${base}/`))) return true;
    try {
      if (ctx.isFrameworkRoot?.(p)) return true;
    } catch {
      // not a framework root
    }
  }
  return false;
}

function scan(command, ctx, depth) {
  // A command nested deeper than this (a shell inside a shell inside an eval...) is not followed, and what is not followed
  // asks: it is never "nothing to see here".
  if (depth > 3) return { sub: String(command), kind: "settings", file: "(nested command)", why: "it nests shells, eval or rebase --exec more than 3 levels deep, which is too deep for this guard to follow: it asks" };
  let subs;
  try {
    subs = ctx.split(command);
  } catch {
    subs = [command];
  }
  for (const sub of subs) {
    const hit = scanSub(sub, ctx, depth);
    if (hit) return hit;
  }
  return null;
}

function scanSub(sub, ctx, depth) {
  const unwrapped = unwrapControl(sub);
  if (unwrapped === null) return { sub, kind: "settings", file: "(control words)", why: "it has more than 32 control words or groupings (if, then, do, {, (...) in front of the command, which this guard does not follow: it asks" };
  const tokens = lex(unwrapped);
  if (tokens.length === 0) return null;
  const kindOf = (word) => kindOfPath(word, ctx);
  const hit = (kind, file, why = WHY[kind]) => ({ sub, kind, file, why });
  // A word that is the `.claude` or `.cursor` directory itself (where the gate's settings, map and hooks live).
  const gateDirWord = (word) => /^(?:\.claude|\.cursor)$/i.test(basenameOf(resolvePath(bareTarget(word), ctx.cwd)));
  const DIR_WHY = "it moves, deletes or copies into the .claude/ (or .cursor/) directory, where settings.json, tier-rules.json and the hooks live";
  // A word that is a directory holding the gate's own code in a consumer (aiteam, aiteam/hooks, aiteam/src), as written
  // or through a link: deleting or moving it switches the gate off without naming a file.
  const isGuardDirectory = typeof ctx.guardCode === "function" ? ctx.guardCode.isGuardDirectory : undefined;
  const guardDirWord = (word) => {
    if (typeof isGuardDirectory !== "function" || bareTarget(word).startsWith("-")) return false;
    try {
      return pathsOf(word, ctx).some((p) => isGuardDirectory(p));
    } catch {
      return false;
    }
  };
  const GUARD_DIR_WHY = "it deletes or moves a directory that holds the gate's own code (aiteam, aiteam/hooks or aiteam/src): that switches the gate off without naming a file";
  // The words of SPEC.md's gate: its keys named anywhere in the command (the script of a `sed`, the text
  // appended — which may be in the other side of a pipe: `echo tier_defaults: | tee -a SPEC.md`).
  const namesKeys = SPEC_KEYS.test(sub) || SPEC_KEYS.test(ctx.whole ?? "");
  // An in-place edit (`sed -i`, `perl -pi`, `awk -i inplace`) asks whatever it names: `sed -i '4s/false/true/'
  // SPEC.md` flips the break-glass without saying `allow_tier3`, and what line 4 is cannot be told from the command.
  const asks = (kind, how) => kind !== "spec" || how === "overwrite" || how === "delete" || how === "code" || how === "inplace" || namesKeys;

  // 1. Redirections, whatever the program (`echo x > file` is a write).
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    if (!OUT_REDIRECT.test(t)) continue;
    const kind = kindOf(tokens[i + 1]);
    if (kind && asks(kind, t.endsWith(">>") ? "append" : "overwrite")) return hit(kind, tokens[i + 1]);
  }

  // The input redirection of a command (`patch -p1 < fix.diff`) is its stdin file, not an argument.
  const inputIndex = tokens.findIndex((t) => IN_REDIRECT.test(t));
  const stdinFile = inputIndex >= 0 ? tokens[inputIndex + 1] : undefined;
  const { name, args } = programOf(tokens.filter((t, i) => !(isRedirect(t) || (i > 0 && isRedirect(tokens[i - 1])))));
  const words = args.filter((a) => a !== "");

  // `cd`: what follows resolves somewhere else (the paths of later sub-commands, and any patch they read).
  if (CD.has(name)) {
    followCd(name, words, ctx);
    return null;
  }
  recordWrites(name, words, tokens, ctx);
  const gated = words.map((w) => [w, kindOf(w)]).filter(([, k]) => k !== null);

  // 2. Shells and PowerShell with code: read the code as a command of its own.
  if (SHELLS.has(name)) {
    for (let i = 0; i < words.length; i++) {
      if (/^-(c|command|encodedcommand)$/i.test(words[i]) || /^\/[ck]$/i.test(words[i])) {
        const code = words.slice(i + 1).join(" ");
        const inner = scan(code, { ...ctx }, depth + 1);
        if (inner) return { ...inner, sub };
      }
    }
  }

  // `eval` runs its words as a command line, like `sh -c`.
  if (name === "eval") {
    const inner = scan(words.join(" "), { ...ctx }, depth + 1);
    if (inner) return { ...inner, sub };
  }

  // 3. Inline code of an interpreter that names a gate file and writes.
  if (INTERPRETERS.has(name)) {
    const code = words.filter((w) => !w.startsWith("-") || /\s/.test(w)).join(" ");
    if (words.some((w) => /^-(e|c|p|r|-eval|-print)$/i.test(w)) && GATE_NAMES.test(code) && WRITE_API.test(code)) {
      const kind = /tier-rules\.json/i.test(code)
        ? "tier-rules"
        : /settings(?:\.local)?\.json/i.test(code)
          ? "settings"
          : /mcp\.json/i.test(code)
            ? "mcp"
            : "spec";
      const file = { spec: "SPEC.md", "tier-rules": ".claude/tier-rules.json", settings: ".claude/settings.json", mcp: ".mcp.json" }[kind];
      return hit(kind, file);
    }
    // The gate's own code (a consumer's aiteam/hooks, import closure and template) is named by a path, not by a
    // fixed file name: every path-looking word in the code is asked about, with the doubled backslashes of a
    // string literal read as separators.
    if (typeof ctx.guardCode === "function" && words.some((w) => /^-(e|c|p|r|-eval|-print)$/i.test(w)) && WRITE_API.test(code)) {
      for (const m of code.matchAll(/[\w.\-\\/:]+\.(?:mjs|cjs|js|json)\b/gi)) {
        const named = m[0].replace(/\\+/g, "/");
        if (kindOf(named) === "guard-code") return hit("guard-code", named);
      }
    }
  }

  // 4. git and patch, which change files without naming them as a destination.
  if (name === "git") {
    const found = gitWrite(words, { ctx, kindOf, gateDirWord, hit, stdinFile, depth });
    if (found) return found;
  }
  if (name === "patch") {
    const found = patchWrite(words, { ctx, kindOf, hit, stdinFile, inline: true });
    if (found) return found;
  }

  // 5. Links: the link is a second door to the file, so the SOURCE counts as much as the destination.
  const newItemLink = (name === "new-item" || name === "ni") && words.some((w, i) => /^-itemtype$/i.test(w) && /^(symboliclink|junction|hardlink)$/i.test(words[i + 1] ?? ""));
  if (LINKS.has(name) || newItemLink) {
    const [file, kind] = gated[0] ?? [];
    if (kind) return hit(kind, file, `it links ${file}, a gate file: a link is a second door to it`);
    // A link to a DIRECTORY that holds the gate is a door to every file in it: the .claude/.cursor directory (or
    // anything inside), a repo root, an ancestor of the repo root, or a path that really is one of those.
    const operands = words.map((w) => (/^-{1,2}[A-Za-z]+[:=]./.test(w) ? bareTarget(w) : w)).filter((w) => !w.startsWith("-") && !/^\/[A-Za-z]$/.test(w));
    const exposed = operands.find((w) => gateDirWord(w) || exposesGateDirectory(w, ctx));
    if (exposed) return hit("settings", exposed, `it links ${exposed}, a directory that holds the gate (.claude/.cursor, the repo root or an ancestor of it): a link is a second door to every file in it`);
    return null;
  }

  // 6. Copy and move: the destination (the LAST word) is overwritten, and a directory destination takes what
  // the sources carry; a move also takes the sources away.
  if (CP_LIKE.has(name)) {
    const nonOptions = words.filter((w) => !/^-/.test(w) || kindOf(w));
    const last = nonOptions[nonOptions.length - 1];
    const sources = nonOptions.slice(0, -1);
    if (last !== undefined) {
      const lastKind = kindOf(last);
      if (lastKind) return hit(lastKind, last);
      if (gateDirWord(last)) return hit("settings", last, DIR_WHY);
      // Into a repo root: a gate file by name, or a whole .claude/.cursor directory, lands in it.
      const root = resolvePath(bareTarget(last), ctx.cwd);
      let isRoot = false;
      try {
        isRoot = root !== "" && Boolean(ctx.isFrameworkRoot?.(root));
      } catch {
        isRoot = false;
      }
      if (isRoot) {
        const carried = sources.find((w) => GATE_BASENAME.test(basenameOf(resolvePath(bareTarget(w), ctx.cwd))));
        if (carried) return hit(kindOf(carried) ?? "settings", last, `it copies ${carried}, a gate file, into the repo root ${last}`);
      }
    }
    if (MOVES.has(name)) {
      const moved = sources.find((w) => kindOf(w));
      if (moved) return hit(kindOf(moved), moved);
      const movedDir = sources.find((w) => gateDirWord(w));
      if (movedDir) return hit("settings", movedDir, DIR_WHY);
      const movedGuard = sources.find((w) => guardDirWord(w));
      if (movedGuard) return hit("guard-code", movedGuard, GUARD_DIR_WHY);
    }
    return null;
  }

  if (gated.length === 0) {
    // Deleting the directory itself is deleting the gate.
    if (DELETE.has(name)) {
      const dir = words.find((w) => gateDirWord(w));
      if (dir) return hit("settings", dir, DIR_WHY);
      const guardDir = words.find((w) => guardDirWord(w));
      if (guardDir) return hit("guard-code", guardDir, GUARD_DIR_WHY);
    }
    return null;
  }

  // 7. Programs that overwrite, append to, delete or edit in place the file they are given.
  if (DELETE.has(name)) {
    const [file, kind] = gated[0];
    return hit(kind, file);
  }
  if (OVERWRITE.has(name)) {
    if (name === "tee" && words.some((w) => w === "-a" || w === "--append")) {
      const [file, kind] = gated[0];
      return asks(kind, "append") ? hit(kind, file) : null;
    }
    if (name === "dd") {
      const of = words.find((w) => /^of=/i.test(w));
      const kind = of ? kindOf(of) : null;
      return kind ? hit(kind, bareTarget(of)) : null;
    }
    const [file, kind] = gated[0];
    return asks(kind, "overwrite") ? hit(kind, file) : null;
  }
  if (APPEND.has(name)) {
    const [file, kind] = gated[0];
    return asks(kind, "append") ? hit(kind, file) : null;
  }
  if (INPLACE.has(name) && inplaceFlag(words)) {
    const [file, kind] = gated[0];
    return asks(kind, "inplace") ? hit(kind, file) : null;
  }
  return null;
}

// The paths a unified diff touches: the `diff --git a/x b/y`, `--- a/x`, `+++ b/y` and `rename to y` lines.
function patchPaths(text) {
  const paths = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const g = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (g) {
      paths.push(g[1], g[2]);
      continue;
    }
    const h = /^(?:---|\+\+\+) (?:[ab]\/)?([^\t]+?)(?:\t.*)?$/.exec(line);
    if (h && h[1] !== "/dev/null") paths.push(h[1]);
    const r = /^rename (?:from|to) (.+)$/.exec(line);
    if (r) paths.push(r[1]);
  }
  return paths;
}

// Options that change which file a patch path means: a directory prefix, a root, or how many leading path
// components are stripped (git apply strips 1 by default, and `-p1` is what git itself writes; patch strips
// none unless told).
function patchRedirectsPaths(words, inline) {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^--directory(=|$)/.test(w) || /^--root(=|$)/.test(w)) return w;
    if (inline && /^-d/.test(w)) return w;
    const p = /^-p(\d*)$/.exec(w) ?? /^--strip=(\d+)$/.exec(w);
    if (p && p[1] !== "1") return w;
    if (w === "-p" && words[i + 1] !== "1") return w;
  }
  return null;
}

// A patch (git apply / patch / git am): a gate file named in the arguments, or in the patch text, is a write.
// What this module cannot know it asks about: a patch it cannot read (stdin from a pipe, a file that is gone,
// no reader); a patch another sub-command of the same command writes first (it does not exist yet when the
// guard looks); a patch named after a `cd`/`pushd` (the path means another file there); and the options that
// move the paths the patch names (`--directory`, `--root`, `-d`, `-p` other than 1).
function patchWrite(words, { ctx, kindOf, hit, stdinFile, inline = false }) {
  const named = words.find((w) => kindOf(w));
  if (named) return hit(kindOf(named), named);
  const moved = patchRedirectsPaths(words, inline);
  if (moved) return hit("settings", moved, `it applies a patch with ${moved}, which moves the paths the patch names: a patch of tier-rules.json can mean .claude/tier-rules.json`);
  // The patch files: positional (git apply a.diff b.diff), -i FILE / --input=FILE (patch), or `< FILE`.
  const files = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^(?:-i|--input)$/.test(w) && words[i + 1]) files.push(words[++i]);
    else if (/^--input=/.test(w)) files.push(w.slice(8));
    else if (!w.startsWith("-") && !(inline && files.length === 0 && i === 0 && words.length > 1)) files.push(w);
  }
  if (stdinFile) files.push(stdinFile);
  const readers = files.filter((f) => f !== "-");
  if (readers.length === 0 || files.includes("-") || typeof ctx.read !== "function") {
    return hit("settings", files[0] ?? "(stdin)", "it applies a patch this guard cannot read, and a patch may rewrite a gate file");
  }
  if (ctx.cwdChanged) return hit("settings", readers[0], "it applies a patch after a cd, so the patch path means another file than the one this guard can read");
  for (const f of readers) {
    const resolved = resolvePath(bareTarget(f), ctx.cwd).toLowerCase();
    if (ctx.written.has(resolved)) return hit("settings", f, `it applies ${f}, which an earlier part of the same command writes: it does not exist yet to be read`);
  }
  for (const f of readers) {
    let text = null;
    try {
      text = ctx.read(f);
    } catch {
      text = null;
    }
    if (typeof text !== "string") return hit("settings", f, `it applies ${f}, which this guard cannot read, and a patch may rewrite a gate file`);
    for (const p of patchPaths(text)) {
      const kind = kindOf(p);
      if (kind) return hit(kind, p, `the patch ${f} rewrites ${p}, a gate file`);
    }
  }
  return null;
}

// A pathspec that reaches every file or the whole `.claude`: a glob, the magic prefix `:(`, a `..` segment, or
// anything that normalizes to the repo root, an ancestor of it or the .claude/.cursor directory.
const BROAD_PATHSPEC = /^(?:\.|\.\/|:\/|\*|:\/\*|:\/\.)$/;
function isBroadPathspec(word, ctx) {
  const w = bareTarget(word);
  if (BROAD_PATHSPEC.test(w) || /[*?[]/.test(w) || w.startsWith(":(") || /(^|[\\/])\.\.([\\/]|$)/.test(w)) return true;
  return exposesGateDirectory(w, ctx);
}

// git: a command asks when it names a gate file, or the directory of one, as an operand it WRITES to, or when the command
// line itself can run something this parser does not follow:
//  - checkout / restore: `git checkout <ref> -- .claude/settings.json`, `git restore SPEC.md`, `git checkout -- .claude/`,
//    and — when a source is given — a pathspec that reaches every file (`git checkout <ref> -- .`);
//  - stash push (and the bare `git stash -- <path>`): `git stash push -- SPEC.md` puts the working-tree change away;
//  - apply and am: the patch is read (patchWrite);
//  - `-c key=value` / `--config-env` with a key outside a closed list of harmless ones (an alias, a pager, an editor, a hook
//    path), a global option the parser does not know, and a subcommand that is not a git builtin (an alias, a script, a typo);
//  - rebase -x / --exec: the command git runs after each commit is read as a command like any other.
// merge, rebase (without -x), cherry-pick, revert, pull, reset --hard, stash pop|apply|branch and checkout|switch <branch>
// PASS, and no git runs inside the hook: what a merge brings arrives reviewed, through a PR, and the guard is a screen, not a
// sandbox (aiteam/docs/adr/0004-gate-files-shell-detection-is-a-screen.md). All of this is text parsing, no process.

// git's GLOBAL options (the ones before the subcommand), as two CLOSED lists. Anything that starts with a dash and is
// in neither makes the command ask: reading an unknown option as "a flag with no value" is how the value of a new
// option (`--attr-source <tree>`) becomes the "subcommand" and the classification comes apart. So this fails closed;
// a git that grows a new global option asks until it is added here.
//  - with a value (the separate form eats the next word; the attached form `--x=v` is one word):
const GIT_VALUE_GLOBALS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--exec-path", "--config-env", "--attr-source"]);
//    and the ones among them that point git somewhere else, where the patch of an `apply` or `am` cannot be read;
const GIT_REDIRECTING_GLOBALS = new Set(["-C", "--git-dir", "--work-tree"]);
//  - without a value (switches, and the options that only print something and exit):
const GIT_FLAG_GLOBALS = new Set([
  "--no-pager", "-p", "--paginate", "-P", "--bare", "--no-replace-objects", "--literal-pathspecs", "--glob-pathspecs",
  "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks", "--no-lazy-fetch", "--no-advice", "--html-path",
  "--man-path", "--info-path", "--version", "-v", "--help", "-h",
]);

// `-c key=value` and `--config-env=key=ENVVAR` set configuration for ONE command, and a lot of configuration runs a
// program or changes what runs: `alias.*` (an alias defined here shadows a subcommand that is not a builtin and runs a
// shell with `!`), core.pager / core.editor / core.sshCommand / core.fsmonitor / core.hooksPath, `*.cmd`, `*.command`,
// credential.helper, diff.external, gpg.program, core.worktree and so on — what is wrong is not any one key but the
// open list. So the keys that are allowed are a CLOSED list of the ones that are only identity, colour and line-ending
// behaviour; any other `-c`/`--config-env` makes the command ask, whatever the subcommand.
const GIT_HARMLESS_CONFIG = /^(?:user\.(?:name|email)|color\.[\w.-]+|core\.(?:quotepath|autocrlf|safecrlf|eol|longpaths|abbrev|ignorecase|precomposeunicode)|advice\.[\w.-]+|init\.defaultbranch|commit\.gpgsign|tag\.gpgsign|gc\.auto|protocol\.version)$/i;

// The subcommands this guard knows: git's TRUE builtins, the ones git runs itself and an alias cannot shadow (git
// checks the builtins first, and only then the aliases). The commands that are scripts or separate programs
// (`submodule`, `filter-branch`, `difftool`, `mergetool`, `request-pull`, `send-email`, `instaweb`, `gui`, `gitk`,
// `citool`, `subtree`, `svn`, `lfs`, `flow`, `scalar`, an alias, a typo) can be an alias or an external script, so
// they are not here: a word in the subcommand position that is not in this list is something this parser cannot
// classify, and a command it cannot classify asks.
const GIT_SUBCOMMANDS = new Set(
  (
    "add am annotate apply archive bisect blame branch bugreport bundle cat-file check-attr check-ignore check-mailmap " +
    "check-ref-format checkout checkout-index cherry cherry-pick clean clone column commit commit-graph commit-tree " +
    "config count-objects credential describe diagnose diff diff-files diff-index diff-tree fast-export fast-import " +
    "fetch fetch-pack fmt-merge-msg for-each-ref for-each-repo format-patch fsck fsck-objects gc get-tar-commit-id " +
    "grep hash-object help hook index-pack init interpret-trailers log ls-files ls-remote ls-tree mailinfo mailsplit " +
    "maintenance merge merge-base merge-file merge-index merge-tree mktag mktree multi-pack-index mv name-rev notes " +
    "pack-objects pack-redundant pack-refs patch-id prune prune-packed pull push range-diff read-tree rebase receive-pack reflog " +
    "remote repack replace rerere reset restore rev-list rev-parse revert rm send-pack shortlog show " +
    "show-branch show-index show-ref sparse-checkout stash status stripspace switch symbolic-ref tag unpack-file " +
    "unpack-objects update-index update-ref update-server-info upload-pack var verify-commit verify-pack verify-tag version " +
    "whatchanged worktree write-tree"
  ).split(" ")
);

// The values of an option given as `-x CMD` or `--exec=CMD`.
function gitOptionValues(list, names) {
  const out = [];
  for (let k = 0; k < list.length; k++) {
    const w = list[k];
    if (w === "--") break;
    if (names.includes(w)) {
      if (list[k + 1] !== undefined) out.push(list[++k]);
      continue;
    }
    const attached = names.find((n) => n.startsWith("--") && w.startsWith(`${n}=`));
    if (attached) out.push(w.slice(attached.length + 1));
  }
  return out;
}

function gitWrite(words, { ctx, kindOf, gateDirWord, hit, stdinFile, depth = 0 }) {
  // The subcommand: the first word that is not a global option (`-C dir`, `-c k=v`, `--git-dir=...`).
  let i = 0;
  let redirected = false;
  while (i < words.length) {
    const w = words[i];
    // `--namespace x` (separate) and `--namespace=x` (attached) are the same option: the separate form eats the next word.
    const attached = w.startsWith("--") && w.includes("=");
    const name = attached ? w.slice(0, w.indexOf("=")) : w;
    const step = attached ? 1 : 2;
    if (name === "-c" || name === "--config-env") {
      // `-c key=value` / `--config-env key=ENVVAR` (or `--config-env=key=ENVVAR`): the key says what it can do.
      const setting = attached ? w.slice(w.indexOf("=") + 1) : words[i + 1] ?? "";
      const key = setting.split("=")[0] ?? "";
      if (!GIT_HARMLESS_CONFIG.test(key)) {
        return hit("settings", `git ${name} ${key}`, `git ${name} sets "${key}", configuration that can run a program (an alias, a pager, an editor, a hook path, a helper) or change where git works, and only the identity, colour and line-ending keys are not: this guard cannot tell what the command does, so it asks`);
      }
      i += step;
    } else if (GIT_VALUE_GLOBALS.has(name)) {
      if (GIT_REDIRECTING_GLOBALS.has(name)) redirected = true;
      i += step;
    } else if (GIT_FLAG_GLOBALS.has(w) || /^--list-cmds=/.test(w)) {
      i += 1;
    } else if (w.startsWith("-")) {
      return hit("settings", `git ${w}`, `"${w}" is a git global option this guard does not know, and it may take a value that would be read as the subcommand: it asks`);
    } else break;
  }
  // The subcommand as written: git resolves `Rebase` on Windows to a `git-rebase` that is not the builtin, so a word
  // outside the exact list is "not a subcommand this guard knows" and asks.
  const sub = words[i] ?? "";
  const rest = words.slice(i + 1);
  // A word where the subcommand goes that is not a git builtin is something this parser cannot classify (an alias, an
  // external script, a typo): it asks, never "nothing to see here".
  if (sub !== "" && !GIT_SUBCOMMANDS.has(sub)) {
    return hit("settings", `git ${sub}`, `"${sub}" is not a git subcommand this guard knows (a builtin; an alias, an external script and a typo are not), so it cannot tell what the command writes: it asks`);
  }

  if (sub === "rebase") {
    // `--exec CMD` / `-x CMD` runs CMD after each commit it replays: it is a command like any other. The rest of the
    // rebase passes.
    for (const cmd of gitOptionValues(rest, ["-x", "--exec"])) {
      const inner = scan(cmd, { ...ctx }, depth + 1);
      if (inner) return hit(inner.kind, inner.file, inner.why);
    }
    return null;
  }
  if (sub === "apply") {
    if (rest.some((w) => /^--(?:check|stat|numstat|summary)$/.test(w))) return null;
    if (redirected) return hit("settings", "git apply", "git runs in another directory (-C/--git-dir), so this guard cannot read the patch");
    return patchWrite(rest, { ctx, kindOf, hit, stdinFile });
  }
  if (sub === "am") {
    if (rest.some((w) => /^--(?:abort|quit|skip|show-current-patch)$/.test(w))) return null;
    if (redirected) return hit("settings", "git am", "git runs in another directory (-C/--git-dir), so this guard cannot read the mailbox");
    return patchWrite(rest.filter((w) => w !== "--continue" && w !== "-r"), { ctx, kindOf, hit, stdinFile });
  }
  if (sub === "stash") {
    // push (or the bare `git stash -- <path>`) takes the named paths out of the working tree; the other verbs name none.
    const op = rest.find((w) => !w.startsWith("-"));
    if (["pop", "apply", "branch", "list", "show", "drop", "clear", "create", "store"].includes(op ?? "")) return null;
    const named = rest.find((w) => kindOf(w));
    if (named) return hit(kindOf(named), named, `git stash puts away ${named}, a gate file`);
    const dir = rest.find((w) => gateDirWord(w));
    if (dir) return hit("settings", dir, "git stash puts away the .claude/ (or .cursor/) directory");
    return null;
  }
  if (sub !== "checkout" && sub !== "restore") return null;

  const dd = rest.indexOf("--");
  const before = dd < 0 ? rest : rest.slice(0, dd);
  const after = dd < 0 ? [] : rest.slice(dd + 1);
  const beforeOperands = before.filter((w) => !w.startsWith("-"));
  // checkout: the first operand before `--` (or the first of several) may be the tree-ish it takes files from.
  const treeish = sub === "checkout" ? (dd < 0 ? beforeOperands.length >= 2 : beforeOperands.length >= 1) : false;
  const sourceGiven = treeish || rest.some((w) => /^(?:--source(?:=|$)|-s$)/.test(w));
  const pathspecs = sub === "checkout" ? (dd < 0 ? beforeOperands.slice(1) : after) : [...beforeOperands, ...after];

  const everything = [...beforeOperands, ...after];
  const named = everything.find((w) => kindOf(w));
  if (named) return hit(kindOf(named), named, `git ${sub} writes ${named}, a gate file, from another version`);
  const dir = everything.find((w) => gateDirWord(w));
  if (dir) return hit("settings", dir, `git ${sub} rewrites the .claude/ (or .cursor/) directory from another version`);
  const broad = pathspecs.find((w) => isBroadPathspec(w, ctx));
  if (sourceGiven && broad) return hit("settings", broad, `git ${sub} brings files from another version through the pathspec ${broad}, which can reach the gate files`);
  return null;
}
