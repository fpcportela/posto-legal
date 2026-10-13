import { afterEach, describe, expect, it } from "vitest";
import { makeSandbox, SLOW, type Sandbox } from "./beads-sandbox.js";

// O install.mjs roda como subprocesso num repo descartável (o que um consumidor vê ao receber o PR do
// aiteam-sync). rb-ai-team#28/#50: o MCP do Trello vem no framework (aiteam/mcp/trello-server.ts), o
// install o registra no .mcp.json — sem nunca tocar no trello-tools que o consumidor já aponta para a
// cópia local dele; a troca é decisão do consumidor, pelo checklist do sync — e o cache dos prints
// fica fora do git.

let sb: Sandbox | undefined;
const sandbox = (): Sandbox => {
  sb = makeSandbox();
  return sb;
};
afterEach(() => sb?.cleanup());

type McpFile = { mcpServers: Record<string, { command?: string; args?: string[]; description?: string }> };
const mcpOf = (s: Sandbox, rel = ".mcp.json"): McpFile => JSON.parse(s.read(rel));

describe("install.mjs — o trello-tools no .mcp.json", () => {
  it("consumidor novo: registra o servidor do framework ao lado do rb-ai-team-tools, e é idempotente", SLOW, () => {
    const s = sandbox();
    const first = s.node("install.mjs");
    expect(first.status, first.out).toBe(0);
    const servers = mcpOf(s).mcpServers;
    expect(Object.keys(servers).sort()).toEqual(["rb-ai-team-tools", "trello-tools"]);
    expect(servers["trello-tools"]).toMatchObject({ command: "npx", args: ["tsx", "aiteam/mcp/trello-server.ts"] });
    expect(servers["trello-tools"]!.description).toMatch(/TRELLO_API_KEY/);
    expect(servers["trello-tools"]!.description).toMatch(/Tier 2/);

    const before = s.read(".mcp.json");
    const again = s.node("install.mjs");
    expect(again.status, again.out).toBe(0);
    expect(s.read(".mcp.json")).toBe(before);
  });

  // QA A-A8: o rótulo dizia "added the rb-ai-team-tools server" mesmo quando só o trello-tools entrou.
  it("o rótulo do install nomeia os servidores que de fato entraram", SLOW, () => {
    const fresh = sandbox();
    const r = fresh.node("install.mjs");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/\.mcp\.json — added the rb-ai-team-tools and trello-tools servers/);

    const only = makeSandbox();
    try {
      // o consumidor já tem o rb-ai-team-tools (como os consumidores de hoje): só o trello-tools falta
      only.write(".mcp.json", `${JSON.stringify({ mcpServers: { "rb-ai-team-tools": { command: "npx", args: ["tsx", "aiteam/mcp/server.ts"] } } }, null, 2)}\n`);
      const o = only.node("install.mjs");
      expect(o.status, o.out).toBe(0);
      expect(o.out).toMatch(/\.mcp\.json — added the trello-tools server\b/);
      expect(o.out).not.toMatch(/\.mcp\.json — added the .*rb-ai-team-tools/);
      expect(o.out).toMatch(/\.cursor\/mcp\.json — added the rb-ai-team-tools and trello-tools servers/);
      // e quando nada falta, o install não diz que acrescentou nada ao .mcp.json
      const again = only.node("install.mjs");
      expect(again.out).not.toMatch(/\.mcp\.json — added/);
    } finally {
      only.cleanup();
    }
  });

  it("o trello-tools que o consumidor já aponta para a cópia local dele NÃO é sobrescrito", SLOW, () => {
    const s = sandbox();
    const local = { command: "npx", args: ["tsx", ".mcp/trello-server.ts"], description: "Trello local do projeto" };
    s.write(".mcp.json", `${JSON.stringify({ mcpServers: { "trello-tools": local, outro: { command: "x" } } }, null, 2)}\n`);

    const r = s.node("install.mjs");
    expect(r.status, r.out).toBe(0);
    const servers = mcpOf(s).mcpServers;
    expect(servers["trello-tools"]).toEqual(local);
    expect(servers["outro"]).toEqual({ command: "x" });
    expect(servers["rb-ai-team-tools"]).toBeDefined();
  });

  it("o .cursor/mcp.json recebe o mesmo registro, e o do consumidor também é preservado", SLOW, () => {
    const s = sandbox();
    expect(s.node("install.mjs").status).toBe(0);
    expect(mcpOf(s, ".cursor/mcp.json").mcpServers["trello-tools"]!.args).toEqual(["tsx", "aiteam/mcp/trello-server.ts"]);

    const t = makeSandbox();
    try {
      const local = { command: "node", args: ["meu-trello.js"] };
      t.write(".cursor/mcp.json", JSON.stringify({ mcpServers: { "trello-tools": local } }));
      expect(t.node("install.mjs").status).toBe(0);
      expect(mcpOf(t, ".cursor/mcp.json").mcpServers["trello-tools"]).toEqual(local);
    } finally {
      t.cleanup();
    }
  });
});

