export interface DenyHint {
  /** Case-insensitive JS regex, tested against the sub-command that blocks. */
  match: string;
  /** Advice the guard gives instead of the break-glass instruction. */
  hint: string;
}

export interface TierBand {
  label: string;
  patterns: string[];
  /** Chat-approvable deploy subset — must be a subset of `patterns`. Only meaningful on tier3. */
  ask_patterns?: string[] | undefined;
  /** Deny reason per class, first match wins. Only meaningful on tier3; malformed entries are ignored. */
  deny_hints?: DenyHint[] | undefined;
}

export interface TierRules {
  tier3: TierBand;
  tier2: TierBand;
}

// PATTERN CACHE — read this before reusing a rules object across calls. The compiled
// RegExps of `tier3.patterns`, `tier3.ask_patterns` and `tier2.patterns` are cached per
// LIST, keyed by the IDENTITY of the array object (a WeakMap), not by its contents. If
// you change a pattern IN PLACE (push, splice, assigning into the same array) after the
// list was first used, the OLD compiled patterns keep applying and the change is
// silently ignored. To change a pattern, hand over a NEW array (or a new rules object).
// The tier-guard hook loads the rules once per run and never notices; this matters to
// long-lived callers (tests, servers). `deny_hints` is not cached: it is compiled on
// each denial. Pinned in tier-core.test.ts.

export function splitSubCommands(command: string): string[];
/** How many entries of a pattern list the guard can apply: the non-blank strings that compile with `new RegExp(p, "i")`. An empty or whitespace-only entry matches every command, so the guard skips it. */
export function countCompilablePatterns(list: unknown): number;
/** Highest tier among the sub-commands. Patterns are cached by the identity of each list: see PATTERN CACHE at the top of this file. */
export function classifyTier(command: string, rules: TierRules): 1 | 2 | 3;
/**
 * Patterns are cached by the identity of each list: see PATTERN CACHE at the top of this file. A sub-command is ask-eligible
 * only when EVERY `tier3.patterns` entry that matches it is itself listed in `ask_patterns` (by identity of the string): an
 * ask_pattern that is not a tier3.patterns entry promotes nothing, whatever it matches (A3).
 */
export function isAskEligibleTier3(command: string, rules: TierRules): boolean;
/**
 * The sub-command that blocks a denied command and the advice for its class: the mixed-deploy advice, a
 * `tier3.deny_hints` class reason, the doctor pointer when `tier3.ask_patterns` has entries the guard skips, or
 * the break-glass instruction.
 */
export function explainDeny(command: string, rules: TierRules): { culprit: string; hint: string };
/**
 * The fixed floor alone (recursive+force `rm`, `git push --force`), no rules: the first sub-command it denies, or null.
 * What the tier-guard hook applies when something unexpected throws. Never throws; if the splitter fails it falls back
 * to the whole text (coarser, never looser).
 */
export function floorDenyCulprit(command: unknown, options?: { split?: (command: string) => string[] }): string | null;
/** Patterns are cached by the identity of each list: see PATTERN CACHE at the top of this file. */
export function guardDecision(
  command: string,
  rules: TierRules,
  allowTier3: boolean
): "allow" | "ask" | "deny";
/**
 * The `tier_defaults.allow_tier3` break-glass of SPEC.md's frontmatter, read line by line (an approximation of where
 * YAML puts the key, not a parse). false for anything it cannot read with certainty: no frontmatter, a quoted scalar
 * or `[`/`{` collection that crosses lines, a column-0 line that is not `key:`, tab indentation, U+2028/U+2029.
 */
export function allowTier3FromSpec(specText: string | undefined): boolean;
/**
 * allowTier3FromSpec with the reason it read false: `why` names what kept it off (a value that continues on the next
 * line, a quoted string across lines, a tab, no `allow_tier3` line under `tier_defaults:`, ...), or is null when the flag
 * is on, there is no frontmatter, or the `allow_tier3` there is not the bare boolean `true` (a plain `false`).
 */
export function readAllowTier3(specText: string | null | undefined): { allowed: boolean; why: string | null };
