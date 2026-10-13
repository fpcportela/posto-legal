import { afterEach, describe, expect, it } from "vitest";
import { makeSandbox, SLOW, type Sandbox } from "./beads-sandbox.js";

// O install lia CLAUDE.md, AGENTS.md, .windsurfrules, os hooks do host e os JSONs com
// `existsSync` + `readFileSync`: uma PASTA com esse nome (EISDIR) ou um arquivo sem
// permissão de leitura estourava com a stack do Node no meio do install, antes dos passos
// seguintes — o mesmo defeito do .claude/tier-rules.json, em todos os outros leitores.
// Agora todos leem com readOptionalFile: o que não dá para ler vira aviso, o install não
// toca nesse arquivo e segue. E os avisos saem DEPOIS do banner do install, juntos.

let sb: Sandbox | undefined;
afterEach(() => sb?.cleanup());

const sandbox = (): Sandbox => (sb = makeSandbox());
const BANNER = /aiteam install( \(dry-run\))? — repo root/;
const noCrash = (out: string) => {
  expect(out).not.toMatch(/EISDIR|EACCES|node:internal|\n\s+at /);
};

describe("install.mjs — arquivo do host que é uma pasta", () => {
  it.each([
    ["CLAUDE.md"],
    ["AGENTS.md"],
    [".windsurfrules"],
    [".github/copilot-instructions.md"],
    [".cursor/rules/aiteam.mdc"],
    [".gitignore"],
    [".beads/.gitignore"],
  ])("%s: avisa, não toca, e o resto do install roda", SLOW, (name) => {
    const s = sandbox();
    s.write(`${name}/dentro.txt`, "do dono");

    const r = s.node("install.mjs");

    expect(r.status, r.out).toBe(0);
    noCrash(r.out);
    expect(r.out).toContain(name);
    expect(r.out).toMatch(/pasta|directory/i);
    expect(s.read(`${name}/dentro.txt`)).toBe("do dono");
    expect(r.out).toMatch(/install complete/);
    // O que vem depois (no mesmo install) foi feito: o settings.json do Claude e o .mcp.json.
    expect(s.exists(".claude/settings.json")).toBe(true);
    expect(s.exists(".mcp.json")).toBe(true);
  });

  it("os JSONs do host (.claude/settings.json, .mcp.json, .cursor/mcp.json) como pasta: avisa e segue", SLOW, () => {
    const s = sandbox();
    for (const name of [".claude/settings.json", ".mcp.json", ".cursor/mcp.json"]) s.write(`${name}/x.txt`, "do dono");

    const r = s.node("install.mjs");

    expect(r.status, r.out).toBe(0);
    noCrash(r.out);
    for (const name of [".claude/settings.json", ".mcp.json", ".cursor/mcp.json"]) {
      expect(r.out).toContain(name);
      expect(s.read(`${name}/x.txt`)).toBe("do dono");
    }
    expect(s.read("CLAUDE.md")).toContain("@aiteam/CLAUDE.md");
  });

  it("um hook do host (core.hooksPath de um diretório do host) que é uma pasta: avisa e encadeia os outros", SLOW, () => {
    const s = sandbox();
    s.git("config", "core.hooksPath", ".githooks");
    s.write(".githooks/pre-commit/x.txt", "do dono");

    const r = s.node("install.mjs");

    expect(r.status, r.out).toBe(0);
    noCrash(r.out);
    expect(r.out).toContain(".githooks/pre-commit");
    expect(s.read(".githooks/pre-commit/x.txt")).toBe("do dono");
    expect(s.read(".githooks/post-commit")).toContain("aiteam/githooks/post-commit");
  });

  it("--dry-run com pastas: também só avisa", SLOW, () => {
    const s = sandbox();
    s.write("CLAUDE.md/x.txt", "do dono");
    s.write(".mcp.json/x.txt", "do dono");
    const r = s.node("install.mjs", ["--dry-run"]);
    expect(r.status, r.out).toBe(0);
    noCrash(r.out);
  });
});

describe("install.mjs — JSON do host que não é JSON", () => {
  it("não sobrescreve: avisa e deixa o arquivo como está (era trocado pelo merge)", SLOW, () => {
    const s = sandbox();
    s.write(".claude/settings.json", "{ comentário do dono, vírgula sobrando,\n");
    s.write(".mcp.json", "isto não é json");

    const r = s.node("install.mjs");

    expect(r.status, r.out).toBe(0);
    noCrash(r.out);
    expect(s.read(".claude/settings.json")).toBe("{ comentário do dono, vírgula sobrando,\n");
    expect(s.read(".mcp.json")).toBe("isto não é json");
    expect(r.out).toContain(".claude/settings.json");
    expect(r.out).toContain(".mcp.json");
    expect(r.out).toMatch(/JSON/);
  });

  it("um arquivo vazio vale como {} e é mesclado, como antes", SLOW, () => {
    const s = sandbox();
    s.write(".mcp.json", "");
    const r = s.node("install.mjs");
    expect(r.status, r.out).toBe(0);
    expect(JSON.parse(s.read(".mcp.json")).mcpServers["rb-ai-team-tools"]).toBeDefined();
  });
});

describe("install.mjs — os avisos saem depois do banner", () => {
  it("a dica do git add -f vem depois do banner e das ações, não antes", SLOW, () => {
    const s = sandbox();
    s.write(".gitignore", ".claude/\n");

    const r = s.node("install.mjs");

    expect(r.status, r.out).toBe(0);
    const banner = r.out.search(BANNER);
    const hint = r.out.indexOf("git add -f .claude/tier-rules.json");
    expect(banner).toBeGreaterThanOrEqual(0);
    expect(hint).toBeGreaterThan(banner);
    // E depois das ações: o resumo do que o install fez vem primeiro.
    expect(hint).toBeGreaterThan(r.out.indexOf("install complete"));
  });

  it("todos os avisos juntos, depois do resumo", SLOW, () => {
    const s = sandbox();
    s.write(".gitignore", ".claude/\n");
    s.write("CLAUDE.md/x.txt", "do dono");
    s.write(".claude/tier-rules.json/x.txt", "do dono");

    const r = s.node("install.mjs");

    expect(r.status, r.out).toBe(0);
    const banner = r.out.search(BANNER);
    for (const aviso of ["CLAUDE.md", ".claude/tier-rules.json"]) {
      const at = r.out.indexOf(`⚠ ${aviso}`);
      expect(at, aviso).toBeGreaterThan(banner);
    }
    // Nenhuma linha de aviso antes do banner.
    expect(r.out.slice(0, banner)).not.toContain("⚠");
  });

  it("sem aviso nenhum, a saída é a de sempre (idempotente)", SLOW, () => {
    const s = sandbox();
    s.node("install.mjs");
    const again = s.node("install.mjs");
    expect(again.status, again.out).toBe(0);
    expect(again.out).toMatch(/already installed|nothing to change/);
    expect(again.out).not.toContain("⚠");
  });
});
