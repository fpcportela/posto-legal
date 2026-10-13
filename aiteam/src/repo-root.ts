import { execFileSync } from "child_process";
import { existsSync } from "fs";
import * as path from "path";

// Cache the git toplevel per cwd so repeated reads (the breaker runs per call)
// don't spawn `git` every time. The override is read fresh and never cached.
const gitTopByCwd = new Map<string, string>();

/**
 * Resolve the host repository root for framework-STATE reads — `SPEC.md`,
 * `.beads/*`, `.claude/tier-rules.json`, the session/cost logs. These live at
 * the repo root, but framework tooling may run with a different cwd (e.g.
 * `aiteam/` once the framework is vendored into a host project). Anchoring on
 * the git toplevel instead of `process.cwd()` keeps those reads correct no
 * matter where the process was started.
 *
 * Note: this is for framework state only. Host operations (the MCP
 * `git_commit`/`run_tests` tools, the Bead Board's `git worktree list`) keep
 * acting on the host repo via cwd/git — do not route those through here.
 *
 * Resolution order: `RB_REPO_ROOT` override → `git rev-parse --show-toplevel`
 * → `process.cwd()`.
 */
export function repoRoot(): string {
  const override = process.env["RB_REPO_ROOT"];
  if (override) return override;
  return gitToplevel(process.cwd());
}

/**
 * Whether `root` (default: the host repo root) is the framework's own repo
 * (rb-ai-team) and not a consumer that vendored `aiteam/`. The marker is the
 * aiteam-sync manifest: `tools/` lives at the root, outside `aiteam/`, so the
 * vendor does not carry it — and a consumer's own `tools/` is not the marker.
 *
 * For tests that assert a property of the HOST repo (its `SPEC.md`, its
 * `.claude/tier-rules.json`): the suite of `aiteam/` runs in every consumer
 * too, where the root belongs to the project (rb-ai-team#27, #36, #60, #62).
 */
export function isUpstream(root: string = repoRoot()): boolean {
  return existsSync(path.join(root, "tools", "aiteam-sync", "manifest.json"));
}

// The git toplevel of `dir`, or `dir` itself when it is not inside a repo.
function gitToplevel(dir: string): string {
  const cached = gitTopByCwd.get(dir);
  if (cached !== undefined) return cached;

  let resolved = dir;
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (top) resolved = top;
  } catch {
    // Not a git repo (or `dir` does not exist) — fall back to `dir`.
  }

  gitTopByCwd.set(dir, resolved);
  return resolved;
}

/**
 * Where the scaffolding scripts (`generate-spec`, `bootstrap-beads`) write when
 * no directory is given: the root of the repo the user is in, never the
 * vendored `aiteam/` that npm makes the cwd of `npm --prefix aiteam run …`.
 *
 * Resolution order: explicit `arg` → `RB_REPO_ROOT` → the git toplevel of
 * `INIT_CWD` (the directory npm was started from, so a framework that is not
 * vendored still scaffolds the repo you ran it in) → the git toplevel of cwd.
 * An `INIT_CWD` outside any repo is used as is.
 */
export function defaultTargetDir(
  arg: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  if (arg) return path.resolve(arg);
  const override = env["RB_REPO_ROOT"];
  if (override) return path.resolve(override);
  const initCwd = env["INIT_CWD"];
  return path.resolve(gitToplevel(initCwd ? path.resolve(initCwd) : cwd));
}
