import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  accrue,
  calcCost,
  estimateInputTokens,
  logCost,
  projectMaxCost,
  readBudget,
} from "./circuit-breaker.js";

const MTOK = 1_000_000;

describe("calcCost — model pricing (USD per 1M tokens)", () => {
  it("prices claude-fable-5 at $10 input / $50 output", () => {
    expect(calcCost("claude-fable-5", MTOK, 0)).toBeCloseTo(10.0, 10);
    expect(calcCost("claude-fable-5", 0, MTOK)).toBeCloseTo(50.0, 10);
  });

  it("prices claude-fable-5-1 at $10 input / $50 output", () => {
    expect(calcCost("claude-fable-5-1", MTOK, 0)).toBeCloseTo(10.0, 10);
    expect(calcCost("claude-fable-5-1", 0, MTOK)).toBeCloseTo(50.0, 10);
  });

  it("prices claude-opus-5-5 at $4 input / $20 output — the longer key wins over claude-opus-5", () => {
    expect(calcCost("claude-opus-5-5", MTOK, 0)).toBeCloseTo(4.0, 10);
    expect(calcCost("claude-opus-5-5", 0, MTOK)).toBeCloseTo(20.0, 10);
  });

  it("prices claude-opus-5 at $5 input / $25 output", () => {
    expect(calcCost("claude-opus-5", MTOK, MTOK)).toBeCloseTo(30.0, 10);
  });

  it("prices claude-sonnet-5-5 and claude-sonnet-5 at $2 input / $10 output", () => {
    expect(calcCost("claude-sonnet-5-5", MTOK, MTOK)).toBeCloseTo(12.0, 10);
    expect(calcCost("claude-sonnet-5", MTOK, MTOK)).toBeCloseTo(12.0, 10);
  });

  it("prices claude-opus-4-8 at $5 input / $25 output", () => {
    expect(calcCost("claude-opus-4-8", MTOK, 0)).toBeCloseTo(5.0, 10);
    expect(calcCost("claude-opus-4-8", 0, MTOK)).toBeCloseTo(25.0, 10);
  });

  it("prices claude-opus-4-7 at $5 input / $25 output", () => {
    expect(calcCost("claude-opus-4-7", MTOK, MTOK)).toBeCloseTo(30.0, 10);
  });

  it("prices claude-opus-4-6 at $5 input / $25 output", () => {
    expect(calcCost("claude-opus-4-6", MTOK, MTOK)).toBeCloseTo(30.0, 10);
  });

  it("prices claude-sonnet-4-6 at $3 input / $15 output", () => {
    expect(calcCost("claude-sonnet-4-6", MTOK, MTOK)).toBeCloseTo(18.0, 10);
  });

  it("prices claude-haiku-4-5 at $1 input / $5 output", () => {
    expect(calcCost("claude-haiku-4-5", MTOK, MTOK)).toBeCloseTo(6.0, 10);
  });

  it("matches date-suffixed model ids via alias substring", () => {
    expect(calcCost("claude-haiku-4-5-20251001", MTOK, MTOK)).toBeCloseTo(6.0, 10);
  });

  it("computes fractional token counts proportionally", () => {
    expect(calcCost("claude-sonnet-4-6", 1000, 2000)).toBeCloseTo(
      (1000 * 3 + 2000 * 15) / MTOK,
      10
    );
  });
});

describe("calcCost — unknown model fails loud and conservative", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns with the model id and uses the highest known rates", () => {
    const cost = calcCost("totally-unknown-model", MTOK, MTOK);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("totally-unknown-model")
    );
    expect(cost).toBeCloseTo(60.0, 10);
  });

  it("warns only once per unknown model id", () => {
    calcCost("another-unknown-model", 1, 1);
    calcCost("another-unknown-model", 1, 1);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});

describe("accrue — accumulate-and-compare against budget", () => {
  it("does not trip below budget", () => {
    expect(accrue(1.0, 0.5, 2.0)).toEqual({ total: 1.5, tripped: false });
  });

  it("trips exactly at budget", () => {
    expect(accrue(1.5, 0.5, 2.0)).toEqual({ total: 2.0, tripped: true });
  });

  it("trips over budget", () => {
    const result = accrue(1.9, 0.5, 2.0);
    expect(result.total).toBeCloseTo(2.4, 10);
    expect(result.tripped).toBe(true);
  });

  it("starts from zero accumulated cost", () => {
    expect(accrue(0, 0.01, 2.0)).toEqual({ total: 0.01, tripped: false });
  });
});

