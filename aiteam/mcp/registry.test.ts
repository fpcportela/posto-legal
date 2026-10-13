import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { z } from "zod";
import { TOOLS, allowTier3FromSpec, dispatch, type ToolDef } from "./registry.js";

describe("TOOLS registry", () => {
  it("registers all five MCP tools with correct tiers", () => {
    const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual([
      "db_migrate",
      "deploy_preview",
      "deploy_production",
      "git_commit",
      "run_tests",
    ]);
    expect(byName["run_tests"]!.tier).toBe(1);
    expect(byName["git_commit"]!.tier).toBe(2);
    expect(byName["deploy_production"]!.tier).toBe(3);
    expect(byName["deploy_production"]!.needsApproval).toBe(true);
    expect(byName["db_migrate"]!.needsApproval).toBe(true);
  });

  // Issue 38: o servidor MCP roda no checkout principal. git_commit e run_tests
  // recebem o caminho da worktree do implementador isolado (opcional: omitido é
  // o comportamento de antes), e o servidor expõe isso na descrição da tool.
  it("git_commit e run_tests aceitam o caminho da worktree, opcional, e a descrição explica", () => {
    for (const nome of ["git_commit", "run_tests"]) {
      const tool = TOOLS.find((t) => t.name === nome)!;
      const campo = tool.schema.shape["worktree"] as z.ZodTypeAny;
      expect(campo, nome).toBeDefined();
      expect(campo.isOptional(), nome).toBe(true);
      expect(campo.description ?? "", nome).toMatch(/absolute/i);
      expect(tool.description ?? "", nome).toMatch(/worktree/i);
    }
  });

  it("as demais tools não ganham o parâmetro worktree", () => {
    for (const nome of ["deploy_preview", "db_migrate", "deploy_production"]) {
      const tool = TOOLS.find((t) => t.name === nome)!;
      expect(tool.schema.shape["worktree"], nome).toBeUndefined();
    }
  });

  it("dispatch valida o worktree como string antes de rodar a tool", () => {
    const r = dispatch("git_commit", { message: "x", files: ["a"], worktree: 42 });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/Invalid input/);
  });
});

// O server passa allowTier3FromSpec() como allowTier3 do dispatch: é o gate
// Tier 3 das tools MCP. Windows com core.autocrlf=true grava o SPEC.md com
// CRLF no checkout, e a regex estrita deste leitor não casava — o break-glass
// valia no frontmatter LF e sumia no CRLF (rb-ai-team#36).
describe("allowTier3FromSpec — o gate Tier 3 das tools MCP lê o SPEC.md da raiz", () => {
  const originalRoot = process.env["RB_REPO_ROOT"];
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-spec-"));
    process.env["RB_REPO_ROOT"] = root;
  });

  afterEach(() => {
    if (originalRoot === undefined) delete process.env["RB_REPO_ROOT"];
    else process.env["RB_REPO_ROOT"] = originalRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const spec = (allow: boolean) => `---\ntier_defaults:\n  allow_tier3: ${allow}\n---\n\n# Spec\n`;

  it("vale o allow_tier3 do frontmatter em LF", () => {
    fs.writeFileSync(path.join(root, "SPEC.md"), spec(true), "utf8");
    expect(allowTier3FromSpec()).toBe(true);
  });

  it("vale o allow_tier3 do frontmatter em CRLF (checkout Windows)", () => {
    fs.writeFileSync(path.join(root, "SPEC.md"), spec(true).replace(/\n/g, "\r\n"), "utf8");
    expect(allowTier3FromSpec()).toBe(true);
    fs.writeFileSync(path.join(root, "SPEC.md"), spec(false).replace(/\n/g, "\r\n"), "utf8");
    expect(allowTier3FromSpec()).toBe(false);
  });

  it("é false sem SPEC.md", () => {
    expect(allowTier3FromSpec()).toBe(false);
  });
});

describe("dispatch — tier gating", () => {
  it("returns approval-required for a Tier-3 tool without executing it", () => {
    const result = dispatch(
      "deploy_production",
      { service: "vercel", branch: "main", confirmHash: "abcd1234".slice(0, 7) },
      { allowTier3: false }
    );
    expect(result.approvalRequired).toBe(true);
    expect(result.ok).toBe(false);
    // No deploy ran — the message explains the gate.
    expect(result.output).toMatch(/Tier 3|approval/i);
  });

  it("rejects an unknown tool", () => {
    const result = dispatch("does_not_exist", {});
    expect(result.ok).toBe(false);
  });
});

describe("dispatch — input validation", () => {
  it("rejects input that fails the tool's Zod schema before running it", () => {
    // git_commit (Tier 2) requires a non-empty files array — empty fails Zod,
    // so the underlying git call never runs.
    const result = dispatch("git_commit", { message: "x", files: [] });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/invalid/i);
  });
});

describe("dispatch — execution path (injected tool, no side effects)", () => {
  it("validates and runs a Tier-1 tool, returning its output", () => {
    const echo: ToolDef = {
      name: "echo",
      tier: 1,
      needsApproval: false,
      schema: z.object({ msg: z.string() }),
      run: (input) => ({ success: true, output: (input as { msg: string }).msg }),
    };
    const result = dispatch("echo", { msg: "hello" }, { tools: [echo] });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("hello");
  });
});
