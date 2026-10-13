import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { makeSandbox, type Sandbox } from "./beads-sandbox.js";
import { readCiBlock } from "./ci-contract-core.mjs";
import { evaluateDeployContract, readDeployBlock } from "./deploy-contract-core.mjs";

// generate-spec faz uma chamada paga à API, então o teste de ponta a ponta só
// vai até o ponto em que ele recusa sobrescrever um SPEC.md existente: é antes
// da chamada, e já nomeia o diretório que o script escolheu como alvo.

const AITEAM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(AITEAM, "scripts", "generate-spec.ts");
// Com cwd = aiteam/ do sandbox, `--import tsx` não resolve: tsx pelo caminho absoluto.
const TSX_CLI = path.join(AITEAM, "node_modules", "tsx", "dist", "cli.mjs");

let sb: Sandbox | undefined;
afterEach(() => sb?.cleanup());

function run(cwd: string, args: string[], extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  delete env["RB_REPO_ROOT"];
  // Sem chave, um alvo errado (sem SPEC.md) falha na autenticação em vez de gastar uma chamada.
  delete env["ANTHROPIC_API_KEY"];
  if (!("INIT_CWD" in extraEnv)) delete env["INIT_CWD"];
  const r = spawnSync(process.execPath, [TSX_CLI, SCRIPT, ...args], { cwd, env, encoding: "utf8" });
  return { status: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

const real = (p: string) => fs.realpathSync(p);
const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();

describe("generate-spec — padrão é a raiz do repo", () => {
  it("sem argumento, com cwd em aiteam/ (npm --prefix aiteam run), mira o SPEC.md da raiz", { timeout: 60_000 }, () => {
    sb = makeSandbox();
    sb.write("SPEC.md", "---\nproject: x\n---\n");
    const r = run(path.join(sb.dir, "aiteam"), []);
    expect(r.status, r.out).toBe(1);
    expect(norm(r.out)).toContain(norm(path.join(real(sb.dir), "SPEC.md")));
    expect(norm(r.out)).not.toContain(norm(path.join("aiteam", "SPEC.md")));
  });

  it("o INIT_CWD do npm vale: a raiz do repo de onde o comando foi digitado", { timeout: 60_000 }, () => {
    sb = makeSandbox();
    sb.write("SPEC.md", "---\nproject: x\n---\n");
    sb.write("src/a.ts", "export {};\n");
    const r = run(AITEAM, [], { INIT_CWD: path.join(sb.dir, "src") });
    expect(r.status, r.out).toBe(1);
    expect(norm(r.out)).toContain(norm(path.join(real(sb.dir), "SPEC.md")));
  });

  it("o argumento explícito continua valendo (e o `-- ..` antigo também)", { timeout: 60_000 }, () => {
    sb = makeSandbox();
    sb.write("SPEC.md", "---\nproject: x\n---\n");
    const r = run(path.join(sb.dir, "aiteam"), [".."]);
    expect(r.status, r.out).toBe(1);
    expect(norm(r.out)).toContain(norm(path.join(real(sb.dir), "SPEC.md")));
  });
});

// Ponta a ponta com a API de mentira: o modelo devolve um SPEC.md que "resolve" o
// ci: e o deploy: do jeito errado (test: none, workflow: none, sem motivo). O que
// vai para o disco tem de trazer os blocos montados por código.
describe("generate-spec — os blocos ci: e deploy: vêm de código", () => {
  const MODEL_SPEC = [
    "```markdown",
    "---",
    'project: "x"',
    "ci:",
    "  test: none",
    "deploy:",
    "  workflow: none",
    'last_updated: "2026-10-06"',
    "---",
    "",
    "# Project Specification",
    "```",
  ].join("\n");

  function startFakeApi(): Promise<{ url: string; requests: string[]; close: () => Promise<void> }> {
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        requests.push(Buffer.concat(chunks).toString("utf8"));
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            id: "msg_fake",
            type: "message",
            role: "assistant",
            model: "claude-haiku-4-5-20251001",
            content: [{ type: "text", text: MODEL_SPEC }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 10 },
          }),
        );
      });
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as { port: number };
        resolve({
          url: `http://127.0.0.1:${port}`,
          requests,
          close: () => new Promise((done) => server.close(() => done())),
        });
      });
    });
  }

  function runAsync(cwd: string, env: NodeJS.ProcessEnv): Promise<{ status: number; out: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [TSX_CLI, SCRIPT], { cwd, env });
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += d));
      child.stderr.on("data", (d: Buffer) => (out += d));
      child.on("close", (code) => resolve({ status: code ?? 1, out }));
    });
  }

  it("grava na raiz o ci: do package.json e o deploy: que reprova, no lugar do que o modelo escreveu", { timeout: 60_000 }, async () => {
    sb = makeSandbox();
    sb.write("package.json", JSON.stringify({ name: "x", scripts: { test: "vitest run", lint: "eslint ." } }));
    const api = await startFakeApi();
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "fake-key-local-only" };
      delete env["RB_REPO_ROOT"];
      delete env["INIT_CWD"];
      const r = await runAsync(path.join(sb.dir, "aiteam"), env);
      expect(r.status, r.out).toBe(0);

      const out = sb.read("SPEC.md");
      expect(sb.exists("aiteam/SPEC.md")).toBe(false);
      expect(readCiBlock(out)).toMatchObject({
        state: "ok",
        ci: { workdir: "", test: "npm run test", lint: "npm run lint", typecheck: null },
      });
      expect(readDeployBlock(out)).toMatchObject({ state: "ok", deploy: { workflow: "deploy.yml", version_url: null } });
      expect(out).not.toMatch(/^\s*(?:test|workflow):\s*none/m);
      expect(out).not.toMatch(/^```/m);

      const verdict = evaluateDeployContract({ specText: out, workflows: [], readFile: () => null });
      expect(verdict.findings.some((f) => f.level === "fail")).toBe(true);
      // O prompt que foi ao modelo já leva os blocos.
      expect(api.requests.join("")).toContain("npm run test");
    } finally {
      await api.close();
    }
  });

  it("num repo pnpm (pnpm-lock.yaml), o ci: usa `pnpm run`", { timeout: 60_000 }, async () => {
    sb = makeSandbox();
    sb.write("package.json", JSON.stringify({ name: "x", scripts: { test: "vitest run", typecheck: "tsc --noEmit" } }));
    sb.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    const api = await startFakeApi();
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "fake-key-local-only" };
      delete env["RB_REPO_ROOT"];
      delete env["INIT_CWD"];
      const r = await runAsync(path.join(sb.dir, "aiteam"), env);
      expect(r.status, r.out).toBe(0);
      expect(readCiBlock(sb.read("SPEC.md"))).toMatchObject({
        state: "ok",
        ci: { test: "pnpm run test", typecheck: "pnpm run typecheck", lint: null },
      });
    } finally {
      await api.close();
    }
  });
});
