#!/usr/bin/env node
/**
 * pre-push-guard.ts — portable Tier-3 backstop for force-push to protected
 * branches (main/master).
 *
 * Git's native pre-push hook receives ref updates on stdin, not the command
 * line, so it cannot reuse the Bash tier-core.mjs regex classifier (there is
 * no command string to match `--force` against). Instead
 * src/push-guard-core.mjs detects the same Tier-3 event structurally: a
 * non-fast-forward update to a protected branch — exactly what
 * `git push --force`/`--force-with-lease` produce — and this script gates it
 * behind the same SPEC.md `tier_defaults.allow_tier3` flag the Bash hook uses
 * (via the shared `allowTier3FromSpec`), so "approved" can never drift between
 * the two gates.
 *
 * Usage (wired by aiteam/githooks/pre-push): npx tsx scripts/pre-push-guard.ts
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { classifyPush } from "../src/push-guard-core.mjs";
import { allowTier3FromSpec } from "../src/tier-core.mjs";
import { repoRoot } from "../src/repo-root.js";

function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function isAncestor(ancestorSha: string, descendantSha: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestorSha, descendantSha], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function allowTier3(): boolean {
  try {
    return allowTier3FromSpec(fs.readFileSync(path.resolve(repoRoot(), "SPEC.md"), "utf8"));
  } catch {
    return false;
  }
}

const blocked = classifyPush(readStdin(), { isAncestor }).filter((r) => r.tier === 3);

if (blocked.length && !allowTier3()) {
  console.error(
    "[pre-push] Tier 3 (critical) blocked: force-push (non-fast-forward) to a protected branch:"
  );
  for (const { update } of blocked) {
    console.error(`  ${update.localRef} -> ${update.remoteRef} (would rewrite ${update.remoteSha.slice(0, 8)}…)`);
  }
  console.error(
    "Set tier_defaults.allow_tier3: true in SPEC.md after explicit human approval to permit it."
  );
  process.exit(1);
}

process.exit(0);
