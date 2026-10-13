import * as fs from "fs";
import * as path from "path";
import { repoRoot } from "./repo-root.js";

/**
 * One structured run-log event. Appended as a single JSON line to
 * `.beads/session-log.ndjson` (Blueprint 8.6). Never log prompt content or
 * secrets — only token counts, ids, and costs.
 */
export interface SessionEvent {
  ts?: string;
  session?: string;
  event: "model_call" | "tool_call" | "circuit_open" | "budget_warn";
  model?: string;
  tool?: string;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  cumulative_usd?: number;
}

export interface Metrics {
  model_calls: number;
  tool_calls: number;
  circuit_breaks: number;
  budget_warns: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

const LOG_PATH = () => path.resolve(repoRoot(), ".beads", "session-log.ndjson");

/** Append one event as an NDJSON line. Best-effort — never throws. */
export function logEvent(event: SessionEvent): void {
  const enriched: SessionEvent = {
    ts: event.ts ?? new Date().toISOString(),
    session: event.session ?? process.env["AI_SESSION_ID"] ?? "default",
    ...event,
  };
  try {
    fs.appendFileSync(LOG_PATH(), JSON.stringify(enriched) + "\n", "utf8");
  } catch {
    // Non-fatal — logging must never break an API call.
  }
}

/** Reduce an NDJSON log (string body) to the four headline metrics. */
export function reduceMetrics(ndjson: string): Metrics {
  const metrics: Metrics = {
    model_calls: 0,
    tool_calls: 0,
    circuit_breaks: 0,
    budget_warns: 0,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
  };

  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let e: SessionEvent;
    try {
      e = JSON.parse(trimmed) as SessionEvent;
    } catch {
      continue;
    }
    switch (e.event) {
      case "model_call":
        metrics.model_calls += 1;
        metrics.input_tokens += e.input_tokens ?? 0;
        metrics.output_tokens += e.output_tokens ?? 0;
        metrics.cost_usd += e.cost_usd ?? 0;
        break;
      case "tool_call":
        metrics.tool_calls += 1;
        break;
      case "circuit_open":
        metrics.circuit_breaks += 1;
        break;
      case "budget_warn":
        metrics.budget_warns += 1;
        break;
    }
  }

  return metrics;
}
