// Pure permission-tier classifier, with ONE import: ./frontmatter.mjs, the shared
// SPEC.md frontmatter reader (itself without imports). No node:* modules, no npm
// packages, no shebang — the hook loads this in plain node, without node_modules.
// (This used to say "dependency-free": true until allowTier3FromSpec started
// reading the frontmatter through frontmatter.mjs. Whoever copies the hook into a
// throwaway dir must copy that file too; tier-guard-hook.test.ts does, and
// tier-core.test.ts pins the import list.)
//
// This is the SINGLE source of the classification algorithm, imported by both
// the runtime hook (aiteam/hooks/tier-guard.mjs, plain node) and the typed
// reference (aiteam/src/tier-classifier.ts). Keeping one implementation means the
// security gate and its unit tests can never drift apart.
//
// Honest scope: this blocks *accidental / obvious* Tier-3 commands. It is NOT a
// sandbox against adversarial code — a determined caller can still obfuscate
// (e.g. `echo cm0gLXJmIC8K | base64 -d | sh`). Treat it as a guardrail, not a
// security boundary.

import { extractFrontmatter } from "./frontmatter.mjs";

// Programs whose arguments are inert text (printed, not executed), so a Tier-3
// string in their args must NOT be classified as Tier 3.
const INERT_COMMANDS = new Set(["echo", "printf", ":", "true", "false", "#"]);

// The opening of a heredoc on a line: `<<EOF`, `<<-EOF`, `<<'EOF'`, `<< "EOF"`.
const HEREDOC_OPEN = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/;

// ---- who receives a heredoc ---------------------------------------------------------------------
//
// A heredoc body is DATA only when the program that receives it is on a short ALLOWLIST of programs that
// store text and never run it; for ANYTHING else — and whenever there is doubt — the body is classified as
// the script it may be. This used to be the other way round (a list of interpreters whose bodies were
// scripts), and every program the list forgot — psql, mysql, sqlite3, sqlcmd, wsl, su, `source`, `.`, fish,
// csh, awk, `sudo -s`, `bash -s` through an alias — received its body as data: a `DROP TABLE` sent to psql
// is exactly Tier 3. The PO's policy is to fail closed, so the list is of what is KNOWN to be inert.
//
// The allowlist, each entry with why it cannot run the text:
//  - `cat` and `tee`: copy stdin to a file or to stdout, nothing more;
//  - `git commit|tag|notes|merge -F -` (`--file=-`): the body is the message;
//  - `gh … --body-file -` (`-F -`, `--notes-file -`): the body is the text of an issue, PR or release;
//  - `cp /dev/stdin <file>` and `dd of=<file>`: a byte copy into a file;
//  - the text options of `git commit -m` / `gh --body` (the same closed list as INERT_TEXT_OPTIONS), for the
//    commit idiom below.
//
// A PowerShell here-string (`@'` … `'@`, `@"` … `"@`) is NOT data: its body is classified like any other text, in both
// the Bash and the PowerShell tool. In bash `@'` is a plain quote (the first `'` of the body closes it and what follows
// runs), and a `#` or a `$'` on the opening line makes bash and this module read the line differently; the guard
// cannot tell which shell reads the text. A message that quotes a destructive command goes through `git commit -F
// <file>` or `gh … --body-file`; `git commit -m @'…'@` keeps the closed text-option strip below (INERT_TEXT_OPTIONS).
// What follows the receiver matters too: a heredoc whose receiver is piped on (`cat <<EOF | bash`) is data
// only if everything it is piped into is on the list as well. And the commit idiom of this harness,
// `git commit -m "$(cat <<'EOF' … EOF)"`, is data because its receiver (`cat`) is on the list AND the command
// that takes the substitution (`git commit -m`) only stores text.
//
// Doubt, always classified: a quote that never closes (outside the substitution above); a program word
// with a `\` (that is not a Windows drive or UNC path), a `$`, a backtick, a glob, a brace, a parenthesis,
// quotes or a `~` (`b\ash`, `$'bash'`, `$SHELL`, `ba*h`); a receiver this module cannot find; a receiver
// that is not on the list; a process substitution or subshell among its arguments.

const MARK = "\u0001MARK\u0001";

// A line, cut into segments by `|`, `|&`, `||`, `&&`, `;` and `&`, each with its words. Quotes and backslash
// escapes are taken off a word's `text`; `raw` keeps what was written (the program doubt checks read it) and
// `bare` the characters that were neither quoted nor escaped (the process-substitution check reads it).
// Redirections are words of their own. null when a quote never closes.
function lexSegments(line) {
  const segments = [];
  let words = [];
  let cur = "";
  let raw = "";
  let bare = "";
  let started = false;
  let quote = null;
  const flushWord = () => {
    if (started) words.push({ text: cur, raw, bare });
    cur = "";
    raw = "";
    bare = "";
    started = false;
  };
  const endSegment = (terminator) => {
    flushWord();
    segments.push({ words, terminator });
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      raw += c;
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < line.length) {
        cur += line[++i];
        raw += line[i];
      } else cur += c;
      continue;
    }
    // Two constructs this lexer does not model, so bash and the guard would read the line differently: a `#` that
    // starts a word (a comment: what follows is not part of the command) and `$'` / `$"` (ANSI-C and locale
    // quoting: `$'a\\'b'` has an escaped quote the plain `'` rule does not know). Doubt: null, and whoever asked
    // fails closed (the body of the heredoc or here-string is classified).
    if ((c === "#" && !started) || (c === "$" && (line[i + 1] === "'" || line[i + 1] === '"'))) return null;
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      raw += c;
      continue;
    }
    if (c === "\\" && i + 1 < line.length) {
      cur += line[++i];
      raw += c + line[i];
      started = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      flushWord();
      continue;
    }
    if (c === "|") {
      let op = "|";
      if (line[i + 1] === "|") {
        op = "||";
        i++;
      } else if (line[i + 1] === "&") {
        op = "|&";
        i++;
      }
      endSegment(op);
      continue;
    }
    if (c === "&" && line[i + 1] !== ">") {
      let op = "&";
      if (line[i + 1] === "&") {
        op = "&&";
        i++;
      }
      endSegment(op);
      continue;
    }
    if (c === ";") {
      endSegment(";");
      continue;
    }
    if (c === ">" || c === "<" || c === "&") {
      // `2>`, `&>`: the file descriptor belongs to the operator.
      if (c !== "&" && /^\d+$/.test(raw) && started) {
        raw = "";
        cur = "";
        bare = "";
        started = false;
      } else {
        flushWord();
      }
      let op = c;
      if (c === "&") {
        op = "&>";
        i++;
      } else if (line[i + 1] === c) {
        op += c;
        i++;
      }
      if (line[i + 1] === "&") {
        op += "&";
        i++;
      }
      words.push({ text: op, raw: op, bare: op, redirect: true });
      continue;
    }
    cur += c;
    raw += c;
    bare += c;
    started = true;
  }
  if (quote) return null;
  endSegment("");
  return segments;
}