// O install lê os arquivos do host com readOptionalFile (#54): o que não dá para ler, ou o JSON que não
// parseia, vira AVISO e o arquivo não é tocado. O registro do trello-tools e a regra do .trello-cache
// seguem o mesmo fluxo — nunca o leitor antigo (existsSync + readFileSync), que estourava com a stack do
// Node, nem o `?? {}`, que trocava o JSON do dono pelo resultado da mescla.
describe("install.mjs — o registro do trello-tools e a regra do cache no fluxo de leitura do host", () => {
  const BANNER = /aiteam install( \(dry-run\))? — repo root/;

  it(".mcp.json do host que não é JSON: avisa uma vez, não toca, e o trello-tools não é registrado ali", SLOW, () => {
    const s = sandbox();
    s.write(".mcp.json", '{ "mcpServers": { "meu": ');
    const r = s.node("install.mjs");
    expect(r.status, r.out).toBe(0);
    expect(s.read(".mcp.json")).toBe('{ "mcpServers": { "meu": ');
    expect(r.out.match(/\.mcp\.json não é JSON válido/g)).toHaveLength(1);
    expect(r.out).not.toMatch(/\.mcp\.json — added/);
    // o resto do install seguiu, inclusive o .cursor/mcp.json (que é outro arquivo)
    expect(mcpOf(s, ".cursor/mcp.json").mcpServers["trello-tools"]).toBeDefined();
    // os avisos saem depois do banner
    expect(r.out.search(/\.mcp\.json não é JSON válido/)).toBeGreaterThan(r.out.search(BANNER));
  });

  it(".gitignore que é uma pasta: UM aviso (não dois, um por regra), o arquivo do dono intacto, e o install termina", SLOW, () => {
    const s = sandbox();
    s.write(".gitignore/dentro.txt", "do dono");
    const r = s.node("install.mjs");
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toMatch(/EISDIR|node:internal|\n\s+at /);
    expect(r.out.match(/\.gitignore existe mas não pôde ser lido/g)).toHaveLength(1);
    expect(s.read(".gitignore/dentro.txt")).toBe("do dono");
    expect(r.out).toMatch(/install complete/);
  });

  it("--dry-run: diz que registraria o trello-tools e a regra do cache, e não escreve nem um nem outro", SLOW, () => {
    const s = sandbox();
    const r = s.node("install.mjs", ["--dry-run"]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/\.mcp\.json — added the rb-ai-team-tools and trello-tools servers/);
    expect(r.out).toMatch(/\.gitignore — acrescentada a regra \.trello-cache\//);
    expect(s.exists(".mcp.json")).toBe(false);
    expect(s.exists(".gitignore")).toBe(false);
  });
});

describe("install.mjs — .trello-cache/ no .gitignore", () => {
  const ignored = (s: Sandbox, rel: string): boolean => s.gitTry("check-ignore", "-q", rel).status === 0;

  it("os prints baixados dos cards ficam fora do git: são telas internas e dados de cliente do time", SLOW, () => {
    const s = sandbox();
    const r = s.node("install.mjs");
    expect(r.status, r.out).toBe(0);
    expect(s.read(".gitignore")).toContain("\n.trello-cache/\n");
    s.write(".trello-cache/LIST1/SHORT1/01-tela.png", "x");
    expect(ignored(s, ".trello-cache/LIST1/SHORT1/01-tela.png")).toBe(true);
    expect(s.git("status", "--porcelain", "--", ".trello-cache")).toBe("");
  });

  it("acrescenta no fim do .gitignore do consumidor, preserva o resto e é idempotente", SLOW, () => {
    const s = sandbox();
    s.write(".gitignore", "node_modules/\n.env\n");
    expect(s.node("install.mjs").status).toBe(0);
    const once = s.read(".gitignore");
    expect(once.startsWith("node_modules/\n.env\n")).toBe(true);
    expect(once.split("\n").filter((l) => l === ".trello-cache/")).toHaveLength(1);
    const again = s.node("install.mjs");
    expect(again.out).not.toMatch(/\.gitignore/);
    expect(s.read(".gitignore")).toBe(once);
  });

  it.each([["/.trello-cache"], [".trello-cache"], [".trello-cache/*"]])("não duplica quando o consumidor já ignora a pasta como %s", SLOW, (spelling) => {
    const s = sandbox();
    s.write(".gitignore", `${spelling}\n/.claude/worktrees\n/.superpowers\n`);
    expect(s.node("install.mjs").status).toBe(0);
    expect(s.read(".gitignore")).toBe(`${spelling}\n/.claude/worktrees\n/.superpowers\n`);
  });
});
