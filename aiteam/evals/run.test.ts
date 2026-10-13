/**
 * Eval runner — entry point for `npm run eval`.
 *
 * Scans `evals/` and `prompts/` for `*.eval.yaml` files and runs each against
 * the live Anthropic API. If `ANTHROPIC_API_KEY` is not set, all evals are
 * skipped (allowing CI without secrets, e.g. dependabot PRs, to still pass).
 *
 * Cost is bounded by the circuit breaker — see `AI_SESSION_BUDGET_USD` env
 * (defaults to $0.50 in CI, $2.00 locally).
 */

import * as fs from "fs";
import * as path from "path";
import { describe, it } from "vitest";
import { registerEvals } from "../src/eval-suite.js";
import { createClient } from "../src/circuit-breaker.js";

const HAS_KEY = Boolean(process.env["ANTHROPIC_API_KEY"]);
const MODEL = process.env["EVAL_MODEL"] ?? "claude-haiku-4-5-20251001";

if (!HAS_KEY) {
  describe("AI Evals", () => {
    it.skip("ANTHROPIC_API_KEY not set — all evals skipped", () => {});
  });
} else {
  const client = createClient();

  const runLlm = async (input: string, promptFile: string): Promise<string> => {
    const promptPath = path.resolve(process.cwd(), promptFile);
    const systemPrompt = fs.existsSync(promptPath)
      ? fs.readFileSync(promptPath, "utf8")
      : "You are a helpful assistant.";

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: input }],
    });

    return response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n");
  };

  registerEvals(["evals/", "prompts/"], runLlm);
}
