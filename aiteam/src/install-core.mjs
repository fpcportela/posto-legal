// Pure, dependency-free merge helpers for aiteam/install.mjs. They never mutate
// their inputs and are idempotent, so the installer can run repeatedly without
// drift. The CLI shell does the file I/O and `git config`; this module only
// computes the merged values — which is what makes it unit-testable.

import * as path from "node:path";

// The framework's required .claude/settings.json wiring, merged into every
// consumer by aiteam/install.mjs via mergeSettings(host, FRAMEWORK_SETTINGS).
// Mirrors the dogfood copy in this repo's own root .claude/settings.json; keep
// the two in sync. Lives here (not in install.mjs) so it's a plain data export
// the test suite can import directly — install.mjs runs its wiring at module
// scope (no `if (require.main)` guard), so importing THAT file would execute
// the installer against the test runner's own repo.
//
// A consumer with no infra_kb pointer still gets the Write|Edit guard wired:
// matchesInfraPath's early bail keeps the per-edit cost cheap (no infra_kb →
// the hook is silent), but every Write/Edit still spawns a node process to
// find that out — same trade-off the framework already accepts for the
// tier-guard entries below.
//
// The tier-guard covers every tool that executes a command (issue #12: through
// PowerShell a deploy ran with no ASK and a destructive command with no deny).
// The non-Bash tools get their OWN entry instead of widening the Bash matcher:
// mergeSettings is idempotent per matcher+command, so a consumer installed
// before keeps its Bash entry and gains this one, rather than ending up with the
// guard registered twice for Bash.
//
// worktree.baseRef (issue 38): a subagent dispatched with isolation: "worktree"
// gets a worktree branched from origin/<default> ("fresh", the Claude Code
// default), which lacks the local commits this project never pushes
// automatically. "head" branches from the local HEAD. The valid values are
// "fresh" | "head" — the official settings schema
// (json.schemastore.org/claude-code-settings.json) and code.claude.com/docs
// (worktrees, settings-reference) agree; mergeSettings only fills it when the
// host hasn't chosen one.
export const FRAMEWORK_SETTINGS = {
  worktree: { baseRef: "head" },
  permissions: {
    deny: [
      "Bash(npx prisma migrate reset:*)",
      "Bash(prisma migrate reset:*)",
    ],
  },
  hooks: {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "node aiteam/hooks/tier-guard.mjs" }] },
      {
        matcher: "PowerShell|Monitor|mcp__terminal__run_in_terminal",
        hooks: [{ type: "command", command: "node aiteam/hooks/tier-guard.mjs" }],
      },
      { matcher: "Write|Edit", hooks: [{ type: "command", command: "node aiteam/hooks/infra-kb-guard.mjs" }] },
      // .beads (aiteam/docs/beads-schema.md §9): nega Write/Edit em visão gerada
      // e em arquivo de bead de outra branch. Entrada própria, para um
      // consumidor instalado antes ganhar esta sem mexer na do infra-kb-guard.
      { matcher: "Write|Edit", hooks: [{ type: "command", command: "node aiteam/hooks/beads-guard.mjs" }] },
      // F13: pede confirmação humana na edição dos arquivos do gate (SPEC.md tier_defaults/allow_tier3,
      // .claude/tier-rules.json, hooks e permissions do .claude/settings.json). Cobre as quatro ferramentas
      // de edição (o beads-guard e o infra-kb-guard só olham Write|Edit); o comando de shell que grava
      // neles é do tier-guard. Entrada própria, para um consumidor instalado antes a ganhar sem mexer nas outras.
      {
        matcher: "Write|Edit|MultiEdit|NotebookEdit",
        hooks: [{ type: "command", command: "node aiteam/hooks/gate-edit-guard.mjs" }],
      },
    ],
    SessionStart: [
      { hooks: [{ type: "command", command: "node aiteam/hooks/session-brief.mjs" }] },
    ],
  },
};

// The hooks the installer chains into a host that has its own core.hooksPath.
// Exported so the installer (writer) and doctor (checker) can never disagree
// about which hooks are supposed to carry the chain line. The four post-*
// hooks regenerate the .beads views (aiteam/docs/beads-schema.md §7.3);
// githooks-contract.test.ts pins this list to the files in aiteam/githooks.
export const CHAINED_HOOKS = ["post-checkout", "post-merge", "post-commit", "post-rewrite", "pre-commit", "pre-push"];