// The program a segment runs, or null when this module cannot be sure which it is.
function programOfWords(words) {
  const first = words.find((w) => !w.redirect);
  if (!first) return null;
  const { raw, text } = first;
  const windows = /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\");
  if (/[$`(){}*?[\]'"~]/.test(raw) || (!windows && raw.includes("\\"))) return null;
  // A Windows path keeps its backslashes (they are separators there, not escapes): read the program off `raw`.
  const base = (windows ? raw.split(/[\\/]/).pop() : text.split("/").pop()) ?? "";
  return base.toLowerCase().replace(/\.exe$/, "") || null;
}

// The arguments of a segment (as words): everything but the program, the redirection operators and their targets.
function argumentWords(words) {
  const args = [];
  let skip = false;
  let seenProgram = false;
  for (const w of words) {
    if (w.redirect) {
      skip = true;
      continue;
    }
    if (skip) {
      skip = false;
      continue;
    }
    if (!seenProgram) {
      seenProgram = true;
      continue;
    }
    args.push(w);
  }
  return args;
}

// An argument or redirection target that could run something: a process substitution, a subshell.
const RUNNABLE = /[()`]|\$\{/;
const runnable = (words) => words.some((w) => RUNNABLE.test(w.bare));

// git as a receiver of TEXT: `commit`, `tag`, `notes` and `merge` store a message, and nothing else of what they do
// is code — PROVIDED the command line is a closed set of options. An option that runs something (a global `-c
// core.editor=...` or `-c alias.x=!cmd`, `--exec-path`, `--config-env`), points git at another repo and its config
// (`--git-dir`, `--work-tree`, `--namespace`), or opens an editor (`-e`, `--edit`, `-p`...) is not in the set, and
// a command line with any of them is not a text receiver: its heredoc body is classified. Deliberately small. Every
// option here is a boolean flag, a text value (`-m`), or the stdin form of the message (`-F -`); the only global
// option allowed is `-C <dir>` (and the pager switches), which only changes where the same git runs.
const GIT_TEXT_SUBS = {
  commit: { shorts: "qsna", longs: ["--quiet", "--signoff", "--allow-empty", "--allow-empty-message", "--no-verify", "--amend", "--no-edit", "--all"] },
  tag: { shorts: "af", longs: ["--annotate", "--force"] },
  notes: { shorts: "f", longs: ["--force"] },
  merge: { shorts: "q", longs: ["--quiet", "--no-ff", "--ff", "--ff-only", "--squash", "--no-edit", "--no-verify"] },
};

// Is `args` (a git command line without the program) a commit, tag, note or merge that only stores text, with
// nothing outside the closed set above? null when it is not. Otherwise `{stdin, values}`: `stdin` says the message
// comes from stdin (`-F -`, `--file=-`), `values` holds the indexes in `args` of the words that ARE the message
// (the value of `-m`/`--message`, even one the line has not got to yet).
function gitTextCommand(args) {
  let i = 0;
  while (i < args.length) {
    if (args[i] === "-C") {
      if (i + 1 >= args.length) return null;
      i += 2;
    } else if (args[i] === "--no-pager" || args[i] === "--no-optional-locks") i += 1;
    else break;
  }
  // OWN keys only: the word is the command's text, and `constructor`, `__proto__` or `toString` would answer with a
  // member every object inherits — which then throws (`spec.longs.includes`), and an exception sends the whole
  // command to the fixed floor, which lets everything but `rm -rf` through.
  const sub = args[i] ?? "";
  const spec = Object.hasOwn(GIT_TEXT_SUBS, sub) ? GIT_TEXT_SUBS[sub] : undefined;
  if (!spec) return null;
  let stdin = false;
  const values = new Set();
  for (let k = i + 1; k < args.length; k++) {
    const a = args[k];
    if (a === "--") break; // what follows are paths
    if (a === "-F" || a === "--file") {
      if (args[k + 1] !== "-") return null;
      stdin = true;
      k++;
    } else if (a === "-F-" || a === "--file=-") stdin = true;
    else if (a === "-m" || a === "--message") values.add(++k);
    else if (a.startsWith("--message=")) values.add(k);
    else if (a.startsWith("--")) {
      if (!spec.longs.includes(a)) return null;
    } else if (/^-[A-Za-z]+$/.test(a)) {
      // `-am`, `-sq`: every letter is an option of the closed set, and a `m` ends the word with its value next.
      for (let n = 1; n < a.length; n++) {
        if (a[n] === "m" && n === a.length - 1) values.add(++k);
        else if (!spec.shorts.includes(a[n])) return null;
      }
    } else if (a.startsWith("-")) return null; // `-`, `-ccore.editor=x`, `-S...`
  }
  return { stdin, values };
}

// `-F -`, `-F-`, `--file -`, `--file=-` and the like: the message or body is read from stdin.
function readsFromStdin(args, names) {
  for (let i = 0; i < args.length; i++) {
    for (const name of names) {
      if (args[i] === name && args[i + 1] === "-") return true;
      if (args[i] === `${name}=-` || (name.length === 2 && args[i] === `${name}-`)) return true;
    }
  }
  return false;
}

// Is this segment an allowlisted receiver of a HEREDOC body (stdin)?
function receivesHeredocAsData(words) {
  const name = programOfWords(words);
  if (name === null) return false;
  const argWords = argumentWords(words);
  const targets = words.filter((w, i) => i > 0 && words[i - 1].redirect && words[i - 1].text.includes(">"));
  if (runnable(targets) || runnable(argWords)) return false;
  const args = argWords.map((w) => w.text);
  switch (name) {
    case "cat":
    case "tee":
      return true;
    case "git": {
      const text = gitTextCommand(args);
      return text !== null && text.stdin;
    }
    case "gh":
      return readsFromStdin(args, ["-F", "--body-file", "--notes-file"]);
    case "cp": {
      const operands = args.filter((a) => !a.startsWith("-"));
      return operands.length === 2 && operands[0] === "/dev/stdin";
    }
    case "dd": {
      const of = args.find((a) => /^of=./.test(a));
      const ifs = args.filter((a) => /^if=/.test(a));
      return Boolean(of) && ifs.every((a) => a === "if=/dev/stdin" || a === "if=-");
    }
    default:
      return false;
  }
}

// The text options of gh (git's are in gitTextCommand).
const GH_TEXT_OPTIONS = new Set(["--body", "-b", "--title", "-t", "--comment", "-c", "--subject", "--notes", "-n"]);

// Is this command line, which ends in an OPEN quote that holds a `$(` substitution, a command that only stores the
// text it is given, and does it end with that text? (`git commit -m "`, `gh pr create --body "`.) NOT `echo` and
// `printf`: they print the text, and what receives their output next (a pipe, the `$(...)` of another command) runs
// it — outside the allowlist like any program that is not a pure store of text.
function consumesTextOnly(outer) {
  let segments = null;
  for (const q of ['"', "'", ""]) {
    segments = lexSegments(outer + q);
    if (segments !== null) break;
  }
  if (segments === null) return false;
  const words = segments[segments.length - 1].words;
  const name = programOfWords(words);
  if (name === null) return false;
  const args = argumentWords(words).map((w) => w.text);
  if (name === "git") {
    // The message is the LAST word of the line (or the `-m` that is waiting for it): `-m "…` + the substitution.
    const text = gitTextCommand(args);
    return text !== null && [...text.values].some((v) => v >= args.length - 1);
  }
  if (name === "gh") {
    const prev = args.length >= 2 ? args[args.length - 2] : "";
    const last = args[args.length - 1] ?? "";
    const optionBefore = GH_TEXT_OPTIONS.has(prev) || (last !== "" && ["--body=", "--title=", "--notes="].some((p) => last === p));
    return ["issue", "pr", "release"].includes((args[0] ?? "").toLowerCase()) && optionBefore;
  }
  return false;
}

// Walks a stretch of command text — a line, or the part of one before a `<<` — and keeps `st` up to date: the open
// quote ("", `"` or "'") and the open constructs on `st.stack` (`$(`, `<(`/`>(`, a subshell `(`, a backtick), each
// with the quote that was open around it. Quote-aware: a `)` or `(` inside quotes, or a backslash-escaped one, do not
// count, and the inside of a `$(` starts with fresh quoting. Returns true when an unquoted `#` at the start of a word
// begins a comment — it hides the rest of the stretch, `<<` included — and "$'" when a `$'` or `$"` (ANSI-C and locale
// quoting, which this scan does not model) shows up outside quotes; it stops at either. null otherwise.
function scanShell(st, text) {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (st.quote === "'") {
      if (c === "'") st.quote = "";
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "`") {
      const top = st.stack[st.stack.length - 1];
      if (top?.kind === "`") {
        st.stack.pop();
        st.quote = top.saved;
      } else {
        st.stack.push({ kind: "`", at: i, saved: st.quote });
        st.quote = "";
      }
      continue;
    }
    if (c === "$" && text[i + 1] === "(") {
      st.stack.push({ kind: "$(", at: i, saved: st.quote });
      st.quote = "";
      i++;
      continue;
    }
    if (c === "$" && st.quote === "" && (text[i + 1] === "'" || text[i + 1] === '"')) return "$'";
    if (c === '"') {
      st.quote = st.quote === '"' ? "" : '"';
      continue;
    }
    if (st.quote === '"') continue; // inside double quotes only `$(` and a backtick are special
    if (c === "'") {
      st.quote = "'";
      continue;
    }
    if (c === "#" && (i === 0 || /[\s;|&(]/.test(text[i - 1]))) return "#";
    if ((c === "<" || c === ">") && text[i + 1] === "(") {
      st.stack.push({ kind: "proc", at: i, saved: st.quote });
      st.quote = "";
      i++;
      continue;
    }
    if (c === "(") {
      st.stack.push({ kind: "(", at: i, saved: st.quote });
      st.quote = "";
      continue;
    }
    if (c === ")") {
      const top = st.stack.pop();
      if (top) st.quote = top.saved;
    }
  }
  return null;
}

// Where the marker sits: inside exactly ONE command substitution `$(`, and in nothing else that runs — not a second
// `$(`, a backtick, a `<(`/`>(` process substitution or a subshell. `{kind: "none"}` when no substitution is open
// there; `{kind: "sub", index, quote}` for the one `$(` (`quote` is `"` when it sits inside double quotes); and
// `{kind: "doubt"}` for anything else.
function openSubstitution(opening) {
  const mark = opening.indexOf(MARK);
  const st = { stack: [], quote: "" };
  scanShell(st, opening.slice(0, mark));
  const { stack } = st;
  if (stack.length === 0) return { kind: "none" };
  if (stack.length === 1 && stack[0].kind === "$(") return { kind: "sub", index: stack[0].at, quote: stack[0].saved === '"' ? '"' : "" };
  return { kind: "doubt" };
}

// Is the heredoc whose opening line is `opening` (with the marker in place of `<<EOF`) data? `closing` is the line
// right after the delimiter line (undefined when the command ends there).
function heredocIsData(opening, closing) {
  const open = openSubstitution(opening);
  if (open.kind === "doubt") return false;
  if (open.kind === "sub") {
    // `git commit -m "$(cat <<'EOF'`: the heredoc goes to the command INSIDE the substitution, and that
    // command's output goes to the one outside. For that to be data the WHOLE wrapping command has to be a
    // consumer of text and nothing else: the outer words are a closed git/gh text command ending in the message
    // (consumesTextOnly), the opening line has nothing after the heredoc's own pipeline, and the line that follows
    // the delimiter closes the substitution and its quote and says nothing more — `)" | bash` would hand the
    // output to a shell, `)" && x` and `)" 2>&1 x` are more command than the idiom has.
    const inner = lexSegments(opening.slice(open.index + 2));
    if (inner === null) return false;
    const at = inner.findIndex((s) => s.words.some((w) => w.text === MARK));
    if (at < 0) return false;
    let i = at;
    for (;;) {
      if (!receivesHeredocAsData(inner[i].words.filter((w) => w.text !== MARK))) return false;
      if (inner[i].terminator === "|" || inner[i].terminator === "|&") {
        i++;
        if (i >= inner.length) return false;
        continue;
      }
      break;
    }
    if (inner[i].terminator !== "" || inner.slice(i + 1).some((s) => s.words.length > 0)) return false;
    // The one thing it may say besides the quote and the `)`: that the command's output is limited — `2>&1`, and a
    // `| tail` or `| head` with no argument, `-N`, `-n N` or `-nN`, in that order (`gh pr create … )" 2>&1 | tail -5`
    // is how the harness runs a PR). Any other pipe or redirection (`| bash`, `| tee f`, `> f`, `| xargs …`) fails the
    // match and the body is classified.
    const closes = new RegExp(`^\\s*\\)${open.quote}(?:\\s+2>&1)?(?:\\s*\\|\\s*(?:tail|head)(?:\\s+-n\\s*\\d+|\\s+-\\d+)?)?\\s*$`);
    if (typeof closing !== "string" || !closes.test(closing)) return false;
    return consumesTextOnly(opening.slice(0, open.index));
  }
  const segments = lexSegments(opening);
  if (segments === null) return false;
  let i = segments.findIndex((s) => s.words.some((w) => w.text === MARK));
  if (i < 0) return false;
  for (;;) {
    if (!receivesHeredocAsData(segments[i].words.filter((w) => w.text !== MARK))) return false;
    // Piped on: the next segment gets what this one writes, so it must be a receiver too.
    if (segments[i].terminator === "|" || segments[i].terminator === "|&") {
      i++;
      if (i >= segments.length) return false;
      continue;
    }
    return true;
  }
}

// The ssh commands of a line that opens a heredoc: the body is a script that runs on another host, so each of
// its lines is also classified as the remote command it is (`ssh host <line>`, see splitScript).
function sshSegments(opening) {
  const found = [];
  const flat = opening.split(MARK).join(" ");
  const segments = lexSegments(flat);
  if (segments === null) return /(?:^|[\s|;&(])ssh(?:\s|$)/i.test(flat) ? [flat] : found;
  for (const s of segments) {
    // The command's own words, without the redirections and their targets (`2>&1`).
    const words = s.words.filter((w, i) => !w.redirect && !(i > 0 && s.words[i - 1].redirect));
    if (programOfWords(words) === "ssh") found.push(words.map((w) => w.text).join(" "));
  }
  return found;
}

/**
 * Pull heredoc bodies out of the command text. A heredoc body is stdin DATA,
 * not commands — classifying its lines is what denied `cat > runbook.md <<'EOF'`
 * for merely DOCUMENTING a Tier-3 command. Two things keep this from becoming a
 * bypass: a body is data ONLY when the program that receives it is on the
 * allowlist above (anything else, or any doubt, leaves the body inline: it may
 * be a script), and a body opened with an UNQUOTED delimiter is still scanned
 * for `$(...)`/backticks, which the shell does expand. A PowerShell here-string
 * (`@'` … `'@`) is not taken out at all: its body stays in the text and is classified.
 *
 * Returns the command minus the data bodies, plus those bodies that still need
 * substitution scanning, plus the `remotes`: a heredoc handed to `ssh` is a script
 * that runs on ANOTHER host, so each of its lines is also classified as the remote
 * command it is (`ssh host <line>`, see splitScript) — otherwise the ssh patterns
 * (docker, systemctl, a script by path, a reboot...) never see it.
 */
function splitHeredocs(command) {
  const lines = String(command ?? "").split("\n");
  const kept = [];
  const dataBodies = [];
  const scriptBodies = [];
  const remotes = [];
  // Where the shell's quoting stands at the start of each line we visit (heredoc bodies are skipped).
  // A heredoc opened while a quote or a `$(` is still open from an EARLIER line is not a heredoc: the `<<` is text
  // inside the quote, and what follows the quote runs.
  const st = { stack: [], quote: "", poisoned: false };
  // Moves the state past a stretch of text. When the scan meets a `$'` / `$"` it cannot follow what the shell does
  // next — an ANSI-C string takes `\\'` as an escaped quote and may run across lines — so from there on the state is
  // UNKNOWN (poisoned): every heredoc after it is in doubt.
  const advance = (text) => {
    if (scanShell(st, text) === "$'") st.poisoned = true;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    kept.push(line);
    const carriedOpen = st.poisoned || st.quote !== "" || st.stack.length > 0;

    // `<<<` is a herestring (single-line), not a heredoc — leave it alone.
    const m = HEREDOC_OPEN.exec(line);
    if (!m || line.includes("<<<")) {
      advance(line);
      continue;
    }
    const [, dash, quoted, delim] = m;
    const opening = line.replace(HEREDOC_OPEN, ` ${MARK} `);

    // Reasons the shell does NOT read this `<<` as a heredoc opening the way the line looks (the opening is then in
    // doubt, and the body is classified like any other text):
    //  - a quote or a `$(` is still open from an earlier line, or opens on this line before the `<<`;
    //  - an unquoted `#` at the start of a word, before the `<<` (a comment: `cat # <<'EOF'` opens nothing, and the
    //    lines after it are commands) or after it, and a `$'` / `$"` anywhere on the line (ANSI-C and locale quoting,
    //    which the quote scan and the word lexer do not model);
    //  - the line ends in an odd number of backslashes: the shell joins it with the next one (`cat <<'EOF' \\` +
    //    `| bash` is `cat <<'EOF' | bash`), so what this line says is not the whole command.
    const probe = { stack: st.stack.map((f) => ({ ...f })), quote: st.quote };
    const beforeMarker = scanShell(probe, line.slice(0, m.index));
    const unmodelled = beforeMarker ?? scanShell({ stack: st.stack.map((f) => ({ ...f })), quote: st.quote }, line);
    const joined = /(\\+)\r?$/.exec(line);
    const doubt = carriedOpen || unmodelled !== null || probe.quote !== "" || (joined !== null && joined[1].length % 2 === 1);

    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const cmp = dash ? lines[j].replace(/^[\t ]+/, "") : lines[j];
      if (cmp.trim() === delim) break;
      body.push(lines[j]);
    }
    // The line after the delimiter is what closes a `$(cat <<EOF` substitution (`)"`): data only if it says no more.
    const data = !doubt && heredocIsData(opening, lines[j + 1]);
    advance(line);
    if (doubt) {
      // The lines after it are lines of THIS shell: keep the quoting in step with them.
      for (const l of body) advance(l);
      if (j < lines.length) advance(lines[j]);
    }

    if (!data) {
      for (let k = i + 1; k < j; k++) kept.push(lines[k]); // a script, or in doubt
      // Also on its own, as a script: inside a `"$(cat <<EOF … )"` the inline lines sit in a quoted string (never
      // split into commands), and when the substitution body is split again its `cat <<EOF` is data by itself.
      if (body.length > 0) scriptBodies.push(body.join("\n"));
      if (body.length > 0) {
        for (const ssh of sshSegments(opening)) remotes.push({ line: ssh, body: body.join("\n") });
      }
    } else if (!quoted) {
      dataBodies.push(body.join("\n")); // literal prose, but $(...) still expands
    }
    if (j < lines.length) kept.push(lines[j]); // the delimiter line itself
    i = j;
  }

  return { text: kept.join("\n"), dataBodies, scriptBodies, remotes };
}

/**
 * Options whose VALUE the program stores or sends as text and never executes.
 * This is a CLOSED list, keyed by program and subcommand, and it is deliberately
 * never "any quoted text": in `ssh host "…"`, `bash -c "…"` or
 * `docker exec … sh -c "…"` the quoted text IS the command.
 *
 * The two programs are matched differently, on purpose. git has `-m` dropped
 * wherever git and the subcommand appear in the sub-command, because requiring
 * git to be the leading program would turn `sudo git commit -m "…"` and other
 * wrappers back into false positives. The accepted cost is an obfuscation
 * path such as `sh -c 'eval "$3"' git commit -m '…'`, the kind the honest-scope
 * note above already leaves out. gh is covered only as the leading program
 * (`ssh host gh … --body "…"` is not).
 */
const INERT_TEXT_OPTIONS = [
  {
    applies: (sub) => /\bgit\b/.test(sub) && /\b(commit|tag|merge|notes)\b/.test(sub),
    options: ["-m", "--message"],
  },
  {
    applies: (sub) => ["issue", "pr"].includes(ghCommandGroup(sub)),
    options: ["--body", "-b", "--title", "-t", "--comment", "-c", "--subject"],
  },
  {
    applies: (sub) => ghCommandGroup(sub) === "release",
    options: ["--notes", "-n", "--title", "-t"],
  },
].map(({ applies, options }) => {
  const opt = options.join("|");
  return {
    applies,
    hereString: new RegExp(`(^|\\s)(${opt})(\\s+|=)@(['"])[\\s\\S]*?\\4@`, "g"),
    quoted: new RegExp(`(^|\\s)(${opt})(\\s+|=)(['"])[\\s\\S]*?\\4`, "g"),
  };
});

/**
 * Drop the literal value of the options in INERT_TEXT_OPTIONS before matching,
 * so a commit, a PR body or release notes that DOCUMENT a Tier-3 command are not
 * denied for quoting it. Only the literal is dropped: a `$(...)`, backtick or
 * `<(...)` inside it runs, and splitSubCommands has already surfaced it as its
 * own sub-command, so substitution is still classified.
 *
 * Both quoting styles count as a literal, also as `--option=value`: POSIX
 * `'...'`/`"..."` and the PowerShell here-string `@'...'@`/`@"..."@` — the form
 * Windows needs for a multi-line value. Missing the here-string denied the
 * commit that documented the ssh+deploy fix on a Windows box (2026-07-27).
 */
function stripInertText(sub) {
  let probe = sub;
  for (const rule of INERT_TEXT_OPTIONS) {
    if (!rule.applies(sub)) continue;
    probe = probe.replace(rule.hereString, "$1$2 <text>").replace(rule.quoted, "$1$2 <text>");
  }
  return probe;
}

/**
 * Bodies of the substitutions in `text`: `$(...)` and the process substitutions
 * `<(...)`/`>(...)`, each matched to the paren that really closes it (nesting
 * and a `)` inside quotes don't cut it short), and backtick pairs. Every body is
 * a script the shell RUNS, whatever quoting surrounds it.
 *
 * Process substitution is here because the here-string match above is loose: in
 * bash `@'x' <(cmd) '@'` is two single-quoted strings with `<(cmd)` running
 * between them, yet the strip sees one value.
 */
function substitutionBodies(text) {
  const bodies = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ((c === "$" || c === "<" || c === ">") && text[i + 1] === "(") {
      const end = closingParen(text, i + 1);
      bodies.push(text.slice(i + 2, end));
      i = end;
    } else if (c === "`") {
      // A lone backtick is PowerShell's escape character (`n, `t): skip it
      // rather than stop, or it would hide a later $(...).
      const end = text.indexOf("`", i + 1);
      if (end === -1) continue;
      bodies.push(text.slice(i + 1, end));
      i = end;
    }
  }
  return bodies;
}

// Index of the `)` closing the `(` at `open`, or text.length when nothing does.
// Quotes inside a substitution are its own, so a `)` inside them does not close it.
function closingParen(text, open) {
  let depth = 0;
  let quote = null;
  for (let j = open; j < text.length; j++) {
    const c = text[j];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === "(") {
      depth++;
    } else if (c === ")" && --depth === 0) {
      return j;
    }
  }
  return text.length;
}

/**
 * Split a command line into independently-classifiable sub-commands on shell
 * operators (`&&`, `||`, `|`, `;`, newline), respecting single/double quotes so
 * operators inside quoted strings are ignored. The body of every `$(...)`,
 * backtick pair and `<(...)`/`>(...)` is split the same way, recursively, and
 * surfaced as sub-commands of its own: it is a whole script, so classifying it
 * as one block let a leading `echo` make `"$(echo ok; rm -rf x)"` look inert.
 */
export function splitSubCommands(command) {
  return splitScript(command, 0);
}

// Past this nesting depth a body is surfaced whole instead of split again. Its
// text is still matched; what the cap prevents is a pathological `$($($(…`
// overflowing the stack — a crashed hook is a non-blocking error, so the
// command would run.
const MAX_SUBSTITUTION_DEPTH = 16;

// Cuts a line into its sub-commands at `&&`, `||`, `|`, `|&`, `&`, `;` and newline, outside quotes. `shellEscapes` is
// the bash reading: outside quotes a `\` makes the NEXT character literal (both go to the buffer, and an escaped
// `&`, `;`, `|`, `>`, `<` or quote neither cuts nor changes what the `&` after it means). Without it the `\` is an
// ordinary character, which is how PowerShell reads `C:\x\; rm y` (its escape is the backtick).
function cutParts(text, shellEscapes) {
  const parts = [];
  let buf = "";
  let quote = null;
  let prevEscaped = false; // the previous character was consumed as the target of a `\`

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    const wasEscaped = prevEscaped;
    prevEscaped = false;

    if (quote) {
      buf += c;
      if (c === quote) quote = null;
      continue;
    }
    if (shellEscapes && c === "\\" && i + 1 < text.length) {
      buf += c + next;
      i++;
      prevEscaped = true;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      buf += c;
      continue;
    }
    if (c === "&" && next === "&") { parts.push(buf); buf = ""; i++; continue; }
    if (c === "|" && (next === "|" || next === "&")) { parts.push(buf); buf = ""; i++; continue; } // `||` and `|&`
    // A lone `&` sends the command on its left to the background and runs the one on its right: a separator, as `;` is.
    // Not the `&` of `&>`/`&>>` (both streams to a file), of `>&2`/`2>&1`/`>&-` or of `<&3` (a file descriptor): an
    // ESCAPED `>` or `<` before it is just an argument, and the `&` separates.
    const afterRedirect = (text[i - 1] === ">" || text[i - 1] === "<") && !wasEscaped;
    if (c === "&" && next !== ">" && !afterRedirect) { parts.push(buf); buf = ""; continue; }
    if (c === "|" || c === ";" || c === "\n") { parts.push(buf); buf = ""; continue; }
    buf += c;
  }
  parts.push(buf);
  return parts;
}