describe("readBudget — precedence: SPEC frontmatter > env var > default", () => {
  const originalCwd = process.cwd();
  const originalEnv = process.env["AI_SESSION_BUDGET_USD"];
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "beads-test-"));
    process.chdir(tmpDir);
    process.env["RB_REPO_ROOT"] = tmpDir;
    delete process.env["AI_SESSION_BUDGET_USD"];
  });

  afterEach(() => {
    process.chdir(originalCwd);
    delete process.env["RB_REPO_ROOT"];
    if (originalEnv === undefined) {
      delete process.env["AI_SESSION_BUDGET_USD"];
    } else {
      process.env["AI_SESSION_BUDGET_USD"] = originalEnv;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("prefers SPEC.md frontmatter over the env var", () => {
    fs.writeFileSync(
      path.join(tmpDir, "SPEC.md"),
      "---\nbudget_usd: 5.50\n---\n\n# Spec\n",
      "utf8"
    );
    process.env["AI_SESSION_BUDGET_USD"] = "3.25";
    expect(readBudget()).toBe(5.5);
  });

  it("falls back to AI_SESSION_BUDGET_USD when SPEC.md is absent", () => {
    process.env["AI_SESSION_BUDGET_USD"] = "3.25";
    expect(readBudget()).toBe(3.25);
  });

  it("defaults to 2.00 with no SPEC.md and no env var", () => {
    expect(readBudget()).toBe(2.0);
  });

  // Windows com core.autocrlf=true grava o SPEC.md com CRLF no checkout. Com a
  // regex estrita o budget_usd do SPEC sumia sem aviso e o env, que devia
  // perder, decidia (rb-ai-team#36).
  it("lê o budget_usd de um SPEC.md em CRLF (checkout Windows)", () => {
    fs.writeFileSync(
      path.join(tmpDir, "SPEC.md"),
      "---\r\nbudget_usd: 5.50\r\n---\r\n\r\n# Spec\r\n",
      "utf8"
    );
    process.env["AI_SESSION_BUDGET_USD"] = "3.25";
    expect(readBudget()).toBe(5.5);
  });

  // F9: um BOM no início do SPEC.md (Set-Content -Encoding UTF8 do PowerShell 5) fazia
  // o leitor ignorar o arquivo inteiro: o budget_usd do SPEC sumia e o env (ou o
  // default) decidia, sem aviso.
  it("lê o budget_usd de um SPEC.md com BOM, em LF e em CRLF", () => {
    process.env["AI_SESSION_BUDGET_USD"] = "3.25";
    fs.writeFileSync(path.join(tmpDir, "SPEC.md"), "\uFEFF---\nbudget_usd: 5.50\n---\n\n# Spec\n", "utf8");
    expect(readBudget()).toBe(5.5);
    fs.writeFileSync(path.join(tmpDir, "SPEC.md"), "\uFEFF---\r\nbudget_usd: 5.50\r\n---\r\n", "utf8");
    expect(readBudget()).toBe(5.5);
  });

  // budget_usd só vale como número finito e positivo. Entre aspas o YAML
  // devolve string: readBudget a repassava e o budget.toFixed(2) do breaker
  // lançava TypeError em vez de CircuitOpenError. Com .inf o orçamento virava
  // Infinity e o hard stop nunca disparava (revisão de segurança da
  // rb-ai-team#36). Os dois caem no env e, sem env, no default.
  it("ignora um budget_usd entre aspas (string): cai no env, depois no default", () => {
    fs.writeFileSync(path.join(tmpDir, "SPEC.md"), '---\nbudget_usd: "5.50"\n---\n', "utf8");
    process.env["AI_SESSION_BUDGET_USD"] = "3.25";
    expect(readBudget()).toBe(3.25);
    delete process.env["AI_SESSION_BUDGET_USD"];
    expect(readBudget()).toBe(2.0);
  });

  it("ignora um budget_usd infinito (.inf): cai no env, depois no default", () => {
    fs.writeFileSync(path.join(tmpDir, "SPEC.md"), "---\nbudget_usd: .inf\n---\n", "utf8");
    process.env["AI_SESSION_BUDGET_USD"] = "3.25";
    expect(readBudget()).toBe(3.25);
    delete process.env["AI_SESSION_BUDGET_USD"];
    expect(readBudget()).toBe(2.0);
  });

  // O env segue a mesma regra do SPEC: só número finito e positivo. parseFloat
  // lê "Infinity" e "1e999" como Infinity, que passava pelo `!isNaN(env) &&
  // env > 0` e desligava o hard stop (rb-ai-team#36). Sem SPEC.md no tmpDir,
  // o que o env não sustenta cai no default.
  for (const invalido of ["Infinity", "1e999", "abc", "0", "-1"]) {
    it(`ignora AI_SESSION_BUDGET_USD=${invalido} e cai no default`, () => {
      process.env["AI_SESSION_BUDGET_USD"] = invalido;
      expect(readBudget()).toBe(2.0);
    });
  }

  it("aceita um AI_SESSION_BUDGET_USD finito e positivo", () => {
    process.env["AI_SESSION_BUDGET_USD"] = "4.75";
    expect(readBudget()).toBe(4.75);
  });

  it("ignores a non-positive frontmatter budget", () => {
    fs.writeFileSync(
      path.join(tmpDir, "SPEC.md"),
      "---\nbudget_usd: 0\n---\n",
      "utf8"
    );
    process.env["AI_SESSION_BUDGET_USD"] = "1.75";
    expect(readBudget()).toBe(1.75);
  });
});

describe("estimateInputTokens — cheap pre-call input heuristic", () => {
  it("returns roughly chars/4 of the serialized request", () => {
    const params = { messages: [{ role: "user", content: "z".repeat(4000) }], max_tokens: 10 };
    expect(estimateInputTokens(params)).toBeGreaterThanOrEqual(1000);
  });

  it("is finite and non-negative for an empty request", () => {
    const est = estimateInputTokens({ messages: [], max_tokens: 10 });
    expect(Number.isFinite(est)).toBe(true);
    expect(est).toBeGreaterThanOrEqual(0);
  });

  it("does not throw when system is undefined", () => {
    expect(() => estimateInputTokens({ messages: [{ role: "user", content: "hi" }], max_tokens: 5 })).not.toThrow();
  });
});

describe("projectMaxCost — worst-case projection of a single call", () => {
  it("prices the output ceiling (max_tokens) at the model's output rate", () => {
    // sonnet output is $15 / 1M; a 1M-token ceiling projects ~$15 plus a small input estimate.
    const cost = projectMaxCost("claude-sonnet-4-6", {
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 1_000_000,
    });
    expect(cost).toBeGreaterThan(15);
    expect(cost).toBeLessThan(15.1);
  });

  it("scales with the max_tokens ceiling", () => {
    const small = projectMaxCost("claude-sonnet-4-6", { messages: [], max_tokens: 1_000 });
    const large = projectMaxCost("claude-sonnet-4-6", { messages: [], max_tokens: 100_000 });
    expect(large).toBeGreaterThan(small);
  });

  it("lets the breaker trip pre-call: accrue(spent, projected, budget) detects the overshoot", () => {
    // $0 spent, but one sonnet call could cost ~$15 against a $2 budget.
    const projected = projectMaxCost("claude-sonnet-4-6", { messages: [], max_tokens: 1_000_000 });
    expect(accrue(0, projected, 2.0).tripped).toBe(true);
  });

  describe("unknown model", () => {
    beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
    afterEach(() => vi.restoreAllMocks());

    it("projects at the conservative (highest-known) output rate", () => {
      // unknown → $50 / 1M output; 1M ceiling projects > $50.
      const cost = projectMaxCost("mystery-model", { messages: [], max_tokens: 1_000_000 });
      expect(cost).toBeGreaterThan(50);
    });
  });
});

// O log de custo é estado local (aiteam/docs/beads-schema.md §10): saiu do
// git com a migração do .beads, então numa worktree nova ele não existe — e o
// logCost antigo, que só acrescentava num arquivo existente, descartava a
// entrada em silêncio.
describe("logCost — .beads/cost-log.json local", () => {
  const originalCwd = process.cwd();
  let tmpDir: string;
  const entry = {
    timestamp: "2026-10-05T12:00:00Z",
    model: "claude-opus-5-5",
    input_tokens: 10,
    output_tokens: 5,
    cost_usd: 0.0001,
    session_total_usd: 0.0001,
  };
  const logFile = () => path.join(tmpDir, ".beads", "cost-log.json");

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cost-log-"));
    process.chdir(tmpDir);
    process.env["RB_REPO_ROOT"] = tmpDir;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    delete process.env["RB_REPO_ROOT"];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("cria o arquivo quando ele não existe e acrescenta as chamadas seguintes", () => {
    logCost(entry);
    logCost({ ...entry, session_total_usd: 0.0002 });
    const log = JSON.parse(fs.readFileSync(logFile(), "utf8"));
    expect(log.sessions.map((e: { session_total_usd: number }) => e.session_total_usd)).toEqual([0.0001, 0.0002]);
  });

  it("não sobrescreve um log ilegível (o histórico vale mais que a entrada)", () => {
    fs.mkdirSync(path.dirname(logFile()), { recursive: true });
    fs.writeFileSync(logFile(), "{ corrompido", "utf8");
    logCost(entry);
    expect(fs.readFileSync(logFile(), "utf8")).toBe("{ corrompido");
  });
});