/**
 * Resolve where a host hook file lives, given the repo root and the host's
 * `core.hooksPath`. git accepts that config as relative OR absolute; joining it
 * onto the root unconditionally glued two roots together for an absolute value
 * and crashed the installer with ENOENT on a duplicated path. Windows and POSIX
 * disagree on what "absolute" means, so both shapes are recognized here — the
 * same repo config must behave the same wherever the installer runs.
 */
export function resolveHookPath(root, hooksPath, hook) {
  const p = String(hooksPath ?? "");
  const absolute = path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
  return absolute ? path.join(p, hook) : path.join(root, p, hook);
}

export function mergeDeny(hostDeny, frameworkDeny) {
  const out = [...(hostDeny ?? [])];
  for (const rule of frameworkDeny ?? []) {
    if (!out.includes(rule)) out.push(rule);
  }
  return out;
}

export function ensurePreToolUseHook(entries, command, matcher = "Bash") {
  const list = [...(entries ?? [])];
  const present = list.some(
    (e) => e?.matcher === matcher && (e?.hooks ?? []).some((h) => h?.command === command)
  );
  if (present) return list;
  return [...list, { matcher, hooks: [{ type: "command", command }] }];
}

// Merge helper for hook events that have no `matcher` (e.g. SessionStart —
// unlike PreToolUse, it isn't scoped to a tool, so entries are just
// `{ hooks: [...] }`). Kept separate from ensurePreToolUseHook rather than
// giving that function an optional matcher, because its `matcher = "Bash"`
// default would silently inject a matcher when called with undefined.
export function ensureHookCommand(entries, command) {
  const list = [...(entries ?? [])];
  const present = list.some((e) => (e?.hooks ?? []).some((h) => h?.command === command));
  if (present) return list;
  return [...list, { hooks: [{ type: "command", command }] }];
}

export function mergeSettings(host, framework) {
  const merged = JSON.parse(JSON.stringify(host ?? {}));
  const fw = framework ?? {};

  if (fw.permissions?.deny) {
    merged.permissions = merged.permissions ?? {};
    merged.permissions.deny = mergeDeny(merged.permissions.deny, fw.permissions.deny);
  }

  const fwPre = fw.hooks?.PreToolUse ?? [];
  if (fwPre.length) {
    merged.hooks = merged.hooks ?? {};
    let pre = merged.hooks.PreToolUse ?? [];
    for (const entry of fwPre) {
      for (const h of entry.hooks ?? []) {
        pre = ensurePreToolUseHook(pre, h.command, entry.matcher);
      }
    }
    merged.hooks.PreToolUse = pre;
  }

  const fwSessionStart = fw.hooks?.SessionStart ?? [];
  if (fwSessionStart.length) {
    merged.hooks = merged.hooks ?? {};
    let sessionStart = merged.hooks.SessionStart ?? [];
    for (const entry of fwSessionStart) {
      for (const h of entry.hooks ?? []) {
        sessionStart = ensureHookCommand(sessionStart, h.command);
      }
    }
    merged.hooks.SessionStart = sessionStart;
  }

  // Scalar settings: fill what the host left unset, never overwrite a choice.
  // A `worktree` that isn't an object is the host's own (invalid) config — left alone.
  if (fw.worktree && typeof fw.worktree === "object") {
    if (merged.worktree === undefined) merged.worktree = {};
    const target = merged.worktree;
    if (target !== null && typeof target === "object" && !Array.isArray(target)) {
      for (const [key, value] of Object.entries(fw.worktree)) {
        if (!(key in target)) target[key] = value;
      }
    }
  }
  return merged;
}

export function mergeMcpServers(host, framework) {
  const merged = JSON.parse(JSON.stringify(host ?? {}));
  merged.mcpServers = merged.mcpServers ?? {};
  for (const [name, def] of Object.entries(framework?.mcpServers ?? {})) {
    if (!(name in merged.mcpServers)) merged.mcpServers[name] = def;
  }
  return merged;
}

/** The framework servers the host does not register yet: exactly what mergeMcpServers adds. */
export function mcpServersAdded(host, framework) {
  const have = host?.mcpServers ?? {};
  return Object.keys(framework?.mcpServers ?? {}).filter((name) => !(name in have));
}

/** The install's action line for an MCP file: names the servers that actually went in, not all of the framework's. */
export function mcpAddedLabel(file, host, framework) {
  const added = mcpServersAdded(host, framework);
  return `${file} — added the ${added.join(" and ")} server${added.length > 1 ? "s" : ""}`;
}

export function ensureImportLine(content, importLine) {
  const text = content ?? "";
  if (text.split(/\r?\n/).some((l) => l.trim() === importLine)) return text;
  const sep = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  return `${text}${sep}${importLine}\n`;
}

