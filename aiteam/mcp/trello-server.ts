#!/usr/bin/env tsx
// Dedicated project-local MCP server exposing the Trello intake tools over stdio.
//
// Separate from aiteam/mcp/server.ts (rb-ai-team-tools) so the Trello credentials live
// only in this process. Reads are Tier 1; comment/move are Tier 2 (they mutate
// the user's board and are logged in the bead with `beads note` when used).
//
// Difference from the rb-ai-team server: Trello tools are async (HTTP + file
// download), so dispatch() is awaited. Output stays a text/JSON string — the
// downloaded print paths come back in the manifest and are read via the native
// Read tool (which can view images). No Tier-3 tools exist here.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOLS, dispatch } from "./trello/registry.js";
import { loadRootEnv } from "./trello/creds.js";

loadRootEnv();

const server = new McpServer({ name: "trello-tools", version: "0.1.0" });

for (const tool of TOOLS) {
  server.registerTool(
    tool.name,
    {
      // The tool's own description (registry.ts): "read-only" is not true of get_card and sync_list, which write the cache.
      description: tool.description ?? `Trello Tier ${tool.tier} tool.`,
      inputSchema: tool.schema.shape,
    },
    async (args: unknown) => {
      const result = await dispatch(tool.name, args, { allowTier3: false });
      return {
        content: [{ type: "text" as const, text: result.output }],
        isError: !result.ok,
      };
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[mcp] trello-tools server ready on stdio");
