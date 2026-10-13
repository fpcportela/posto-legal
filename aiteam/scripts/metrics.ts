#!/usr/bin/env tsx
// Reduce .beads/session-log.ndjson to the Blueprint 8.6 headline metrics.
// Usage: npm run metrics [path/to/session-log.ndjson]

import * as fs from "fs";
import * as path from "path";
import { reduceMetrics } from "../src/session-log.js";
import { repoRoot } from "../src/repo-root.js";

const logPath =
  process.argv[2] ?? path.resolve(repoRoot(), ".beads", "session-log.ndjson");

if (!fs.existsSync(logPath)) {
  console.error(`No session log at ${logPath} — nothing to report yet.`);
  process.exit(0);
}

const m = reduceMetrics(fs.readFileSync(logPath, "utf8"));

console.log(`Session metrics (${logPath}):`);
console.log(`  model calls     : ${m.model_calls}`);
console.log(`  tool calls      : ${m.tool_calls}`);
console.log(`  circuit breaks  : ${m.circuit_breaks}`);
console.log(`  budget warnings : ${m.budget_warns}`);
console.log(`  input tokens    : ${m.input_tokens}`);
console.log(`  output tokens   : ${m.output_tokens}`);
console.log(`  total cost (USD): $${m.cost_usd.toFixed(4)}`);
