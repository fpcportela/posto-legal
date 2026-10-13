import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  Model,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/messages.js";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { type CostStore, createCostStore } from "./cost-store.js";
import { extractFrontmatter } from "./frontmatter.mjs";
import { logEvent } from "./session-log.js";
import { repoRoot } from "./repo-root.js";

const BUDGET_WARN_MARGIN_USD = 0.2;

// ── Pricing (USD per 1M tokens) ──────────────────────────────────────────────
// Verified against the `claude-api` skill's model table (cached 2026-09-25).
// Bare aliases also match date-suffixed ids (e.g. claude-haiku-4-5-20251001)
// via substring; the longest key wins, so "claude-opus-5" never shadows
// "claude-opus-5-5". A model missing here is charged the conservative rate
// below and warned about once — add the row rather than silencing the warning.
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-fable-5-1": { input: 10.0, output: 50.0 },
  "claude-fable-5": { input: 10.0, output: 50.0 },
  "claude-opus-5-5": { input: 4.0, output: 20.0 },
  "claude-opus-5": { input: 5.0, output: 25.0 },
  "claude-opus-4-8": { input: 5.0, output: 25.0 },
  "claude-opus-4-7": { input: 5.0, output: 25.0 },
  "claude-opus-4-6": { input: 5.0, output: 25.0 },
  "claude-sonnet-5-5": { input: 2.0, output: 10.0 },
  "claude-sonnet-5": { input: 2.0, output: 10.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
};

// Longest key first so a key can never shadow a longer, more specific one.
const PRICING_LONGEST_FIRST = Object.entries(MODEL_PRICING).sort(
  ([a], [b]) => b.length - a.length
);

// Unknown models over-count (trip early) instead of silently under-counting.
const CONSERVATIVE_RATE = Object.values(MODEL_PRICING).reduce((max, r) => ({
  input: Math.max(max.input, r.input),
  output: Math.max(max.output, r.output),
}));

const warnedModels = new Set<string>();

// ── Types ────────────────────────────────────────────────────────────────────
export class CircuitOpenError extends Error {
  constructor(
    public readonly sessionCostUsd: number,
    public readonly budgetUsd: number
  ) {
    super(
      `[circuit-breaker] HARD STOP — session cost $${sessionCostUsd.toFixed(4)} reached budget $${budgetUsd.toFixed(2)}`
    );
    this.name = "CircuitOpenError";
  }
}

export interface CostLogEntry {
  timestamp: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  session_total_usd: number;
}

// ── File helpers ─────────────────────────────────────────────────────────────
const BEADS = (f: string) => path.resolve(repoRoot(), ".beads", f);

/**
 * Appends one call to `.beads/cost-log.json` — local state, out of git
 * (aiteam/docs/beads-schema.md §10). Creates the file when it is missing (a
 * fresh worktree or clone has none); never overwrites one it cannot parse,
 * because the history is worth more than this entry. Non-fatal either way.
 */
export function logCost(entry: CostLogEntry): void {
  const logPath = BEADS("cost-log.json");
  try {
    let log: { sessions: CostLogEntry[] } = { sessions: [] };
    let raw: string | null = null;
    try {
      raw = fs.readFileSync(logPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    if (raw !== null) {
      const parsed = JSON.parse(raw) as { sessions?: unknown };
      if (!Array.isArray(parsed?.sessions)) return;
      log = parsed as { sessions: CostLogEntry[] };
    }
    log.sessions.push(entry);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2), "utf8");
  } catch {
    // Non-fatal — a corrupt log stays untouched and the call goes on.
  }
}

// ── Budget resolution ────────────────────────────────────────────────────────
export function readBudget(): number {
  try {
    const spec = fs.readFileSync(path.resolve(repoRoot(), "SPEC.md"), "utf8");
    const frontmatter = extractFrontmatter(spec);
    if (frontmatter) {
      const fm = yaml.load(frontmatter) as { budget_usd?: unknown } | null | undefined;
      const budget = fm?.budget_usd;
      // Only a finite positive number. A quoted "5.50" is a string, whose
      // missing .toFixed threw a TypeError instead of CircuitOpenError; `.inf`
      // is Infinity, which switched the hard stop off.
      if (typeof budget === "number" && Number.isFinite(budget) && budget > 0) return budget;
    }
  } catch { /* fall through */ }

  // Same rule as the SPEC value: parseFloat reads "Infinity" and "1e999" as
  // Infinity, which would switch the hard stop off.
  const env = parseFloat(process.env["AI_SESSION_BUDGET_USD"] ?? "");
  if (Number.isFinite(env) && env > 0) return env;

  return 2.0;
}

// ── Cost calculation ─────────────────────────────────────────────────────────
export function calcCost(model: string, inputTokens: number, outputTokens: number): number {
  let rate = PRICING_LONGEST_FIRST.find(([k]) => model.includes(k))?.[1];
  if (!rate) {
    if (!warnedModels.has(model)) {
      warnedModels.add(model);
      console.warn(
        `[circuit-breaker] unknown model "${model}" — charging conservative rate $${CONSERVATIVE_RATE.input}/$${CONSERVATIVE_RATE.output} per 1M tokens; update MODEL_PRICING`
      );
    }
    rate = CONSERVATIVE_RATE;
  }
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}

// ── Pre-call projection ──────────────────────────────────────────────────────
interface EstimableRequest {
  messages?: unknown;
  system?: unknown;
  max_tokens?: number;
}

/**
 * Cheap, dependency-free estimate of a request's input tokens (~chars/4 of the
 * serialized messages + system). Deliberately a rough OVER-estimate — it feeds
 * {@link projectMaxCost}, where over-counting trips the breaker early rather
 * than letting a call slip past.
 */
