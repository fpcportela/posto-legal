#!/usr/bin/env tsx
// Project-local MCP server exposing the rb-ai-team tools over stdio.
//
// Topology (Blueprint 8.9): ONE project-local server per repo — it ships with
// the template, needs no global install, and its tools act on the repo's own
// working tree (.beads, git, package.json). A global/shared server would lose
// that per-repo context, so project-local is the default; document a global
// server only if you later need to share tools across many repos.
//
// Every call is mediated by registry.dispatch(): inputs are Zod-validated and
// Tier-3 tools return approval-required unless SPEC.md allows Tier 3 — so
// `needsApproval` is a real runtime gate, not a constant.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOLS, dispatch, allowTier3FromSpec } from "./registry.js";

const server = new McpServer({ name: "rb-ai-team-tools", version: "0.1.0" });

for (const tool of TOOLS) {
  const approvalNote = tool.needsApproval ? " — requires human approval (Tier 3)" : "";
  server.registerTool(
    tool.name,
    {
      description: tool.description ?? `rb-ai-team Tier ${tool.tier} tool${approvalNote}.`,
      inputSchema: tool.schema.shape,
    },
    async (args: unknown) => {
      const result = dispatch(tool.name, args, { allowTier3: allowTier3FromSpec() });
      return {
        content: [{ type: "text" as const, text: result.output }],
        isError: !result.ok,
      };
    }
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[mcp] rb-ai-team-tools server ready on stdio");
