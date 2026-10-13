import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/** Thrown when a requested worktree path is not one the server may act on. */
export class WorktreeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeRefused";
  }
}

/**
 * Canonical spelling of a path for comparison: symlinks, junctions and 8.3 short
 * names resolved, one separator, no trailing slash, and — on Windows, where the
 * filesystem ignores case — lower-cased, so `C:\Repo` and `c:/repo/` are one path.
 * A path that does not exist has no canonical form and never matches.
 */
function canonical(p: string): string | undefined {
  let real: string;
  try {
    real = fs.realpathSync.native(p);
  } catch {
    return undefined;
  }
  const slashed = real.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

/**
 * Whether `dir` is `root` or sits inside it, comparing REAL paths: a symlink or a
 * junction inside `root` that points elsewhere is not inside it. Both have to
 * exist.
 */
export function isWithin(root: string, dir: string): boolean {
  const r = canonical(root);
  const d = canonical(dir);
  return r !== undefined && d !== undefined && (d === r || d.startsWith(`${r}/`));
}

/** The git toplevel of `dir` (`git rev-parse --show-toplevel`, no shell), or `undefined` outside a repository. */
function gitToplevel(dir: string): string | undefined {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return top === "" ? undefined : top;
  } catch {
    return undefined;
  }
}

/**
 * Whether `dir` is the root of a git checkout — `git rev-parse --show-toplevel`
 * run there answers with `dir` itself. A directory that merely sits INSIDE a
 * checkout (or inside none) is not: a `git commit` with that cwd would land in
 * whichever repository contains it. git runs without a shell.
 */
export function isCheckoutRoot(dir: string): boolean {
  const wanted = canonical(dir);
  if (wanted === undefined) return false;
  const top = gitToplevel(dir);
  return top !== undefined && canonical(top) === wanted;
}

/**
 * The highest directory a search that starts at `dir` may climb to: the main
 * checkout of the repository when `dir` sits inside it (a worktree under
 * `.claude/worktrees/` still sees a `node_modules` hoisted in the main checkout),
 * else the git toplevel of `dir`, else `dir` itself. Never a directory outside
 * the repository, so nothing above the repo (the home directory, another
 * project) is ever picked up.
 */
export function checkoutCeiling(dir: string): string {
  const main = listWorktrees(dir)[0];
  if (main !== undefined && isWithin(main, dir)) return main;
  const top = gitToplevel(dir);
  return top !== undefined && isWithin(top, dir) ? top : dir;
}

/**
 * The checkouts of the repository `cwd` belongs to, from `git worktree list
 * --porcelain`: the main checkout first, then every linked worktree. Bare
 * entries are skipped (nothing to commit in), and so are `prunable` ones: git
 * keeps listing a worktree whose directory is gone until `git worktree prune`,
 * and a directory later recreated at that path is not that worktree. git runs
 * without a shell.
 */
export function listWorktrees(cwd: string = process.cwd()): string[] {
  let out: string;
  try {
    out = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const block of out.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const head = lines.find((l) => l.startsWith("worktree "));
    // `prunable` carries a reason after it ("prunable gitdir file points to non-existent location").
    if (!head || lines.includes("bare") || lines.some((l) => l === "prunable" || l.startsWith("prunable "))) continue;
    found.push(head.slice("worktree ".length));
  }
  return found;
}

/**
 * Validate the `worktree` parameter of the MCP tools that run git/npm (issue 38).
 *
 * - omitted → `undefined`: the tool keeps acting on the server's own cwd.
 * - given → it must be the ABSOLUTE root of the main checkout or of a linked
 *   worktree of the repository the server runs in, as `git worktree list` knows
 *   them. Anything else — another repo, a subdirectory, a relative path, a
 *   directory git no longer tracks — throws `WorktreeRefused`. Returns the path
 *   in its canonical on-disk spelling, to use as `cwd`.
 *
 * The server runs in the main checkout, so a subagent isolated in a worktree
 * would otherwise commit there; and an unchecked path would let any caller aim
 * `git commit` at an arbitrary repository on the machine.
 */
export function resolveWorktree(requested: string | undefined, serverCwd: string = process.cwd()): string | undefined {
  if (requested === undefined) return undefined;

  if (requested === "" || !path.isAbsolute(requested)) {
    throw new WorktreeRefused(`worktree must be an absolute path (got "${requested}")`);
  }

  const wanted = canonical(requested);
  if (wanted !== undefined) {
    for (const candidate of listWorktrees(serverCwd)) {
      if (canonical(candidate) !== wanted) continue;
      // Listed is not enough: the directory must still BE that checkout's root (not
      // a directory recreated over it, which would send git to another repository).
      if (isCheckoutRoot(requested)) return fs.realpathSync.native(requested);
      throw new WorktreeRefused(
        `worktree "${requested}" is listed by git, but that directory is not the root of a checkout ` +
          `(was it deleted and recreated? run \`git worktree prune\` and add the worktree again)`,
      );
    }
  }

  throw new WorktreeRefused(
    `worktree "${requested}" is not the main checkout or a worktree of this repository ` +
      `(see \`git worktree list\`); pass the root directory of one of them`,
  );
}
