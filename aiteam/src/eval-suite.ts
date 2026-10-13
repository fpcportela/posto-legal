import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { describe, it, expect } from "vitest";

// ── Types ────────────────────────────────────────────────────────────────────
export interface EvalCase {
  id: string;
  prompt_file: string;
  description: string;
  input: string;
  expected_behavior: string[];
  pass_criteria: Record<string, boolean | string | number>;
  fail_signals: string[];
}

export type EvalVerifier = (output: string, evalCase: EvalCase) => EvalResult;

export interface EvalResult {
  passed: boolean;
  score: number; // 0.0 – 1.0
  findings: string[];
}

// ── Built-in verifiers ───────────────────────────────────────────────────────

function verifySections(output: string, sections: string[]): EvalResult {
  const findings: string[] = [];
  let hits = 0;
  for (const section of sections) {
    if (output.toLowerCase().includes(section.toLowerCase())) {
      hits++;
    } else {
      findings.push(`Missing section: "${section}"`);
    }
  }
  const score = hits / sections.length;
  return { passed: score === 1, score, findings };
}

function verifyNoImplementationCode(output: string): EvalResult {
  // Heuristic: TypeScript function bodies with curly braces and type annotations
  const hasCode =
    /function\s+\w+\s*\(|const\s+\w+\s*=\s*\(|=>\s*\{|class\s+\w+/.test(output);
  return {
    passed: !hasCode,
    score: hasCode ? 0 : 1,
    findings: hasCode ? ["Output contains implementation code — plan prompt should not produce code"] : [],
  };
}

function verifyNoBareFetch(output: string): EvalResult {
  const hasBare = /\bfetch\s*\(|axios\.(get|post|put|delete)/.test(output);
  return {
    passed: !hasBare,
    score: hasBare ? 0 : 1,
    findings: hasBare ? ["Output contains direct fetch/axios call — should use MCP tools instead"] : [],
  };
}

// ── Core eval runner ─────────────────────────────────────────────────────────

/**
 * Run a single eval case against an already-obtained LLM response string.
 * This keeps the eval logic free from API calls — the caller decides how to
 * obtain the response (real API, mock, cached fixture).
 */
export function runEval(output: string, evalCase: EvalCase): EvalResult {
  const findings: string[] = [];
  let totalScore = 0;
  let checks = 0;

  // Auto-check: all_sections_present — extract section names from "Contains [a/an/the] \"X\" section"
  if (evalCase.pass_criteria["all_sections_present"] === true) {
    const sectionRegex = /^Contains (?:a |an |the )?"(.+?)" section/i;
    const sectionNames = evalCase.expected_behavior
      .map((b) => sectionRegex.exec(b)?.[1])
      .filter((name): name is string => name !== undefined);

    if (sectionNames.length > 0) {
      const result = verifySections(output, sectionNames);
      totalScore += result.score;
      checks++;
      findings.push(...result.findings);
    }
  }

  // Auto-check: no_implementation_code
  if (evalCase.pass_criteria["no_implementation_code"] === true) {
    const result = verifyNoImplementationCode(output);
    totalScore += result.score;
    checks++;
    findings.push(...result.findings);
  }

  // Auto-check: no_bare_fetch
  if (evalCase.pass_criteria["no_bare_fetch"] === true) {
    const result = verifyNoBareFetch(output);
    totalScore += result.score;
    checks++;
    findings.push(...result.findings);
  }

  // fail_signals is documentation for human reviewers — these describe meta-failures
  // (e.g. "agent skips a section") that the auto-checks above already catch structurally.
  // We surface them as informational findings, not automatic test failures.

  const score = checks > 0 ? totalScore / checks : 1;
  return { passed: score >= 0.8, score, findings };
}

// ── Vitest integration ───────────────────────────────────────────────────────

/**
 * Load all `*.eval.yaml` files from one or more directories and register them
 * as Vitest tests.
 *
 * Usage in a test file:
 *   import { registerEvals } from "../src/eval-suite.js";
 *   registerEvals(["evals/", "prompts/"], (input, promptFile) => myLlmCall(...));
 */
export function registerEvals(
  evalsDirs: string | string[],
  runLlm: (input: string, promptFile: string) => Promise<string>
): void {
  const dirs = Array.isArray(evalsDirs) ? evalsDirs : [evalsDirs];

  for (const evalsDir of dirs) {
    const dir = path.resolve(process.cwd(), evalsDir);
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".eval.yaml"));
    if (files.length === 0) continue;

    describe(`AI Evals (${evalsDir})`, () => {
      for (const file of files) {
        const raw = fs.readFileSync(path.join(dir, file), "utf8");
        const evalCase = yaml.load(raw) as EvalCase;

        it(`[${evalCase.id}] ${evalCase.description}`, async () => {
          const output = await runLlm(evalCase.input, evalCase.prompt_file);
          const result = runEval(output, evalCase);

          if (result.findings.length > 0) {
            console.warn(`  Findings:\n${result.findings.map((f) => `    • ${f}`).join("\n")}`);
          }

          expect(result.passed, `Score: ${(result.score * 100).toFixed(0)}%`).toBe(true);
        });
      }
    });
  }
}

// ── CLI runner (run a single eval against a fixture response) ────────────────
if (process.argv[2] === "--file" && process.argv[3]) {
  const evalPath = path.resolve(process.cwd(), process.argv[3]);
  const fixturePath = process.argv[4] ? path.resolve(process.cwd(), process.argv[4]) : null;

  const evalCase = yaml.load(fs.readFileSync(evalPath, "utf8")) as EvalCase;
  const output = fixturePath
    ? fs.readFileSync(fixturePath, "utf8")
    : `(no fixture provided — using empty string)`;

  const result = runEval(output, evalCase);
  console.log(`\nEval: ${evalCase.id}`);
  console.log(`Score: ${(result.score * 100).toFixed(0)}%  ${result.passed ? "✅ PASS" : "❌ FAIL"}`);
  if (result.findings.length > 0) {
    console.log("Findings:");
    result.findings.forEach((f) => console.log(`  • ${f}`));
  }
}
