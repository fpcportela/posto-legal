import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

// O servidor de verdade, num subprocesso, falando MCP por stdio. Sem credencial do Trello ele tem de
// SUBIR (um projeto que não usa o Trello também o recebe pelo install) e só falhar na hora da
// chamada, com uma mensagem que diga o que fazer. Nenhuma requisição sai: sem credencial a
// ferramenta falha antes de montar a URL.
const AITEAM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("trello-server.ts — sobe sem credencial e falha só na chamada", () => {
  let repo = "";
  let client: Client | undefined;
  afterEach(async () => {
    await client?.close().catch(() => undefined);
    client = undefined;
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
    repo = "";
  });

  it("registra as nove ferramentas e responde a chamada com a mensagem clara", async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "trello-server-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "mcp/trello-server.ts"],
      cwd: AITEAM,
      // RB_REPO_ROOT: o .env que o servidor procura é o deste diretório, que não existe.
      env: { RB_REPO_ROOT: repo, TRELLO_API_KEY: "", TRELLO_TOKEN: "" },
      stderr: "pipe",
    });
    client = new Client({ name: "trello-server-test", version: "0.0.0" });
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "trello_add_label",
      "trello_comment_card",
      "trello_create_card",
      "trello_get_card",
      "trello_list_boards",
      "trello_list_comments",
      "trello_list_lists",
      "trello_move_card",
      "trello_sync_list",
    ]);

    // A descrição que o modelo lê: get_card e sync_list gravam no cache, e não se dizem somente leitura.
    const desc = (n: string) => tools.find((t) => t.name === n)?.description ?? "";
    for (const n of ["trello_get_card", "trello_sync_list"]) {
      expect(desc(n), n).toContain(".trello-cache");
      expect(desc(n), n).not.toMatch(/read-only/i);
    }
    expect(desc("trello_list_boards")).toMatch(/read-only/i);
    expect(desc("trello_create_card")).toMatch(/mutates the board/i);

    const call = await client.callTool({ name: "trello_list_boards", arguments: {} });
    const text = JSON.stringify(call.content);
    expect(call.isError).toBe(true);
    expect(text).toMatch(/missing TRELLO_API_KEY and TRELLO_TOKEN/);
    expect(text).toMatch(/gitignored root \.env/);

    const bad = await client.callTool({ name: "trello_create_card", arguments: { idList: "L1" } });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toMatch(/Invalid input|name/);
  }, 60_000);
});
