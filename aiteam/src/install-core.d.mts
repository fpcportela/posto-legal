export interface HookEntry {
  matcher: string;
  hooks: { type?: string; command: string }[];
}

// Hook events with no `matcher` (they aren't scoped to a tool), e.g. SessionStart.
export interface UnscopedHookEntry {
  hooks: { type?: string; command: string }[];
}

export interface Settings {
  /** Filled only when the host hasn't set the key (baseRef: "fresh" | "head"). */
  worktree?: { baseRef?: string; [k: string]: unknown };
  permissions?: { deny?: string[]; [k: string]: unknown };
  hooks?: { PreToolUse?: HookEntry[]; SessionStart?: UnscopedHookEntry[]; [k: string]: unknown };
  [k: string]: unknown;
}

export interface MergedSettings {
  permissions: { deny: string[]; [k: string]: unknown };
  // Not optional: like PreToolUse, always populated in practice because
  // FRAMEWORK_SETTINGS.hooks always carries both keys (see install-core.mjs).
  hooks: { PreToolUse: HookEntry[]; SessionStart: UnscopedHookEntry[]; [k: string]: unknown };
  [k: string]: unknown;
}

export interface McpConfig {
  mcpServers?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface MergedMcp {
  mcpServers: Record<string, any>;
  [k: string]: unknown;
}

export type HookChainPlan =
  | { action: "set"; hooksPath: string }
  | { action: "noop"; hooksPath: string }
  | { action: "router"; hostHooksPath: string; frameworkHooksDir: string };

/** The framework's required .claude/settings.json wiring, merged into every consumer by install.mjs. */
export const FRAMEWORK_SETTINGS: {
  worktree: { baseRef: "fresh" | "head" };
  permissions: { deny: string[] };
  hooks: { PreToolUse: HookEntry[]; SessionStart: UnscopedHookEntry[] };
};

export function mergeDeny(hostDeny: string[] | undefined, frameworkDeny: string[] | undefined): string[];
export function ensurePreToolUseHook(entries: HookEntry[], command: string, matcher?: string): HookEntry[];
export function ensureHookCommand(entries: UnscopedHookEntry[], command: string): UnscopedHookEntry[];
export function mergeSettings(host: Settings, framework: Settings): MergedSettings;
export function mergeMcpServers(host: McpConfig, framework: McpConfig): MergedMcp;
/** The framework servers the host does not register yet: what mergeMcpServers would add, in the framework's order. */
export function mcpServersAdded(host: McpConfig | null | undefined, framework: McpConfig): string[];
/** `<file> — added the <a> and <b> servers` (or `… the <a> server`), naming only what the merge adds. */
export function mcpAddedLabel(file: string, host: McpConfig | null | undefined, framework: McpConfig): string;
export function ensureImportLine(content: string, importLine: string): string;
export function planHookChaining(currentHooksPath: string, frameworkHooksDir: string): HookChainPlan;
export function ensureChainLine(content: string, frameworkHooksDir: string, hookName: string): string;
/** `legacyBlocks`: earlier wordings of `block`, swapped in place (extra copies dropped) instead of appending a second block. */
export function ensurePointerFile(content: string | undefined, block: string, legacyBlocks?: readonly string[]): string;
/** The thin AGENTS.md pointer appended to shared per-tool rules files (.windsurfrules, .github/copilot-instructions.md). */
export const ADAPTER_POINTER_BLOCK: string;
/** Every earlier wording of ADAPTER_POINTER_BLOCK that a consumer may still have, oldest first. */
export const LEGACY_ADAPTER_POINTER_BLOCKS: readonly string[];
/** The Cursor rule file, written in full: front matter + ADAPTER_POINTER_BLOCK. */
export const CURSOR_RULE_CONTENT: string;
/** Where Claude Code puts the worktrees of `isolation: "worktree"` subagents (relative to the repo root). */
export const WORKTREES_IGNORE: ".claude/worktrees/";
export const WORKTREES_IGNORE_COMMENT: string;
export const TRELLO_CACHE_IGNORE: ".trello-cache/";
export const TRELLO_CACHE_IGNORE_COMMENT: string;
/** Append `line` (after `comment`) to a .gitignore unless it already covers it. Idempotent, keeps the host's line endings. */
export function ensureGitignoreEntry(content: string | null | undefined, line: string, comment?: string): string;
/** The scratch workspace of the superpowers skills (relative to the repo root): a draft, never state. */
export const SUPERPOWERS_IGNORE: ".superpowers/";
export const SUPERPOWERS_IGNORE_COMMENT: string;
/** A rule the installer keeps in the root .gitignore: the line, its comment and what it is for. */
export interface GitignoreEntry {
  readonly line: string;
  readonly comment: string;
  readonly why: string;
}
/** The rules the installer makes sure the root .gitignore carries, in the order it appends them. */
export const GITIGNORE_ENTRIES: readonly GitignoreEntry[];
/** ensureGitignoreEntry over every rule on one read: the new text and the entries actually added. */
export function ensureGitignoreEntries(
  content: string | null | undefined,
  entries?: readonly GitignoreEntry[],
): { text: string; added: GitignoreEntry[] };
/** The hooks the installer chains into a host that has its own core.hooksPath. */
export const CHAINED_HOOKS: readonly string[];
/** Resolve a host hook file, honouring a relative OR absolute core.hooksPath. */
export function resolveHookPath(root: string, hooksPath: string, hook: string): string;

export type TierRulesSeedPlan =
  | { action: "seed"; content: string; reason?: undefined }
  | { action: "noop"; content?: undefined; reason?: undefined }
  | { action: "skip"; content?: undefined; reason: string };

export type OptionalFile = { state: "ok"; text: string } | { state: "missing" } | { state: "unreadable"; reason: string };
/** Reads a file the installer consults and that may be absent, never throwing: only ENOENT/ENOTDIR are "missing" — a folder or EACCES is "unreadable", with the reason. */
export function readOptionalFile(
  file: string,
  fsApi: { statSync: (p: string) => { isFile(): boolean }; readFileSync: (p: string, enc: "utf8") => string },
): OptionalFile;

/**
 * Decide se o installer semeia o .claude/tier-rules.json a partir de aiteam/templates/tier-rules.json.
 * Só semeia quando o arquivo do projeto falta; o que existe (customizado ou quebrado) nunca é sobrescrito.
 */
export function planTierRulesSeed(existing: string | null | undefined, template: string | null | undefined): TierRulesSeedPlan;

export type InfraRemotePlan =
  | { action: "skip"; reason?: string }
  | { action: "noop"; remote: string; reason?: undefined }
  | { action: "add"; remote: string; url: string; reason?: undefined };

export type { InfraKbPointer } from "./infra-kb-core.d.mts";

/** Decide whether to create the infra KB git remote. Pure function — I/O happens in install.mjs. */
export function planInfraRemote(pointer: import("./infra-kb-core.d.mts").InfraKbPointer | null, existingRemotes: string[]): InfraRemotePlan;
