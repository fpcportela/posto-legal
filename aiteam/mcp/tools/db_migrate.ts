import { z } from "zod";
import { execFileSync } from "child_process";
import { findPackageBin } from "./node-bin.js";

export const TIER = 3;
export const NEEDS_APPROVAL = true;

export const schema = z.object({
  direction: z.enum(["up", "down"]).describe("Migration direction"),
  steps: z.number().int().positive().optional().describe("Number of migration steps (default: all pending for 'up', 1 for 'down')"),
  dryRun: z.boolean().optional().default(false).describe("Print migration plan without executing SQL"),
  environment: z.enum(["local", "staging", "production"]).default("local"),
});

export type DbMigrateInput = z.infer<typeof schema>;

/** The slice of `execFileSync` this tool uses; a test double stands in for it. */
export type ExecFile = (file: string, args?: readonly string[], options?: object) => string | Buffer;

export function dbMigrate(input: DbMigrateInput, execFile: ExecFile = execFileSync as ExecFile): { success: boolean; output: string } {
  const parsed = schema.parse(input);

  // Down migrations in non-local environments require extra caution
  if (parsed.direction === "down" && parsed.environment === "production") {
    return {
      success: false,
      output: "DOWN migrations in production are blocked. Perform manual rollback with a DBA.",
    };
  }

  const stepsArgs = parsed.steps ? ["--steps", String(parsed.steps)] : [];

  let args: string[];
  if (parsed.dryRun) {
    args = ["migrate", "status"];
  } else if (parsed.direction === "up") {
    args = ["migrate", "deploy", ...stepsArgs];
  } else {
    // Prisma does not support migrate down natively; use reset only for local
    if (parsed.environment !== "local") {
      return { success: false, output: "DOWN migration only supported for local environment via this tool." };
    }
    args = ["migrate", "reset", "--force", ...stepsArgs];
  }

  // The running node plus the package's own script, with an args array and no
  // shell — as run_tests does with vitest. `execFileSync("npx")` never starts on
  // Windows (the executable is `npx.cmd`: ENOENT), and `npx prisma` DOWNLOADS
  // prisma from the registry when it is not installed, which for a Tier 3 tool
  // would run code from the network that nobody asked for. Without a prisma
  // installed in the repository the tool refuses instead. The Tier 3 gate itself
  // is the registry's (`needsApproval`), untouched.
  const prisma = findPackageBin(process.cwd(), "prisma", "prisma");
  if (prisma === undefined) {
    return {
      success: false,
      output:
        `prisma not found: no node_modules/prisma in ${process.cwd()} or any parent directory up to the repository root. ` +
        "Install the project's dependencies; this tool does not download prisma.",
    };
  }

  try {
    const out = execFile(process.execPath, [prisma, ...args], { encoding: "utf8", windowsHide: true });
    return { success: true, output: parsed.dryRun ? `[dry-run] Migration status:\n${String(out)}` : String(out) };
  } catch (err) {
    const e = err as { stdout?: string; message: string };
    return { success: false, output: e.stdout ?? e.message };
  }
}