function splitScript(command, depth) {
  // Heredoc bodies come out first: they are stdin data, not commands (see
  // splitHeredocs — an interpreter's body stays inline, and an unquoted
  // delimiter's body still gets scanned for substitutions below).
  const { text, dataBodies, scriptBodies, remotes } = splitHeredocs(command);
  // The line is cut by the plain reading, and — when it holds a backslash — by the bash one too; the sub-commands are the
  // union. The decision to cut never depends on an escaped character in the bash reading (`ssh h cmd \& sudo reboot` stays
  // whole, as the remote shell reads it) and never on its absence in the plain one (`echo C:\x\; rm y` in PowerShell).
  const parts = cutParts(text, false);
  if (text.includes("\\")) for (const part of cutParts(text, true)) if (!parts.includes(part)) parts.push(part);

  const expanded = [];
  const surface = (body) => (depth < MAX_SUBSTITUTION_DEPTH ? splitScript(body, depth + 1) : [body]);
  for (const p of parts) {
    expanded.push(p);
    for (const body of substitutionBodies(p)) expanded.push(...surface(body));
  }
  // The prose of an unquoted-delimiter heredoc stays out, but the shell DOES
  // expand substitutions inside it — surface only those.
  for (const data of dataBodies) {
    for (const body of substitutionBodies(data)) expanded.push(...surface(body));
  }
  // The body of a heredoc that is NOT data is a script: classified as one, whatever quoting its inline copy sits in.
  for (const script of scriptBodies) expanded.push(...surface(script));
  // The script a heredoc hands to `ssh` runs on the remote host: classify each of its lines also as
  // `ssh <the ssh command> <line>`, so the ssh patterns see what the remote shell will run. Only the
  // ssh part of the opening line lends its words (`ssh host <<EOF && echo done` has `ssh host`).
  for (const remote of remotes) {
    // `remote.line` is the sub-command of the opening line that IS the ssh (splitHeredocs found it:
    // `true && ssh host <<EOF` has `true` first).
    for (const sub of surface(remote.body)) expanded.push(`${remote.line} ${sub}`);
  }
  return expanded.map((s) => s.trim()).filter(Boolean);
}

