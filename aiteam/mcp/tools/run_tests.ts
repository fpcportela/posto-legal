import { z } from "zod";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { readCiBlock } from "../../src/ci-contract-core.mjs";
import { findPackageBin } from "./node-bin.js";
import { WorktreeRefused, isWithin, resolveWorktree } from "./worktree.js";

export const TIER = 1;

export const DESCRIPTION =
  "rb-ai-team Tier 1 tool — runs the test suite (vitest) in the app directory SPEC.md declares as ci.workdir " +
  "(the repository root by default). The server runs in the main checkout, so a task " +
  "isolated in a git worktree must pass that worktree's absolute path in `worktree`; without it the tests " +
  "run against the main checkout's files. Only the main checkout or a worktree of this repository is accepted.";

export const schema = z.object({
  pattern: z.string().optional().describe("Test file glob pattern (e.g. 'src/auth/**')"),
  watch: z.boolean().optional().default(false).describe("Run in watch mode"),
  worktree: z
    .string()
    .optional()
    .describe(
      "Absolute path of the worktree to run the tests in (the main checkout or a linked worktree of this " +
        "repository, as in `git worktree list`). Omit to run in the server's own checkout.",
    ),
});

// z.input, not z.infer: runTests() parses its input itself, so a caller leaves
// out what the schema defaults (watch).
export type RunTestsInput = z.input<typeof schema>;

/** The slice of `execFileSync` this tool uses; a test double stands in for it. */
export type ExecFile = (file: string, args?: readonly string[], options?: object) => string | Buffer;

/**
 * The vitest script, from the nearest `node_modules/vitest` at or above
 * `startDir` and not above `ceiling` (default: the repository). See
 * `findPackageBin`.
 */
export function findVitestBin(startDir: string, ceiling?: string): string | undefined {
  return findPackageBin(startDir, "vitest", "vitest", ceiling);
}

/**
 * `base` joined with the `ci.workdir` SPEC.md declares, when that directory
 * exists; `base` otherwise. The workdir is text from the repository, so its REAL
 * path (symlinks and junctions resolved) has to stay inside `base`: a link that
 * points out of the checkout is refused, not followed.
 */
function appDir(base: string): { dir: string } | { refused: string } {
  let declared: string;
  let dir: string;
  try {
    const block = readCiBlock(fs.readFileSync(path.join(base, "SPEC.md"), "utf8"));
    if (block.state !== "ok" || block.ci.workdir === "") return { dir: base };
    declared = block.ci.workdir;
    dir = path.join(base, ...declared.split("/"));
    if (!fs.statSync(dir).isDirectory()) return { dir: base };
  } catch {
    // No SPEC.md, or no such directory: the base itself.
    return { dir: base };
  }
  if (!isWithin(base, dir)) {
    return {
      refused:
        `ci.workdir "${declared}" in SPEC.md resolves outside the checkout (${fs.realpathSync.native(dir)}): ` +
        "a link that points out of the repository is refused. Declare a directory inside it.",
    };
  }
  return { dir };
}

export function runTests(input: RunTestsInput, execFile: ExecFile = execFileSync as ExecFile): { success: boolean; output: string } {
  const parsed = schema.parse(input);

  // The pattern is a file filter. Starting with `-` it would reach vitest as an
  // OPTION — `--config=<file>` loads and runs that file as JS, `--root`,
  // `--reporter=<module>` and friends likewise — so it is refused, not escaped.
  if (parsed.pattern?.startsWith("-")) {
    return {
      success: false,
      output: `pattern "${parsed.pattern}" starts with "-" and vitest would read it as an option, not as a file filter; pass a path or glob (e.g. "src/auth/**").`,
    };
  }

  let base: string;
  try {
    base = resolveWorktree(parsed.worktree) ?? process.cwd();
  } catch (err) {
    if (err instanceof WorktreeRefused) return { success: false, output: err.message };
    throw err;
  }
  const app = appDir(base);
  if ("refused" in app) return { success: false, output: app.refused };
  const cwd = app.dir;

  const vitest = findVitestBin(cwd);
  if (vitest === undefined) {
    return {
      success: false,
      output:
        `vitest not found: no node_modules/vitest in ${cwd} or any parent directory up to the repository root. ` +
        "Install the dependencies there (a task isolated in a worktree links the main checkout's with `node aiteam/scripts/worktree-link.mjs link`).",
    };
  }

  // The running node plus the package's own script, with an args array and no
  // shell: on Windows `npx` is `npx.cmd` and execFileSync without a shell never
  // finds it (ENOENT), and `shell: true` would hand the pattern to cmd.exe /
  // sh (CWE-78). The pattern stays a single argv entry.
  const args = [vitest, parsed.watch ? "--watch" : "run"];
  if (parsed.pattern) args.push(parsed.pattern);

  try {
    const out = execFile(process.execPath, args, { encoding: "utf8", stdio: "pipe", cwd, windowsHide: true });
    return { success: true, output: String(out) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return { success: false, output: e.stdout ?? e.stderr ?? e.message };
  }
}
