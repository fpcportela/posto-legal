import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { schema, syncList } from "./sync_list.js";
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

const up = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  // O nome do anexo (o que o card mostra) é independente do último segmento da URL de download: o teste do
  // nome com traversal quer chegar até a gravação, e um %2F na URL é recusado antes (client.ts).
  url: `https://trello.com/1/cards/X/attachments/${id}/download/f.png`,
  isUpload: true,
  mimeType: "image/png",
  ...extra,
});

describe("trello_sync_list", () => {
  let repo = "";
  const saved = { key: process.env["TRELLO_API_KEY"], token: process.env["TRELLO_TOKEN"], root: process.env["RB_REPO_ROOT"] };
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "trello-sync-list-"));
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

  const CARDS = [
    { id: "ID1", name: "Card 1", shortLink: "SHORT1", shortUrl: "https://trello.com/c/SHORT1", idList: "LIST1", attachments: [up("A1", "tela.png")] },
    {
      id: "ID2",
      name: "Card 2",
      shortLink: "SHORT2",
      shortUrl: "https://trello.com/c/SHORT2",
      idList: "LIST1",
      attachments: [
        up("A2", "externo.png", { url: "https://evil.example.com/x.png", isUpload: false }),
        up("A3", "falso.png", { url: "https://evil.example.com/y.png" }),
        up("A4", "disfarce.png"),
      ],
    },
    {
      id: "ID3",
      name: "Card 3",
      shortLink: "../../escape",
      shortUrl: "https://trello.com/c/x",
      idList: "LIST1",
      attachments: [up("A5", "../../../../etc/cron.d/evil.png")],
    },
  ];

  function fakeTrello(cards: unknown[] = CARDS) {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push({ url, auth: init?.headers?.["Authorization"] });
      const u = new URL(url);
      if (u.pathname === "/1/lists/LIST1/cards") return res(cards);
      if (u.pathname.includes("/A4/")) return res({}, HTML);
      if (u.pathname.includes("/attachments/")) return res({}, PNG);
      return { ...res({}), ok: false, status: 404, statusText: "Not Found" };
    };
    return { seen, fetchImpl };
  }

  const filesUnder = (dir: string): string[] =>
    fs.existsSync(dir)
      ? fs.readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/")).sort()
      : [];

  it("o destino dos arquivos não é entrada do modelo: o schema não tem cacheRoot, e o que o modelo mandar é descartado", async () => {
    expect(Object.keys(schema.shape).sort()).toEqual(["listId", "maxImagesPerCard"]);
    const evil = fs.mkdtempSync(path.join(os.tmpdir(), "trello-evil-"));
    try {
      expect(schema.parse({ listId: "LIST1", cacheRoot: evil })).toEqual({ listId: "LIST1" });
      const t = fakeTrello();
      await syncList({ listId: "LIST1", cacheRoot: evil }, { fetchImpl: t.fetchImpl });
      expect(fs.readdirSync(evil)).toEqual([]);
      expect(filesUnder(path.join(repo, ".trello-cache")).length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(evil, { recursive: true, force: true });
    }
  });

  it("grava só imagens de verdade, só de uploads, sob o cache do repo — sem escapar com o shortLink nem com o nome do anexo", async () => {
    const t = fakeTrello();
    const out = JSON.parse((await syncList({ listId: "LIST1" }, { fetchImpl: t.fetchImpl })).output);
    const cache = path.join(repo, ".trello-cache");
    expect(out.cacheRoot).toBe(cache);
    expect(filesUnder(cache)).toEqual(["LIST1/SHORT1/01-tela.png", "LIST1/escape/01-evil.png"]);
    for (const c of out.cards) for (const p of c.images) expect(path.relative(cache, p).startsWith("..")).toBe(false);
    expect(out.count).toBe(3);
    expect(out.errors).toEqual([
      "SHORT2/externo.png: attachment is not an upload (an external link): not downloaded",
      "SHORT2/falso.png: refusing to download evil.example.com: not a Trello host",
      "SHORT2/disfarce.png: content is not a recognized image (png, jpeg, gif, webp, bmp, tiff, heic) — not saved",
    ]);
  });

  it("a credencial só vai para o api.trello.com, e o host de terceiros nunca é requisitado", async () => {
    const t = fakeTrello();
    await syncList({ listId: "LIST1" }, { fetchImpl: t.fetchImpl });
    expect(t.seen.some((s) => s.url.includes("evil.example.com"))).toBe(false);
    for (const s of t.seen.filter((x) => x.url.includes("/download/"))) {
      expect(new URL(s.url).host).toBe("api.trello.com");
      expect(s.auth).toBe(oauthHeader({ key: "testkey", token: "testtoken" }));
    }
  });

  it("há um teto de downloads por sincronização, e o que ficou sem print é dito", async () => {
    const many = Array.from({ length: 4 }, (_, i) => ({
      id: `ID${i}`,
      name: `Card ${i}`,
      shortLink: `S${i}`,
      shortUrl: `https://trello.com/c/S${i}`,
      idList: "LIST1",
      attachments: [up(`B${i}a`, "a.png"), up(`B${i}b`, "b.png")],
    }));
    const t = fakeTrello(many);
    const out = JSON.parse((await syncList({ listId: "LIST1" }, { fetchImpl: t.fetchImpl, maxDownloads: 3 })).output);
    expect(filesUnder(path.join(repo, ".trello-cache")).length).toBe(3);
    expect(out.cards).toHaveLength(4);
    expect(out.errors.at(-1)).toMatch(/download cap of 3 attachments per sync reached.*trello_get_card/);
  });

  // QA A-A4: 200 downloads × 25 MB eram 5 GB por chamada. Há também um teto de bytes por sincronização.
  it("o teto de bytes por sincronização para de baixar quando o orçamento acaba, e diz", async () => {
    const many = Array.from({ length: 4 }, (_, i) => ({
      id: `ID${i}`,
      name: `Card ${i}`,
      shortLink: `S${i}`,
      shortUrl: `https://trello.com/c/S${i}`,
      idList: "LIST1",
      attachments: [up(`C${i}`, "a.png")],
    }));
    const t = fakeTrello(many);
    // cada PNG do fake tem 12 bytes: com 30 de orçamento cabem 2
    const out = JSON.parse((await syncList({ listId: "LIST1" }, { fetchImpl: t.fetchImpl, maxBytes: 30 })).output);
    expect(filesUnder(path.join(repo, ".trello-cache")).length).toBe(2);
    expect(out.cards).toHaveLength(4);
    expect(out.errors.at(-1)).toMatch(/byte cap of 30 bytes per sync reached.*trello_get_card/);
  });

  // Revisão de segurança: o orçamento só descontava o download que deu certo, então uma sequência de anexos
  // recusados NO MEIO do stream (o servidor não manda Content-Length) lia além do teto total sem que nada contasse.
  function streamingTrello(cards: unknown[], chunkSize = 10, chunks = 10) {
    const downloads: string[] = [];
    let bytesServed = 0;
    const fetchImpl: FetchLike = async (url) => {
      const u = new URL(url);
      if (u.pathname === "/1/lists/LIST1/cards") return res(cards);
      downloads.push(u.pathname);
      let sent = 0;
      return {
        ...res({}),
        body: {
          getReader: () => ({
            read: async () => {
              if (sent >= chunks) return { done: true };
              sent++;
              bytesServed += chunkSize;
              const value = new Uint8Array(chunkSize);
              if (sent === 1) value.set(PNG.slice(0, Math.min(PNG.length, chunkSize)));
              return { done: false, value };
            },
            cancel: async () => undefined,
          }),
        },
      } as FetchResponseLike;
    };
    return { fetchImpl, downloads, served: () => bytesServed };
  }
  const oneAttCards = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `ID${i}`,
      name: `Card ${i}`,
      shortLink: `S${i}`,
      shortUrl: `https://trello.com/c/S${i}`,
      idList: "LIST1",
      attachments: [up(`D${i}`, "a.png")],
    }));

  it("anexos recusados no meio do stream gastam o orçamento: o sync para, sem ler além do teto, e diz", async () => {
    const t = streamingTrello(oneAttCards(5), 10, 10); // cada anexo manda 100 bytes, sem Content-Length
    const out = JSON.parse((await syncList({ listId: "LIST1" }, { fetchImpl: t.fetchImpl, maxBytes: 25 })).output);
    expect(t.downloads).toHaveLength(1); // o 1º estoura o orçamento; os outros 4 nem são pedidos
    expect(t.served()).toBe(30); // o teto (25) mais o pedaço que o estourou — não os 500 do total
    expect(filesUnder(path.join(repo, ".trello-cache"))).toEqual([]);
    expect(out.cards).toHaveLength(5);
    expect(out.errors.at(-1)).toMatch(/byte cap of 25 bytes per sync reached.*trello_get_card/);
    expect(out.errors.some((e: string) => /larger than 25 bytes/.test(e))).toBe(true);
    expect(out.errors.filter((e: string) => /byte cap of this sync is used up/.test(e))).toHaveLength(4);
  });

  it("um que dá certo e um que estoura: o orçamento é o que sobrou, e o terceiro nem é pedido", async () => {
    const cards = oneAttCards(3);
    const small = { ...res({}), arrayBuffer: async () => new Uint8Array(PNG).buffer } as FetchResponseLike;
    const big = streamingTrello(cards, 10, 10);
    const downloads: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const u = new URL(url);
      if (u.pathname.includes("/attachments/")) downloads.push(u.pathname);
      if (u.pathname.includes("/D0/")) return small;
      return big.fetchImpl(url, init);
    };
    const out = JSON.parse((await syncList({ listId: "LIST1" }, { fetchImpl, maxBytes: 40 })).output);
    expect(downloads).toEqual(["/1/cards/X/attachments/D0/download/f.png", "/1/cards/X/attachments/D1/download/f.png"]);
    expect(filesUnder(path.join(repo, ".trello-cache"))).toEqual(["LIST1/S0/01-a.png"]);
    expect(out.errors.at(-1)).toMatch(/byte cap of 40 bytes per sync reached/);
  });

  it("o orçamento padrão cobre um uso normal (nenhum aviso de teto)", async () => {
    const t = fakeTrello();
    const out = JSON.parse((await syncList({ listId: "LIST1" }, { fetchImpl: t.fetchImpl })).output);
    expect(out.errors.join("\n")).not.toMatch(/cap of/);
  });

  it("cacheRoot injetado no código (os testes) vale", async () => {
    const t = fakeTrello();
    const own = path.join(repo, "meu-cache");
    await syncList({ listId: "LIST1" }, { fetchImpl: t.fetchImpl, cacheRoot: own });
    expect(filesUnder(own)).toContain("LIST1/SHORT1/01-tela.png");
    expect(fs.existsSync(path.join(repo, ".trello-cache"))).toBe(false);
  });
});