// The words of a sub-command from its program on (leading VAR=value skipped).
function commandWords(sub) {
  const tokens = sub.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  return tokens.slice(i);
}

function leadingProgram(sub) {
  return (commandWords(sub)[0] ?? "").toLowerCase();
}

// "issue" for `gh issue comment …`; "" when gh is not the program that runs.
function ghCommandGroup(sub) {
  const [program, group] = commandWords(sub);
  return (program ?? "").toLowerCase() === "gh" ? (group ?? "").toLowerCase() : "";
}

// Compiled regexes per pattern list, so each list compiles once per load of the
// rules (the hook loads them once per run). A pattern that does not compile is
// SKIPPED, never thrown: one typo in tier-rules.json used to crash the hook,
// Claude Code treats a failed hook as a non-blocking error, and the command ran
// with the whole gate off. The other patterns keep protecting; the doctor
// (checkTierRules) names the bad one. A list that is not an array, or an entry
// that is not a string, is skipped the same way.
//
// An empty or whitespace-only entry is skipped too, as deny_hints already does with
// its `match`: `new RegExp("")` compiles and matches EVERY command. In
// tier3.patterns that denied even `ls`; in ask_patterns it was worse, because every
// Tier-3 command then matched the ask subset and a destructive one (drop table) left
// the deny that only the break-glass lifts for a one-click prompt. Skipping blanks is NOT
// what keeps ask_patterns honest, though: `(?:)`, `^`, `.*`, `x*`, `$`, `(?=)` and `\s*` match
// the empty string and `.`, `[\s\S]` and `\w|\W` match every command without matching "", so
// no filter on the pattern text catches them all. What does is tier3Verdict below: a command
// is promoted to ask only by the tier3.patterns entry that is ITSELF listed in ask_patterns
// (by identity of the string), so a stray ask_pattern promotes nothing (A3).
//
// The cache is keyed by the IDENTITY of the list (a WeakMap on the array object), not
// by its contents: change a pattern IN PLACE (push, splice, assignment into the same
// array) after the list was first used and the old compiled patterns keep applying.
// The hook loads the rules once per run, so it never notices; a long-lived caller
// (a test, a server) must hand over a new array — or a new rules object — after
// changing a pattern. Documented in tier-core.d.mts and pinned in tier-core.test.ts.
const compiledLists = new WeakMap();

