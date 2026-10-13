import { z } from "zod";
import { execFileSync } from "child_process";
import { WorktreeRefused, resolveWorktree } from "./worktree.js";

export const TIER = 2;

export const DESCRIPTION =
  "rb-ai-team Tier 2 tool — stages the given files and commits them. The server runs in the main checkout, " +
  "so a task isolated in a git worktree must pass that worktree's absolute path in `worktree`; without it " +
  "the commit lands in the main checkout. Only the main checkout or a worktree of this repository is accepted.";

export const schema = z.object({
  message: z.string().min(1).describe("Commit message"),
  files: z.array(z.string()).min(1).describe("File paths to stage (relative to the checkout the commit runs in)"),
  dryRun: z.boolean().optional().default(false).describe("If true, stage files but do not commit"),
  worktree: z
    .string()
    .optional()
    .describe(
      "Absolute path of the worktree to commit in (the main checkout or a linked worktree of this repository, " +
        "as in `git worktree list`). Omit to commit in the server's own checkout.",
    ),
});

// z.input, not z.infer: gitCommit() parses its input itself, so a caller leaves
// out what the schema defaults (dryRun).
export type GitCommitInput = z.input<typeof schema>;

export function gitCommit(input: GitCommitInput): { success: boolean; output: string } {
  const parsed = schema.parse(input);

  let cwd: string | undefined;
  try {
    cwd = resolveWorktree(parsed.worktree);
  } catch (err) {
    if (err instanceof WorktreeRefused) return { success: false, output: err.message };
    throw err;
  }

  // execFileSync runs git directly without a shell, so message/path contents
  // can never be interpreted as shell syntax. `--` stops option parsing so a
  // path like "-rf" is treated as a pathspec, not a flag (CWE-78).
  execFileSync("git", ["add", "--", ...parsed.files], { stdio: "pipe", cwd });

  if (parsed.dryRun) {
    const diff = execFileSync("git", ["diff", "--cached", "--stat"], { encoding: "utf8", cwd });
    return { success: true, output: `[dry-run] Would commit:\n${diff}` };
  }

  const out = execFileSync("git", ["commit", "-m", parsed.message], { encoding: "utf8", cwd });
  return { success: true, output: out };
}
