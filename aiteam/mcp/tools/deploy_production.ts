import { z } from "zod";
import { execFileSync } from "child_process";

export const TIER = 3;

// Tier 3 tools MUST be called only after receiving explicit human approval.
// The calling agent must set needsApproval=true and wait for confirmation before invoking this.
export const NEEDS_APPROVAL = true;

export const schema = z.object({
  service: z.enum(["vercel", "railway", "aws", "gcp"]).describe("Target production deployment platform"),
  branch: z.string().min(1).describe("Branch/tag to deploy to production"),
  confirmHash: z.string().length(7).describe("Last 7 chars of the git commit hash to deploy (prevents stale deploys)"),
  dryRun: z.boolean().optional().default(false).describe("Validate deployment config without executing"),
});

export type DeployProductionInput = z.infer<typeof schema>;

export function deployProduction(input: DeployProductionInput): { success: boolean; output: string } {
  const parsed = schema.parse(input);

  // Verify the commit hash matches HEAD to prevent deploying stale code
  const headShort = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  if (headShort !== parsed.confirmHash) {
    return {
      success: false,
      output: `Hash mismatch: confirmHash='${parsed.confirmHash}' but HEAD is '${headShort}'. Re-confirm the correct commit.`,
    };
  }

  if (parsed.dryRun) {
    return { success: true, output: `[dry-run] Would deploy ${headShort} to ${parsed.service} PRODUCTION` };
  }

  try {
    let bin: string;
    let args: string[];
    if (parsed.service === "vercel") {
      bin = "vercel";
      args = ["--prod", "--yes"];
    } else if (parsed.service === "railway") {
      bin = "railway";
      args = ["up", "--environment", "production", "--detach"];
    } else {
      return { success: false, output: `Service '${parsed.service}' requires manual deployment config. Add CLI command in deploy_production.ts.` };
    }

    const out = execFileSync(bin, args, { encoding: "utf8" });
    return { success: true, output: out };
  } catch (err) {
    const e = err as { stdout?: string; message: string };
    return { success: false, output: e.stdout ?? e.message };
  }
}
