import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCard, schema } from "./get_card.js";
import { oauthHeader, type FetchLike, type FetchResponseLike } from "../client.js";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const HTML = [...Buffer.from("<html></html>")];

const res = (body: unknown, bytes?: number[]): FetchResponseLike => ({
  ok: true,
  status: 200,
  statusText: "OK",
  json: async () => body,
  text: async () => JSON.stringify(body),
  arrayBuffer: async () => new Uint8Array(bytes ?? []).buffer,
});

describe("trello_get_card", () => {
  let repo = "";
  const saved = { key: process.env["TRELLO_API_KEY"], token: process.env["TRELLO_TOKEN"], root: process.env["RB_REPO_ROOT"] };
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "trello-get-card-"));
    process.env["RB_REPO_ROOT"] = repo;
    process.env["TRELLO_API_KEY"] = "testkey";
    process.env["TRELLO_TOKEN"] = "testtoken";
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    for (const [k, v] of [["TRELLO_API_KEY", saved.key], ["TRELLO_TOKEN", saved.token], ["RB_REPO_ROOT", saved.root]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const CARD = {
    id: "ID1",
    name: "Ajuste",
    desc: "d",
    shortLink: "SHORT1",
    shortUrl: "https://trello.com/c/SHORT1",
    idList: "LIST1",
    attachments: [
      { id: "A1", name: "tela.png", url: "https://trello.com/1/cards/ID1/attachments/A1/download/tela.png", isUpload: true, mimeType: "image/png" },
      { id: "A2", name: "externo.png", url: "https://evil.example.com/x.png", isUpload: false, mimeType: "image/png" },
      { id: "A3", name: "disfarce.png", url: "https://api.trello.com/1/cards/ID1/attachments/A3/download/disfarce.png", isUpload: true, mimeType: "image/png" },
    ],
  };

  function fakeTrello() {
    const seen: Array<{ method: string; url: string; auth: string | undefined }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push({ method: init?.method ?? "GET", url, auth: init?.headers?.["Authorization"] });
      const u = new URL(url);
      if (u.pathname === "/1/cards/C1") return res(CARD);
      if (u.pathname.endsWith("/A1/download/tela.png")) return res({}, PNG);
      if (u.pathname.endsWith("/A3/download/disfarce.png")) return res({}, HTML);
      return { ...res({}), ok: false, status: 404, statusText: "Not Found" };
    };
    return { seen, fetchImpl };
  }

  const filesUnder = (dir: string): string[] =>
    fs.existsSync(dir)
      ? fs.readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/")).sort()
      : [];

  it("o destino dos arquivos não é entrada do modelo: o schema não tem cacheRoot", () => {
    expect(Object.keys(schema.shape).sort()).toEqual(["cardId", "maxImages"]);
  });

  it("um cacheRoot que o modelo mande é descartado: grava só em <repo>/.trello-cache", async () => {
    const evil = fs.mkdtempSync(path.join(os.tmpdir(), "trello-evil-"));
    try {
      const t = fakeTrello();
      const parsed = schema.parse({ cardId: "C1", cacheRoot: evil });
      expect(parsed).toEqual({ cardId: "C1" });
      await getCard({ cardId: "C1", cacheRoot: evil }, { fetchImpl: t.fetchImpl });
      expect(fs.readdirSync(evil)).toEqual([]);
      expect(filesUnder(path.join(repo, ".trello-cache"))).toEqual(["LIST1/SHORT1/01-tela.png"]);
    } finally {
      fs.rmSync(evil, { recursive: true, force: true });
    }
  });

  it("baixa só o upload que é imagem de verdade; link externo e conteúdo que não é imagem saem em errors", async () => {
    const t = fakeTrello();
    const out = JSON.parse((await getCard({ cardId: "C1" }, { fetchImpl: t.fetchImpl })).output);
    expect(out.card.images).toEqual([path.join(repo, ".trello-cache", "LIST1", "SHORT1", "01-tela.png")]);
    expect(out.errors).toEqual([
      "externo.png: attachment is not an upload (an external link): not downloaded",
      "disfarce.png: content is not a recognized image (png, jpeg, gif, webp, bmp, tiff, heic) — not saved",
    ]);
    // o header OAuth foi só para o api.trello.com, nos dois downloads; o host de terceiros não recebeu requisição
    const downloads = t.seen.filter((s) => s.url.includes("/download/"));
    expect(downloads.map((s) => [new URL(s.url).host, s.auth])).toEqual([
      ["api.trello.com", oauthHeader({ key: "testkey", token: "testtoken" })],
      ["api.trello.com", oauthHeader({ key: "testkey", token: "testtoken" })],
    ]);
    expect(t.seen.some((s) => s.url.includes("evil.example.com"))).toBe(false);
  });

  it("cacheRoot injetado no código (os testes) vale; o padrão é o do repo", async () => {
    const t = fakeTrello();
    const own = path.join(repo, "outro-cache");
    await getCard({ cardId: "C1" }, { fetchImpl: t.fetchImpl, cacheRoot: own });
    expect(filesUnder(own)).toEqual(["LIST1/SHORT1/01-tela.png"]);
    expect(fs.existsSync(path.join(repo, ".trello-cache"))).toBe(false);
  });

  it("sem credencial o erro é claro e nada é pedido", async () => {
    delete process.env["TRELLO_API_KEY"];
    delete process.env["TRELLO_TOKEN"];
    const t = fakeTrello();
    await expect(getCard({ cardId: "C1" }, { fetchImpl: t.fetchImpl })).rejects.toThrow(/missing TRELLO_API_KEY and TRELLO_TOKEN/);
    expect(t.seen).toEqual([]);
  });
});
