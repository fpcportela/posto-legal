import * as fs from "fs";
import * as path from "path";
import type { z } from "zod";
import { repoRoot } from "../src/repo-root.js";
import { allowTier3FromSpec as allowTier3FromSpecText } from "../src/tier-core.mjs";

import {
  TIER as RUN_TESTS_TIER,
  DESCRIPTION as RUN_TESTS_DESCRIPTION,
  schema as runTestsSchema,
  runTests,
} from "./tools/run_tests.js";
import {
  TIER as GIT_COMMIT_TIER,
  DESCRIPTION as GIT_COMMIT_DESCRIPTION,
  schema as gitCommitSchema,
  gitCommit,
} from "./tools/git_commit.js";
import { TIER as DEPLOY_PREVIEW_TIER, schema as deployPreviewSchema, deployPreview } from "./tools/deploy_preview.js";
import {
  TIER as DB_MIGRATE_TIER,
  NEEDS_APPROVAL as DB_MIGRATE_APPROVAL,
  schema as dbMigrateSchema,
  dbMigrate,
} from "./tools/db_migrate.js";
import {
  TIER as DEPLOY_PROD_TIER,
  NEEDS_APPROVAL as DEPLOY_PROD_APPROVAL,
  schema as deployProductionSchema,
  deployProduction,
} from "./tools/deploy_production.js";

export interface ToolDef {
  name: string;
  tier: 1 | 2 | 3;
  needsApproval: boolean;
  /** What the server tells the model about the tool; absent → a generic "Tier N tool" line. */
  description?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: z.ZodObject<any>;
  run: (input: unknown) => { success: boolean; output: string };
}

/**
 * Pairs a tool's schema with its function. `dispatch()` runs `run` only on data
 * that `schema` already accepted, so narrowing the registry's `unknown` input to
 * the schema's own output type here is the one cast, in one place, instead of a
 * mismatch at every entry of `TOOLS`.
 */
function defineTool<S extends z.ZodObject<z.ZodRawShape>>(
  def: Omit<ToolDef, "schema" | "run"> & {
    schema: S;
    run: (input: z.output<S>) => { success: boolean; output: string };
  },
): ToolDef {
  return { ...def, run: (input) => def.run(input as z.output<S>) };
}

/** All MCP tools, normalized into one registry the server iterates over. */
export const TOOLS: ToolDef[] = [
  defineTool({ name: "run_tests", tier: RUN_TESTS_TIER as 1, needsApproval: false, description: RUN_TESTS_DESCRIPTION, schema: runTestsSchema, run: runTests }),
  defineTool({ name: "git_commit", tier: GIT_COMMIT_TIER as 2, needsApproval: false, description: GIT_COMMIT_DESCRIPTION, schema: gitCommitSchema, run: gitCommit }),
  defineTool({ name: "deploy_preview", tier: DEPLOY_PREVIEW_TIER as 2, needsApproval: false, schema: deployPreviewSchema, run: deployPreview }),
  defineTool({ name: "db_migrate", tier: DB_MIGRATE_TIER as 3, needsApproval: DB_MIGRATE_APPROVAL, schema: dbMigrateSchema, run: dbMigrate }),
  defineTool({ name: "deploy_production", tier: DEPLOY_PROD_TIER as 3, needsApproval: DEPLOY_PROD_APPROVAL, schema: deployProductionSchema, run: deployProduction }),
];

export interface DispatchResult {
  ok: boolean;
  approvalRequired?: boolean;
  output: string;
}

export interface DispatchOptions {
  allowTier3?: boolean;
  tools?: ToolDef[];
}

/**
 * Read SPEC.md frontmatter `tier_defaults.allow_tier3` (defaults false).
 * Delegates to the shared tier-core reader, the same one behind the Bash
 * tier-guard and the pre-push backstop, so the MCP Tier-3 gate can't drift
 * from them on what "approved" means. Its own copy of the regex did drift: it
 * never matched a CRLF SPEC.md (rb-ai-team#36).
 */
export function allowTier3FromSpec(): boolean {
  try {
    return allowTier3FromSpecText(fs.readFileSync(path.resolve(repoRoot(), "SPEC.md"), "utf8"));
  } catch {
    return false;
  }
}

/**
 * Validate and run a registered tool, enforcing the permission tier. Tier-3 /
 * `needsApproval` tools return an approval-required result WITHOUT executing
 * unless Tier 3 is explicitly allowed — making `needsApproval` a real runtime
 * gate rather than a constant. Input is Zod-validated before the tool runs.
 */
export function dispatch(name: string, input: unknown, opts: DispatchOptions = {}): DispatchResult {
  const tools = opts.tools ?? TOOLS;
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return { ok: false, output: `Unknown tool: ${name}` };
  }

  const allowTier3 = opts.allowTier3 ?? false;
  if ((tool.tier === 3 || tool.needsApproval) && !allowTier3) {
    return {
      ok: false,
      approvalRequired: true,
      output:
        `Tool "${name}" is Tier 3 (critical) and requires explicit human approval. ` +
        `Set tier_defaults.allow_tier3: true in SPEC.md after approval to permit it.`,
    };
  }

  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, output: `Invalid input for "${name}": ${parsed.error.message}` };
  }

  const result = tool.run(parsed.data);
  return { ok: result.success, output: result.output };
}