export function planHookChaining(currentHooksPath, frameworkHooksDir) {
  const norm = (s) => String(s ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const cur = norm(currentHooksPath);
  const fw = norm(frameworkHooksDir);
  if (!cur) return { action: "set", hooksPath: frameworkHooksDir };
  if (cur === fw) return { action: "noop", hooksPath: frameworkHooksDir };
  // An ABSOLUTE path ending at the framework's own hooks dir is the canonical
  // value written non-canonically — normalize it back to the relative form
  // rather than mistaking it for a foreign host dir. Git resolves a RELATIVE
  // core.hooksPath against each working tree's own root, so the absolute form
  // silently pins every worktree to the main checkout's hooks. Worse, routing
  // here would chain the framework's hooks into THEMSELVES, and install's
  // path.join(root, <absolute hostHooksPath>) yields a nonsense path (ENOENT).
  if (cur.endsWith(`/${fw}`)) return { action: "set", hooksPath: frameworkHooksDir };
  return { action: "router", hostHooksPath: currentHooksPath, frameworkHooksDir };
}

// Per-tool adapters (aiteam/docs/provider-agnostic-improvements.md): thin
// pointers only — no duplicated rules — so AGENTS.md stays the single source of
// truth. Gemini CLI already has a dedicated GEMINI.md pointer and needs no
// adapter here. The block is appended to shared host files (.windsurfrules,
// .github/copilot-instructions.md) and recognized by its exact text, so changing
// the text means telling ensurePointerFile what the OLD text was: the previous
// wording goes to LEGACY_ADAPTER_POINTER_BLOCKS and is swapped in place.
export const ADAPTER_POINTER_BLOCK = `# rb-ai-team

Read and obey AGENTS.md (repo root, imports aiteam/AGENTS.md) and the active
persona under aiteam/agents/ before writing code. See
aiteam/docs/provider-agnostic-improvements.md for the enforcement portability
matrix: the runtime Tier-3 gate (aiteam/hooks/tier-guard.mjs, on Bash,
PowerShell, Monitor and the app terminal) is Claude-Code-specific, but the git
pre-push backstop (aiteam/githooks/pre-push) and the MCP tool tier gating
(aiteam/mcp/registry.ts) apply to any client that uses them.
`;

/** Every earlier wording of ADAPTER_POINTER_BLOCK that a consumer may still have. Oldest first. */
export const LEGACY_ADAPTER_POINTER_BLOCKS = [
  // 2026-07-04 .. 2026-10: "the runtime Tier-3 Bash gate" — before the gate covered PowerShell, Monitor and the app terminal.
  `# rb-ai-team

Read and obey AGENTS.md (repo root, imports aiteam/AGENTS.md) and the active
persona under aiteam/agents/ before writing code. See
aiteam/docs/provider-agnostic-improvements.md for the enforcement portability
matrix: the runtime Tier-3 Bash gate (aiteam/hooks/tier-guard.mjs) is
Claude-Code-specific, but the git pre-push backstop
(aiteam/githooks/pre-push) and the MCP tool tier gating
(aiteam/mcp/registry.ts) apply to any client that uses them.
`,
];

// Cursor's rule file is aiteam-owned (a dedicated filename under
// .cursor/rules/, not a file the host is likely to hand-edit), so it's written
// in full rather than append-only.
export const CURSOR_RULE_CONTENT = `---
description: rb-ai-team framework contract
alwaysApply: true
---

${ADAPTER_POINTER_BLOCK}`;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Append a pointer block (e.g. the aiteam adapter for a shared per-tool rules
// file like .windsurfrules or .github/copilot-instructions.md) without
// touching whatever the host already put there — mirrors ensureImportLine's
// non-clobbering, idempotent append for CLAUDE.md/AGENTS.md.
//
// `legacyBlocks` are earlier wordings of `block`: a file that has one gets it
// swapped for `block` in place (and any extra copies of it dropped) instead of
// a second block appended.
export function ensurePointerFile(content, block, legacyBlocks = []) {
  const text = content ?? "";
  // Compare line-ending-agnostically: the host file is CRLF on a Windows
  // checkout but `block` is authored with LF, so a raw substring match never
  // recognizes the block it wrote last run and appends a duplicate every time.
  // Only the COMPARISON is normalized — `text` is returned byte-for-byte.
  const nl = (s) => String(s).replace(/\r\n/g, "\n");
  if (nl(text).includes(nl(block).trim())) return text;

  const fresh = nl(block).trim();
  for (const old of legacyBlocks) {
    const oldText = nl(old).trim();
    if (!nl(text).includes(oldText)) continue;
    // The old block as it sits in this file: each newline may be \n or \r\n, and
    // the separator blank lines before it come along (so a dropped copy takes its
    // own separator with it, and the first one gives them back).
    const found = new RegExp(`(?:\\r?\\n)*${escapeRegExp(oldText).replace(/\n/g, "\\r?\\n")}`, "g");
    let first = true;
    return text.replace(found, (match) => {
      const lead = /^(?:\r?\n)*/.exec(match)[0];
      const eol = match.includes("\r\n") ? "\r\n" : "\n";
      if (!first) return "";
      first = false;
      return lead + fresh.replace(/\n/g, eol);
    });
  }

  if (text.trim() === "") return block;
  const sep = text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${sep}${block}`;
}

// The worktrees Claude Code creates for isolation: "worktree" subagents live
// inside the repo, under .claude/worktrees/<name>/ (issue 38).
export const WORKTREES_IGNORE = ".claude/worktrees/";
export const WORKTREES_IGNORE_COMMENT = "# Claude Code: worktrees dos subagentes (isolation: worktree) — rb-ai-team#38";

// The prints of the cards the Trello MCP downloads (aiteam/mcp/trello/attachments.ts): internal screens
// of the product and customer data of the team's board — never versioned (rb-ai-team#28/#50).
export const TRELLO_CACHE_IGNORE = ".trello-cache/";
export const TRELLO_CACHE_IGNORE_COMMENT = "# Trello MCP: prints dos cards baixados (telas internas e dados de cliente) — rb-ai-team#28";

/**
 * Make sure a .gitignore ignores `line`: append it (after `comment`, behind a
 * blank line) unless the file already covers it. Pure and idempotent; the host's
 * content and its line endings are kept byte for byte. "Covers" means the same
 * path spelled differently — `.claude/worktrees`, `/.claude/worktrees/`,
 * `.claude/worktrees/*` — while comments and `!` negations never count.
 */
export function ensureGitignoreEntry(content, line, comment) {
  const text = content ?? "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const bare = (l) => l.trim().replace(/^\//, "").replace(/\/\*{1,2}$/, "").replace(/\/+$/, "");
  const target = bare(line);
  const covered = text.split(/\r?\n/).some((l) => {
    const t = l.trim();
    if (t === "" || t.startsWith("#") || t.startsWith("!")) return false;
    return bare(t) === target;
  });
  if (covered) return text;
  const block = [...(comment ? [comment] : []), line].join(eol) + eol;
  if (text.trim() === "") return block;
  const base = /\r?\n$/.test(text) ? text : text + eol;
  return `${base}${eol}${block}`;
}

// The scratch workspace of the superpowers skills (SDD, executing-plans): a
// per-plan draft ledger the skill deletes itself, never a source of state
// (AGENTS.md §Memory Protocol, rb-ai-team#51). Git must not see it: a `git add -A`
// would turn a disposable ledger into history.
export const SUPERPOWERS_IGNORE = ".superpowers/";
export const SUPERPOWERS_IGNORE_COMMENT =
  "# superpowers: workspace de rascunho dos skills (SDD, executing-plans), nunca estado — rb-ai-team#51";

/** The rules the installer makes sure the root .gitignore carries, in the order it appends them. */
export const GITIGNORE_ENTRIES = Object.freeze([
  Object.freeze({ line: WORKTREES_IGNORE, comment: WORKTREES_IGNORE_COMMENT, why: "worktrees dos subagentes" }),
  Object.freeze({ line: TRELLO_CACHE_IGNORE, comment: TRELLO_CACHE_IGNORE_COMMENT, why: "prints baixados do Trello" }),
  Object.freeze({ line: SUPERPOWERS_IGNORE, comment: SUPERPOWERS_IGNORE_COMMENT, why: "workspace de rascunho do superpowers" }),
]);

/**
 * Run ensureGitignoreEntry over every rule, on one read of the file: each one is
 * appended only if the text so far does not cover it. Returns the new text and
 * the entries that were actually added (empty when nothing changed). Pure and
 * idempotent, like the function it chains.
 */
export function ensureGitignoreEntries(content, entries = GITIGNORE_ENTRIES) {
  let text = content ?? "";
  const added = [];
  for (const entry of entries) {
    const next = ensureGitignoreEntry(text, entry.line, entry.comment);
    if (next !== text) added.push(entry);
    text = next;
  }
  return { text, added };
}

// Append a call to the framework's hook into the host's existing hook script,
// preserving everything the host already had (the non-interference invariant).
// Idempotent — keyed on the framework hook path so re-running adds nothing.
export function ensureChainLine(content, frameworkHooksDir, hookName) {
  const marker = `${frameworkHooksDir}/${hookName}`;
  const call = `"$(git rev-parse --show-toplevel)/${frameworkHooksDir}/${hookName}" "$@"`;
  let text = content ?? "";
  if (text.includes(marker)) return text;
  if (text.trim() === "") text = "#!/usr/bin/env bash\n";
  else if (!text.endsWith("\n")) text += "\n";
  return `${text}# rb-ai-team: chain the framework ${hookName} hook (added by install.mjs)\n${call}\n`;
}

/**
 * Lê um arquivo que o installer consulta e que pode faltar — sem nunca lançar.
 * `existsSync` + `readFileSync` estourava com a stack do Node (EISDIR) quando o
 * caminho era uma pasta, e com EACCES quando o arquivo não tinha permissão de
 * leitura: o install inteiro caía no meio. Só ENOENT/ENOTDIR significam "falta";
 * o resto é "existe, mas não dá para ler", com o motivo, e quem chama avisa em
 * vez de tratar como ausente (semear por cima do que o dono tem seria errado).
 *
 * Puro: o fs chega por parâmetro (`statSync`, `readFileSync`), como no resto
 * deste módulo.
 *
 * @param {string} file
 * @param {{statSync: (p: string) => {isFile(): boolean}, readFileSync: (p: string, enc: "utf8") => string}} fsApi
 * @returns {{state: "ok", text: string} | {state: "missing"} | {state: "unreadable", reason: string}}
 */
export function readOptionalFile(file, fsApi) {
  const why = (err) => (err && typeof err === "object" && "code" in err && err.code ? String(err.code) : String(err?.message ?? err));
  let stat;
  try {
    stat = fsApi.statSync(file);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
    return code === "ENOENT" || code === "ENOTDIR" ? { state: "missing" } : { state: "unreadable", reason: why(err) };
  }
  if (!stat.isFile()) return { state: "unreadable", reason: "é uma pasta, não um arquivo" };
  try {
    return { state: "ok", text: fsApi.readFileSync(file, "utf8") };
  } catch (err) {
    return { state: "unreadable", reason: why(err) };
  }
}

/**
 * Decide se o installer deve semear o .claude/tier-rules.json do projeto. O
 * arquivo fica fora de aiteam/, então não viaja com o vendor; a cópia canônica
 * que viaja é aiteam/templates/tier-rules.json. Puro: o shell lê os dois
 * arquivos e grava o resultado.
 *
 * Só semeia quando o arquivo FALTA. O que existe é do projeto — customizado, ou
 * até quebrado — e nunca é sobrescrito: quem conserta o quebrado é o dono, o
 * guard protege pela cópia canônica enquanto isso e o doctor reprova.
 *
 * @param {string|null|undefined} existing conteúdo do arquivo do projeto; null/undefined = não existe
 * @param {string|null|undefined} template conteúdo do template do framework; null/vazio = não leu
 * @returns {{action: "seed", content: string} | {action: "noop"} | {action: "skip", reason: string}}
 */
export function planTierRulesSeed(existing, template) {
  if (typeof existing === "string") return { action: "noop" };
  if (typeof template !== "string" || template === "") {
    return { action: "skip", reason: "o template aiteam/templates/tier-rules.json está ausente ou ilegível (framework incompleto)" };
  }
  return { action: "seed", content: template };
}

/**
 * Decide se o installer deve criar o git remote da KB de infra. Puro: o shell
 * faz `git remote` e `git remote add`.
 * @param {{remote: string, url: string|null}|null} pointer
 * @param {string[]} existingRemotes
 */
export function planInfraRemote(pointer, existingRemotes) {
  if (!pointer) return { action: "skip", reason: "SPEC.md não declara infra_kb" };
  const remotes = (existingRemotes ?? []).map((r) => String(r).trim());
  if (remotes.includes(pointer.remote)) return { action: "noop", remote: pointer.remote };
  if (!pointer.url) {
    return {
      action: "skip",
      reason: `infra_kb.remote "${pointer.remote}" não existe e infra_kb.url não foi preenchida — adicione a url no SPEC.md ou crie o remote à mão`,
    };
  }
  return { action: "add", remote: pointer.remote, url: pointer.url };
}
