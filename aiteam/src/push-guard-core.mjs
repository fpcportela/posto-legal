// Pure, dependency-free core for the pre-push guard (portable backstop, Blueprint
// 8/provider-agnostic follow-up). Native git pre-push hooks receive ref updates
// on stdin, not the raw command line, so this cannot reuse the Bash tier-core.mjs
// regex classifier (there is no command string to match against). Instead it
// detects the same Tier-3 event structurally: a non-fast-forward update to a
// protected branch — exactly what `git push --force`/`--force-with-lease`
// produce — via an injected `isAncestor` check so this stays testable without a
// real git repo. The CLI shell (aiteam/scripts/pre-push-guard.ts) supplies
// `isAncestor` backed by `git merge-base --is-ancestor`.

export const ZERO_SHA = "0".repeat(40);

/** Parse pre-push hook stdin (`<local ref> <local sha> <remote ref> <remote sha>` per line). */
export function parseRefUpdates(stdinText) {
  return String(stdinText ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/);
      return { localRef, localSha, remoteRef, remoteSha };
    });
}

export function isProtectedRef(remoteRef, protectedBranches = ["main", "master"]) {
  return protectedBranches.some((b) => remoteRef === `refs/heads/${b}`);
}

/**
 * Classify one ref update. Tier 3 only when the target is a protected branch
 * that already exists and the push is not a fast-forward (i.e. rewrites
 * history the remote already has) — branch deletions and brand-new branches
 * are not rewrites and stay Tier 1.
 */
export function classifyRefUpdate(update, { isAncestor, protectedBranches } = {}) {
  const { remoteRef, remoteSha, localSha } = update;
  if (localSha === ZERO_SHA) return 1;
  if (!isProtectedRef(remoteRef, protectedBranches)) return 1;
  if (remoteSha === ZERO_SHA) return 1;
  return isAncestor(remoteSha, localSha) ? 1 : 3;
}

export function classifyPush(stdinText, opts) {
  return parseRefUpdates(stdinText).map((update) => ({ update, tier: classifyRefUpdate(update, opts) }));
}