export function estimateInputTokens(req: EstimableRequest): number {
  const text = JSON.stringify(req.messages ?? "") + JSON.stringify(req.system ?? "");
  return Math.ceil(text.length / 4);
}

/**
 * Worst-case cost of a single call BEFORE issuing it: the estimated input cost
 * plus the full `max_tokens` output ceiling at the model's output rate. The
 * breaker uses this to refuse a call that could overshoot the budget, bounding
 * any single-call overrun (post-hoc accrual alone can't — it only sees the cost
 * after the money is spent).
 */
export function projectMaxCost(model: string, req: EstimableRequest): number {
  const maxOutput = typeof req.max_tokens === "number" && req.max_tokens > 0 ? req.max_tokens : 0;
  return calcCost(model, estimateInputTokens(req), maxOutput);
}

const warnedStreaming = { done: false };

// ── Budget accrual ───────────────────────────────────────────────────────────
export function accrue(
  prev: number,
  cost: number,
  budget: number
): { total: number; tripped: boolean } {
  const total = prev + cost;
  return { total, tripped: total >= budget };
}

// ── Trip the breaker ─────────────────────────────────────────────────────────
function trip(total: number, budget: number): never {
  console.error(`\n[circuit-breaker] HARD STOP: $${total.toFixed(4)} / $${budget.toFixed(2)}`);
  throw new CircuitOpenError(total, budget);
}

// ── Public API ───────────────────────────────────────────────────────────────
/**
 * Create an Anthropic client with circuit-breaker enforcement.
 *
 * Cost is read from the SDK's `usage` field on each response and accumulated
 * through a {@link CostStore} (the local `.beads/session.local.json` by
 * default, or an atomic Redis counter when `AI_COST_STORE=redis`). Each call
 * also appends to `.beads/cost-log.json`. Both files are local, out of git.
 *
 * **What the gate guarantees (and what it doesn't):**
 * - Once the accumulated total meets or exceeds `budget_usd`, the *next* call
 *   throws `CircuitOpenError` — the breaker is reactive, it does not abort a
 *   call already in flight.
 * - A **predictive pre-call guard** ({@link projectMaxCost}) refuses a call
 *   whose worst case (input estimate + the full `max_tokens` output ceiling)
 *   would breach the budget, so a single call cannot overshoot unbounded.
 * - **Streaming is NOT metered.** When `params.stream === true` there is no
 *   top-level `usage` to read at call time; the wrapper logs a one-time warning
 *   and passes the call through without accounting. Avoid streaming for
 *   cost-sensitive flows, or meter it yourself from the final `message_delta`.
 * - With the file store, concurrent in-flight calls each pass the pre-check
 *   before any accrues; use `AI_COST_STORE=redis` for atomic accounting across
 *   concurrent agents.
 */
export function createClient(
  options?: ConstructorParameters<typeof Anthropic>[0],
  store: CostStore = createCostStore()
): Anthropic {
  const client = new Anthropic(options);
  const budget = readBudget();

  const originalCreate = client.messages.create.bind(client.messages);

  client.messages.create = (async (
    params: MessageCreateParamsNonStreaming & { model: Model; messages: MessageParam[] },
    requestOptions?: Parameters<typeof originalCreate>[1]
  ) => {
    // Refuse if the breaker already tripped (this or a prior shared session).
    if (await store.isCircuitOpen()) {
      trip(await store.get(), budget);
    }

    const accumulated = await store.get();
    if (accumulated >= budget) {
      await store.setCircuitOpen();
      logEvent({ event: "circuit_open", cumulative_usd: accumulated });
      trip(accumulated, budget);
    }

    // Streaming responses have no top-level `usage` to read at call time, so the
    // wrapper cannot meter them. Make that visible instead of silent, and pass
    // the call through without accounting.
    if ((params as { stream?: boolean }).stream === true) {
      if (!warnedStreaming.done) {
        warnedStreaming.done = true;
        console.warn(
          "[circuit-breaker] streaming call detected — its cost is NOT metered and will not count toward the budget. Avoid streaming for cost-sensitive flows."
        );
      }
      return originalCreate(params, requestOptions);
    }

    // Predictive guard: refuse a call whose worst case (input estimate + the
    // full max_tokens output ceiling) would breach the budget. This bounds
    // single-call overshoot, which post-hoc accrual alone cannot catch.
    const projected = projectMaxCost(params.model, params);
    if (accrue(accumulated, projected, budget).tripped) {
      await store.setCircuitOpen();
      logEvent({ event: "circuit_open", cumulative_usd: accumulated });
      trip(accumulated, budget);
    }

    const response = await originalCreate(params, requestOptions);

    if (response?.usage) {
      const cost = calcCost(params.model, response.usage.input_tokens, response.usage.output_tokens);
      const total = await store.incrBy(cost);

      logCost({
        timestamp: new Date().toISOString(),
        model: params.model,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cost_usd: cost,
        session_total_usd: total,
      });

      logEvent({
        event: "model_call",
        model: params.model,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cost_usd: cost,
        cumulative_usd: total,
      });

      if (total >= budget) {
        await store.setCircuitOpen();
        logEvent({ event: "circuit_open", cumulative_usd: total });
        trip(total, budget);
      } else if (total >= budget - BUDGET_WARN_MARGIN_USD) {
        logEvent({ event: "budget_warn", cumulative_usd: total });
      }
    }

    return response;
  }) as unknown as typeof client.messages.create;

  return client;
}
