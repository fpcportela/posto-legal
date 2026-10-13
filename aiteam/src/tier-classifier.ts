import { classifyTier as classifyCore, isAskEligibleTier3 as askCore } from "./tier-core.mjs";
import { loadTierRulesWithFallback, type LoadedTierRules } from "./tier-rules-loader.mjs";
import { repoRoot } from "./repo-root.js";

export type { LoadedTierRules } from "./tier-rules-loader.mjs";

export type Tier = 1 | 2 | 3;

export interface TierBand {
  label: string;
  patterns: string[];
  /** Chat-approvable deploy subset — must be a subset of `patterns`. Only on tier3. */
  ask_patterns?: string[] | undefined;
  /** Deny reason per class (regex → advice), first match wins. Only on tier3. See explainDeny in tier-core.mjs. */
  deny_hints?: { match: string; hint: string }[] | undefined;
}

export interface TierRules {
  tier3: TierBand;
  tier2: TierBand;
}

/**
 * Load the tier->pattern map the way the PreToolUse hook
 * (aiteam/hooks/tier-guard.mjs) does — through the same loader,
 * `tier-rules-loader.mjs`, so the two can never disagree: the project's
 * .claude/tier-rules.json when it exists and is structurally valid, else the
 * framework's canonical copy (aiteam/templates/tier-rules.json). Resolved against
 * the repo root so it works when framework tooling runs from a vendored
 * subdirectory. `source` and `problem` say which map this is and why.
 */
export function loadTierRulesResolved(): LoadedTierRules {
  return loadTierRulesWithFallback(repoRoot());
}

/**
 * The map to classify with. Never an empty one: when the project's file is
 * missing or unusable this is the framework's canonical copy. Throws only when
 * that copy is unusable too (a broken vendor) — a caller that wants to degrade
 * reads `loadTierRulesResolved()` instead.
 */
export function loadTierRules(): TierRules {
  const { rules, detail } = loadTierRulesResolved();
  if (!rules) throw new Error(`tier-rules: no usable map — ${detail}`);
  return rules;
}

/**
 * Classify a shell command into a permission tier. Delegates to the shared,
 * dependency-free core in `tier-core.mjs` — the SAME module the runtime hook
 * uses — so this typed, unit-tested reference can never drift from the gate.
 *
 * Highest tier wins across sub-commands: `git push --force` is Tier 3 even when
 * chained after a Tier-1 command, while a Tier-3 string inside `echo "..."` is
 * Tier 1. See `tier-core.mjs` for the honest-scope caveat (not an adversarial
 * sandbox).
 */
export function classifyTier(command: string, rules: TierRules): Tier {
  return classifyCore(command, rules);
}

/**
 * Typed re-export of the ask-eligibility check (see tier-core.mjs for the
 * mixed-command and fail-closed semantics). Used by the PreToolUse guard to
 * decide ask-vs-deny for Tier-3 commands.
 */
export function isAskEligibleTier3(command: string, rules: TierRules): boolean {
  return askCore(command, rules);
}
