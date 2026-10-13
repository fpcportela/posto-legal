import { z } from "zod";
import { execFileSync } from "child_process";

export const TIER = 2;

export const schema = z.object({
  service: z.enum(["vercel", "railway"]).describe("Target preview deployment service"),
  branch: z.string().min(1).describe("Branch name to deploy"),
  dryRun: z.boolean().optional().default(false).describe("If true, validate config without deploying"),
});

export type DeployPreviewInput = z.infer<typeof schema>;

export function deployPreview(input: DeployPreviewInput): { success: boolean; url?: string; output: string } {
  const parsed = schema.parse(input);

  if (parsed.dryRun) {
    return { success: true, output: `[dry-run] Would deploy branch '${parsed.branch}' to ${parsed.service} preview` };
  }

  try {
    const [bin, ...args] =
      parsed.service === "vercel"
        ? ["vercel", "--yes"]
        : ["railway", "up", "--detach"];

    const out = execFileSync(bin, args, { encoding: "utf8" });
    const urlMatch = /https:\/\/[^\s]+/.exec(out);
    // No url key at all when there is none: `url?: string` does not accept an explicit undefined.
    return { success: true, ...(urlMatch ? { url: urlMatch[0] } : {}), output: out };
  } catch (err) {
    const e = err as { stdout?: string; message: string };
    return { success: false, output: e.stdout ?? e.message };
  }
}