const NO_PATTERNS = Object.freeze({ entries: [], regexes: [], sources: new Set() });

// {entries: [{source, re}], regexes: [re], sources: Set(source)} of the entries the guard applies.
function compileList(list) {
  if (!Array.isArray(list)) return NO_PATTERNS;
  let compiled = compiledLists.get(list);
  if (!compiled) {
    const entries = [];
    for (const p of list) {
      if (typeof p !== "string" || p.trim() === "") continue;
      try {
        const re = new RegExp(p, "i");
        // V8 compiles lazily: a pattern can parse and still throw at its first use ("Regular expression too large"),
        // which would send EVERY command down the exception path (the fixed floor lets all but rm -rf through).
        // Run it once on the empty string so the compile happens here, and drop the pattern if it throws.
        re.test("");
        entries.push({ source: p, re });
      } catch {
        // skipped — see above
      }
    }
    compiled = { entries, regexes: entries.map((e) => e.re), sources: new Set(entries.map((e) => e.source)) };
    compiledLists.set(list, compiled);
  }
  return compiled;
}

function compilePatterns(list) {
  return compileList(list).regexes;
}

// A pattern that throws on THIS text (V8 compiles lazily, and an input of millions of characters can exhaust its
// backtracking stack: "Maximum call stack size exceeded") counts as a MATCH. The guard cannot say the command is clear,
// and the exception would otherwise reach the hook's failure path, whose fixed floor lets everything but rm -rf through.
// For a Tier-3 pattern a match is a deny (or an ask, when it is also in ask_patterns); for a Tier-2 one it is a Tier 2.
function reTest(re, text) {
  try {
    return re.test(text);
  } catch {
    return true;
  }
}

