import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { logEvent, reduceMetrics, type SessionEvent } from "./session-log.js";

describe("logEvent — append-only NDJSON writer", () => {
  const originalCwd = process.cwd();
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-log-"));
    fs.mkdirSync(path.join(dir, ".beads"), { recursive: true });
    process.chdir(dir);
    process.env["RB_REPO_ROOT"] = dir;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    delete process.env["RB_REPO_ROOT"];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes exactly one valid-JSON line per event", () => {
    logEvent({ event: "model_call", model: "claude-opus-4-8", input_tokens: 10, output_tokens: 5, cost_usd: 0.001, cumulative_usd: 0.001 });
    logEvent({ event: "circuit_open", cumulative_usd: 2.0 });

    const raw = fs.readFileSync(path.join(dir, ".beads", "session-log.ndjson"), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(JSON.parse(lines[0]!).event).toBe("model_call");
  });

  it("stamps each event with an ISO timestamp and session id", () => {
    logEvent({ event: "tool_call", tool: "git_commit" });
    const entry = JSON.parse(
      fs.readFileSync(path.join(dir, ".beads", "session-log.ndjson"), "utf8").trim()
    ) as SessionEvent;
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof entry.session).toBe("string");
  });
});

describe("reduceMetrics — NDJSON → headline metrics", () => {
  it("aggregates tokens, cost, tool calls and circuit breaks", () => {
    const fixture = [
      JSON.stringify({ ts: "t", session: "s", event: "model_call", input_tokens: 100, output_tokens: 50, cost_usd: 0.2, cumulative_usd: 0.2 }),
      JSON.stringify({ ts: "t", session: "s", event: "model_call", input_tokens: 200, output_tokens: 80, cost_usd: 0.5, cumulative_usd: 0.7 }),
      JSON.stringify({ ts: "t", session: "s", event: "tool_call", tool: "run_tests" }),
      JSON.stringify({ ts: "t", session: "s", event: "tool_call", tool: "git_commit" }),
      JSON.stringify({ ts: "t", session: "s", event: "circuit_open", cumulative_usd: 2.0 }),
      "",
    ].join("\n");

    const m = reduceMetrics(fixture);
    expect(m.model_calls).toBe(2);
    expect(m.tool_calls).toBe(2);
    expect(m.circuit_breaks).toBe(1);
    expect(m.input_tokens).toBe(300);
    expect(m.output_tokens).toBe(130);
    expect(m.cost_usd).toBeCloseTo(0.7, 10);
  });

  it("ignores blank and malformed lines", () => {
    const fixture = ["", "not json", JSON.stringify({ event: "tool_call" })].join("\n");
    const m = reduceMetrics(fixture);
    expect(m.tool_calls).toBe(1);
    expect(m.model_calls).toBe(0);
  });
});