function matchesAny(text, patterns) {
  return compilePatterns(patterns).some((re) => reTest(re, text));
}

/**
 * How many entries of a pattern list the guard can actually APPLY: the non-blank
 * strings that compile with `new RegExp(p, "i")`, the same rule compilePatterns uses
 * to skip the rest. The tier-rules loader (tier-rules-loader.mjs) refuses a map
 * whose tier3.patterns has none — the guard would then protect with the fixed
 * floor only — so it counts with this function instead of re-implementing it.
 */
export function countCompilablePatterns(list) {
  return compilePatterns(list).length;
}

// Under-match cases the line-level regexes miss: recursive+force expressed as
// separate flags, and force-push with the flag anywhere in the args.
function isRecursiveForceRm(sub) {
  if (!/\brm\b/.test(sub)) return false;
  const recursive = /(^|\s)-[a-z]*r/i.test(sub) || /\s--recursive\b/.test(sub);
  const force = /(^|\s)-[a-z]*f/i.test(sub) || /\s--force\b/.test(sub);
  return recursive && force;
}

// A force push, by what the words say. Three spellings force it:
//  - `--force` as a word of its own, anywhere in a command that names `git` and `push` (the original heuristic, order
//    agnostic). `--force-with-lease` and `--force-if-includes` are not it: they refuse to overwrite what they did not see;
//  - `-f` alone or inside a cluster of short flags (`-uf`, `-fu`, `-vf`);
//  - a refspec that starts with `+` (`+main`, `+HEAD:main`), which forces that ref whatever the flags say.
// The last two are read only from a `git [global options] push` command, so `git fetch -f origin push-branch` is not one.
function isForcePush(sub) {
  if (!/\bgit\b/i.test(sub) || !/\bpush\b/i.test(sub)) return false;
  if (/(?:^|[\s"'])--(?:force|mirror)(?=$|[\s"'=])/.test(sub)) return true; // `--mirror` overwrites every ref of the remote
  const args = gitPushArguments(sub);
  return args !== null && pushArgumentsForce(args);
}

// git's global options that take a value as the next word: `git -C dir push`.
const GIT_GLOBALS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env", "--attr-source"]);

// The words after `push` in `... git [global options] push ...` (quotes taken off), or null when git's subcommand is not push.
function gitPushArguments(sub) {
  const words = sub.trim().split(/\s+/).map((w) => w.replace(/^["']+|["']+$/g, ""));
  let i = words.findIndex((w) => /^(?:.*[\\/])?git(?:\.exe)?$/i.test(w));
  if (i < 0) return null;
  for (i++; i < words.length; i++) {
    if (GIT_GLOBALS_WITH_VALUE.has(words[i])) i++;
    else if (!words[i].startsWith("-")) break;
  }
  return (words[i] ?? "").toLowerCase() === "push" ? words.slice(i + 1) : null;
}

// Do the arguments of a `git push` force it? (`-o <option>` and `--receive-pack <program>` are skipped with their value, and
// in a cluster the letters after an `o` are that option's value, not flags.)
function pushArgumentsForce(args) {
  let optionsEnded = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (!optionsEnded && a === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (a === "-o" || a === "--push-option" || a === "--receive-pack" || a === "--exec" || a === "--repo")) {
      k++;
      continue;
    }
    if (!optionsEnded && /^-[A-Za-z0-9]+$/.test(a)) {
      for (const letter of a.slice(1)) {
        if (letter === "f") return true;
        if (letter === "o") break;
      }
      continue;
    }
    if (a.length > 1 && a.startsWith("+")) return true;
  }
  return false;
}

// What one sub-command means for the Tier-3 gate: null (not Tier 3), "ask" (a
// chat-approvable deploy on its own) or "deny". classifyTier and
// isAskEligibleTier3 both read it, so they always agree on what a sub-command
// is. Matching runs on the command minus the literal values of
// INERT_TEXT_OPTIONS — `git commit`/`gh pr` themselves survive the strip.
function tier3Verdict(sub, rules) {
  if (!sub || INERT_COMMANDS.has(leadingProgram(sub))) return null;
  const probe = stripInertText(sub);
  if (isRecursiveForceRm(probe) || isForcePush(probe)) return "deny";
  const matched = compileList(rules?.tier3?.patterns).entries.filter((entry) => reTest(entry.re, probe));
  if (matched.length === 0) return null;
  // ask only when EVERY tier3.patterns entry that matches is itself in ask_patterns (A3). The rule
  // used to be "some ask_pattern matches the text", which a pattern that matches everything turned
  // into ask for every Tier-3 command, and which let a deploy pattern vouch for a command that ALSO
  // matched a deny-class one (`ssh host "docker ps; sudo reboot"` asked instead of denying).
  const asks = compileList(rules?.tier3?.ask_patterns).sources;
  return matched.every((entry) => asks.has(entry.source)) ? "ask" : "deny";
}

function classifyOne(sub, rules) {
  if (tier3Verdict(sub, rules)) return 3;
  if (!sub || INERT_COMMANDS.has(leadingProgram(sub))) return 1;
  if (matchesAny(stripInertText(sub), rules?.tier2?.patterns)) return 2;
  return 1;
}

/**
 * Classify a shell command into a permission tier (1|2|3). Each sub-command is
 * classified independently and the HIGHEST tier wins, so `lint && rm -rf x` is
 * Tier 3 and `echo "vercel --prod"` is Tier 1.
 */
export function classifyTier(command, rules) {
  let max = 1;
  for (const sub of splitSubCommands(command)) {
    const tier = classifyOne(sub, rules);
    if (tier > max) max = tier;
  }
  return max;
}

/**
 * Ask-eligibility for a Tier-3 command: true iff EVERY sub-command that is
 * Tier 3 matches the ask_patterns subset (chat-approvable deploys) and NO
 * destructive heuristic fires anywhere — a mixed command like
 * `vercel --prod && rm -rf /` is NOT ask-eligible (deny wins). Legacy rules
 * without ask_patterns — or with none that compiles — always return false
 * (fail closed), and a command with no Tier-3 sub-command returns false (there
 * is nothing to approve).
 */
export function isAskEligibleTier3(command, rules) {
  if (compilePatterns(rules?.tier3?.ask_patterns).length === 0) return false;
  let sawTier3 = false;
  for (const sub of splitSubCommands(command)) {
    const verdict = tier3Verdict(sub, rules);
    if (verdict === "deny") return false;
    if (verdict === "ask") sawTier3 = true;
  }
  return sawTier3;
}

const DEFAULT_DENY_HINT =
  "Set tier_defaults.allow_tier3: true in SPEC.md after explicit human approval to permit it.";

// The advice when tier3.ask_patterns carries entries the guard skips (they do not compile,
// are empty or are not text). Such an entry cannot ask for approval, so a deploy it was
// meant to cover closes to deny — the right outcome — but the break-glass is the wrong
// advice for that: allow_tier3 is GLOBAL (it releases rm -rf and drop table too) and the
// fix is a typo in the file. The guard cannot tell whether THIS command was a deploy (the
// pattern that would have asked is the one it skipped), so the advice is conditional and
// the destructive branch keeps the break-glass.
function brokenAskHint(skipped) {
  return (
    `tier3.ask_patterns in .claude/tier-rules.json has ${skipped} ${skipped === 1 ? "entry" : "entries"} the guard skips ` +
    `(they do not compile, or are empty). If this is a deploy that should ask for approval, that is why it is denied: ` +
    `run node aiteam/scripts/doctor.mjs, which names them, and fix the file — do NOT turn on tier_defaults.allow_tier3 for it, ` +
    `the flag is global and also releases rm -rf and drop table. ` +
    `Otherwise it is a destructive command, released only by that flag after explicit human approval.`
  );
}

// How many entries of a list the guard skips: the ones compilePatterns drops.
function skippedCount(list) {
  return Array.isArray(list) ? list.length - compilePatterns(list).length : 0;
}

// The fixed floor (recursive+force rm, force push): denied by heuristic, never ask-able, so
// a broken ask_patterns has nothing to do with it.
function isFloorDeny(sub) {
  const probe = stripInertText(sub);
  return isRecursiveForceRm(probe) || isForcePush(probe);
}

/**
 * The fixed floor ALONE — no rules, no patterns: the first sub-command that is a recursive+force
 * `rm` or a `git push --force`, or null. It is what guardDecision(command, {}, false) denies (the
 * guard's last resort when no map is usable), said as "which part". The tier-guard hook applies it
 * when something it did not expect throws: the exception used to leave the hook with exit 1 and no
 * output, which Claude Code treats as a NON-blocking error, so the command ran with the whole gate
 * off. Never throws. If the splitter itself fails, the floor looks at the whole text instead —
 * coarser (it also denies a quoted `rm -rf`), never looser; that is the last rung and only runs
 * inside an exception. `split` is a seam for the tests.
 *
 * @param {unknown} command
 * @param {{split?: (command: string) => string[]}} [options]
 * @returns {string|null}
 */
export function floorDenyCulprit(command, { split = splitSubCommands } = {}) {
  let text;
  try {
    text = String(command ?? "");
  } catch {
    return null; // not even text: there is nothing to read
  }
  try {
    for (const sub of split(text)) {
      if (tier3Verdict(sub, {}) === "deny") return sub;
    }
    return null;
  } catch {
    const whole = text.trim();
    return isRecursiveForceRm(whole) || isForcePush(whole) ? whole : null;
  }
}

/**
 * Why a denied command is denied, for the guard's message: `culprit` is the
 * first sub-command that blocks it (original text, trimmed), and `hint` is the
 * advice for its class:
 *
 *  1. The line mixes an approvable deploy with a blocked sub-command → run the
 *     deploy on its own (it asks for approval) and the rest separately. Built
 *     in, because it is about the line rather than the culprit's class.
 *  2. Else the first `tier3.deny_hints` entry whose `match` (a case-insensitive
 *     regex, like the patterns) matches the culprit. The break-glass is the
 *     wrong advice for some classes — e.g. rebooting a host is not an agent
 *     task, and allow_tier3 is GLOBAL.
 *  3. Else, when tier3.ask_patterns has entries the guard skips and the culprit is
 *     not the fixed floor (rm -rf, force push): point at the doctor and say not to
 *     turn the global break-glass on for a deploy (brokenAskHint).
 *  4. Else the break-glass instruction the guard always gave. Rules without
 *     deny_hints, and malformed entries, end up here.
 */
export function explainDeny(command, rules) {
  let culprit = null;
  let deploy = null;
  for (const sub of splitSubCommands(command)) {
    const verdict = tier3Verdict(sub, rules);
    if (verdict === "deny" && culprit === null) culprit = sub;
    if (verdict === "ask" && deploy === null) deploy = sub;
  }
  if (culprit === null) return { culprit: String(command ?? "").trim(), hint: DEFAULT_DENY_HINT };
  if (deploy !== null) {
    return {
      culprit,
      hint:
        `This line mixes an approvable deploy ("${deploy}") with a blocked command. ` +
        `Run the deploy on its own (it asks for one-shot approval) and the rest as a separate command.`,
    };
  }
  const classHint = classDenyHint(culprit, rules);
  if (classHint !== null) return { culprit, hint: classHint };
  const skipped = skippedCount(rules?.tier3?.ask_patterns);
  if (skipped > 0 && !isFloorDeny(culprit)) return { culprit, hint: brokenAskHint(skipped) };
  return { culprit, hint: DEFAULT_DENY_HINT };
}

// First well-formed deny_hints entry whose regex matches; null when none does.
// An entry needs a non-empty `match` that compiles and a non-empty `hint` — an
// empty regex would match every command and hide the break-glass advice.
function classDenyHint(culprit, rules) {
  const entries = rules?.tier3?.deny_hints;
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    const { match, hint } = entry ?? {};
    if (typeof match !== "string" || !match.trim() || typeof hint !== "string" || !hint.trim()) continue;
    let re;
    try {
      re = new RegExp(match, "i");
    } catch {
      continue;
    }
    // a hint whose pattern throws on this text is skipped: it only picks the advice, it decides nothing
    let hit = false;
    try {
      hit = re.test(culprit);
    } catch {
      continue;
    }
    if (hit) return hint;
  }
  return null;
}

/**
 * Single decision point for the PreToolUse guard — pure and unit-tested here
 * so the hook (aiteam/hooks/tier-guard.mjs) stays a thin stdin/stdout shell.
 *  "allow": below Tier 3, or the SPEC.md allow_tier3 break-glass is on.
 *  "ask":   Tier-3 deploy subset — surface the engine's native approval prompt
 *           (one-shot; headless sessions have no approver, so the call fails
 *           closed).
 *  "deny":  any other Tier 3 (destructive) — the SPEC.md flag is the only
 *           override.
 */
export function guardDecision(command, rules, allowTier3) {
  if (classifyTier(command, rules) < 3) return "allow";
  if (allowTier3) return "allow";
  return isAskEligibleTier3(command, rules) ? "ask" : "deny";
}

// The break-glass line, read the way YAML reads it (see allowTier3FromSpec).
const TIER_DEFAULTS_HEADER = /^tier_defaults[ \t]*:[ \t]*(?:#.*)?$/;
const ALLOW_TIER3_KEY = /^[ \t]+allow_tier3[ \t]*:(.*)$/;
// The YAML 1.2 boolean. The value needs whitespace after the colon
// (`key:true` is one plain scalar, not a key), and `#` only opens a comment
// after whitespace (`true#x` is a string).
const YAML_TRUE = /^[ \t]+(?:true|True|TRUE)(?:[ \t]+#.*)?[ \t]*$/;
const BLANK_OR_COMMENT = /^[ \t]*(?:#.*)?$/;
// The only shape of a column-0 line the line-based reader accepts: `key:` or `key: value`.
const TOP_LEVEL_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]*[ \t]*:(?:[ \t].*)?$/;
// Line breaks of YAML 1.1 (LS, PS). YAML 1.2 does not break on them and neither does the
// line-based reader, so a frontmatter that has one is read differently by different parsers.
const YAML11_LINE_BREAKS = /[\u2028\u2029]/;

// Index of the quote closing the one that opens at `open`, or -1 when the line ends first.
// Double quotes escape with a backslash; single quotes escape by doubling.
function closingQuote(line, open) {
  const quote = line[open];
  for (let j = open + 1; j < line.length; j++) {
    const c = line[j];
    if (quote === '"' && c === "\\") j++;
    else if (c === quote) {
      if (quote === "'" && line[j + 1] === "'") j++;
      else return j;
    }
  }
  return -1;
}

/**
 * True when `line` opens a quoted scalar or a flow collection (`[`, `{`) it does not close.
 * Such a value continues on the next lines, and what the continuation lines are — text
 * inside a string, or keys of their own — is exactly where the line-based view and YAML can
 * disagree. A quote opens a scalar only at the start of a value (the start of the line, after
 * `key:`, after `- `, or after `[`, `{`, `,` in a flow collection): `it's` or `5" pipe` inside
 * a plain scalar are literal. A `#` after whitespace starts a comment.
 */
function opensAcrossLines(line) {
  let depth = 0;
  let atValue = true;
  let afterSpace = true;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === " " || c === "\t") {
      afterSpace = true;
      i++;
      continue;
    }
    if (c === "#" && afterSpace) break;
    afterSpace = false;
    if (atValue) {
      if (c === '"' || c === "'") {
        const end = closingQuote(line, i);
        if (end < 0) return true;
        i = end + 1;
        atValue = false;
        continue;
      }
      if (c === "[" || c === "{") {
        depth++;
        i++;
        continue; // a value (or an item) starts right after
      }
      if (c === "-" && (i + 1 >= line.length || line[i + 1] === " " || line[i + 1] === "\t")) {
        i++; // a sequence entry: its value follows
        continue;
      }
      atValue = false; // a plain scalar starts here
    }
    if (depth > 0 && (c === "]" || c === "}")) {
      depth--;
    } else if (depth > 0 && c === ",") {
      atValue = true;
    } else if (c === ":" && (i + 1 >= line.length || line[i + 1] === " " || line[i + 1] === "\t")) {
      atValue = true; // a key: its value follows
    }
    i++;
  }
  return depth > 0;
}

/**
 * Read the `tier_defaults.allow_tier3` break-glass out of SPEC.md's
 * frontmatter. This is the single rule of "approved" for every Tier-3 gate in
 * the framework — the Bash tier-guard hook, the pre-push backstop and the MCP
 * tools' gate (mcp/registry.ts delegates here) — so they can never drift on it.
 *
 * Only the KEY releases, and only where the line-based reading puts it: a direct
 * child of the column-0 `tier_defaults:` block whose value is the YAML 1.2 boolean
 * `true` (`true`, `True` or `TRUE`, optionally followed by a ` # comment`).
 * Comments, other keys, text that merely quotes the flag, the key under any
 * other parent, a value on the next line, a duplicated `allow_tier3` that
 * isn't true and a duplicated `tier_defaults:` block all read as false. The
 * substring search this replaces released on all of those (the deny message
 * pasted into a comment was enough); while the CRLF bug made every Windows
 * read false it never showed, and once CRLF was read it became a hole
 * (rb-ai-team#36).
 *
 * Line-based on purpose: the hook loads this module in plain node, without
 * node_modules, so there is no YAML parser to lean on. That is an APPROXIMATION of
 * where YAML puts the key, not a YAML parse, and it is only safe where the two agree
 * about which line is which. So it also reads false whenever the frontmatter has a
 * construct where they can disagree:
 *  - a quoted scalar or a `[`/`{` collection that crosses lines: a string can carry a
 *    column-0 `tier_defaults:` and an `allow_tier3: true` that for YAML are only text;
 *  - a column-0 line that is not `key:` / `key: value`;
 *  - a tab in the indentation (YAML forbids it, the line reader would accept it);
 *  - U+2028 / U+2029, which YAML 1.1 reads as line breaks and the line reader does not.
 * A BOM at the start and CR or CRLF line breaks are not such a construct: the shared
 * reader (frontmatter.mjs) normalizes them. Whatever it can't read with certainty is
 * false, a missing field or frontmatter included — the safe state is the default, and
 * the cost of a frontmatter that trips one of the rules is a flag that stays off.
 */
export function allowTier3FromSpec(specText) {
  return readAllowTier3(specText).allowed;
}

/**
 * The same reading as allowTier3FromSpec — it IS the implementation — with the reason it read
 * false. `why` is a short English sentence naming what kept it off, or null when the flag is on, or
 * when there is nothing to name: no frontmatter, or an `allow_tier3` that is not the bare boolean
 * `true` (a plain `false`, a quoted "true"). The doctor uses it to say WHY a SPEC.md that spells `allow_tier3: true` is read as
 * off: before, such a frontmatter shape just kept the break-glass shut, with no word to the human.
 *
 * @param {string|null|undefined} specText
 * @returns {{allowed: boolean, why: string|null}}
 */
export function readAllowTier3(specText) {
  const no = (why) => ({ allowed: false, why });
  const fm = extractFrontmatter(specText);
  if (fm === null) return no(null);
  if (YAML11_LINE_BREAKS.test(fm)) {
    return no("the frontmatter has U+2028 or U+2029, which YAML 1.1 reads as line breaks and the line reader does not");
  }

  let blocks = 0;
  let inBlock = false;
  let childIndent = null;
  let allowed = false;
  // The indentation of an `allow_tier3: true` line whose value may still go on in the next line.
  let flagIndent = null;
  const lines = fm.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const at = `line ${n + 2} of SPEC.md`; // +1 for the opening fence, +1 because lines count from 1
    // Blank and comment lines never count and, as in YAML, never close a block.
    if (BLANK_OR_COMMENT.test(line)) continue;
    const lead = /^[ \t]*/.exec(line)[0];
    if (lead.includes("\t")) return no(`a tab in the indentation (${at}): YAML forbids it`);
    // A line MORE indented than the key, right after `allow_tier3: true`, continues the value: for
    // YAML it is the multi-line scalar "true true" (a string), not the boolean (A2). Blank and
    // comment lines in between were skipped above, so they do not hide it.
    if (flagIndent !== null) {
      if (lead.length > flagIndent.length) {
        return no(`the value of allow_tier3 goes on in a more indented line (${at}): YAML reads a string, not the boolean true`);
      }
      flagIndent = null;
    }
    if (lead === "" && !TOP_LEVEL_KEY.test(line)) return no(`a column-0 line that is not \`key:\` or \`key: value\` (${at})`);
    if (opensAcrossLines(line)) return no(`a quoted string or [ / { collection that crosses lines (${at})`);
    if (!/^[ \t]/.test(line)) {
      // A column-0 key closes the block before it.
      inBlock = TIER_DEFAULTS_HEADER.test(line);
      if (inBlock) blocks += 1;
      childIndent = null;
      continue;
    }
    if (!inBlock) continue;
    const indent = /^[ \t]+/.exec(line)[0];
    if (childIndent === null) childIndent = indent; // the first child sets the level
    // Less indented than the children yet not at column 0: a dedent to no level of the block, which
    // YAML refuses (the reader would otherwise keep a `true` that YAML does not parse at all).
    if (indent.length < childIndent.length) return no(`a line indented between the levels of the tier_defaults block (${at}): YAML refuses it`);
    if (indent !== childIndent) continue; // deeper: it belongs to a nested key
    const key = ALLOW_TIER3_KEY.exec(line);
    if (!key) continue;
    if (!YAML_TRUE.test(key[1])) return no(null); // any allow_tier3 that isn't true denies
    allowed = true;
    flagIndent = indent;
  }
  if (!allowed) return no("no `allow_tier3: true` line directly under the column-0 `tier_defaults:` block");
  if (blocks !== 1) return no(`tier_defaults: appears ${blocks} times at column 0, and the reader refuses an ambiguous block`);
  return { allowed: true, why: null };
}
