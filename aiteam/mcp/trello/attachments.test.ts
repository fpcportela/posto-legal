import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultCacheRoot, downloadCardImages, sniffImage } from "./attachments.js";
import { oauthHeader, type FetchLike, type FetchResponseLike } from "./client.js";
import type { TrelloCard } from "./manifest.js";

const creds = { key: "KEY123", token: "TOK456" };

// Os bytes de abertura de cada formato que a ferramenta aceita.
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46];
const GIF = [...Buffer.from("GIF89a"), 1, 0, 1, 0];
const WEBP = [...Buffer.from("RIFF"), 4, 0, 0, 0, ...Buffer.from("WEBPVP8 ")];
const BMP = [0x42, 0x4d, 10, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0];
const TIFF_LE = [0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0];
const TIFF_BE = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8];
const HEIC = [0, 0, 0, 24, ...Buffer.from("ftypheic"), 0, 0, 0, 0];
const HTML = [...Buffer.from("<html><script>alert(1)</script></html>")];
const SVG = [...Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')];
const EXE = [0x4d, 0x5a, 0x90, 0x00, 3, 0, 0, 0];

describe("sniffImage — o tipo vem do conteúdo, nunca do nome nem do mimeType que o Trello informa", () => {
  it.each([
    ["png", PNG, "png", "image/png"],
    ["jpeg", JPEG, "jpg", "image/jpeg"],
    ["gif", GIF, "gif", "image/gif"],
    ["webp", WEBP, "webp", "image/webp"],
    ["bmp", BMP, "bmp", "image/bmp"],
    ["tiff (little endian)", TIFF_LE, "tiff", "image/tiff"],
    ["tiff (big endian)", TIFF_BE, "tiff", "image/tiff"],
    ["heic", HEIC, "heic", "image/heic"],
  ])("reconhece %s", (_nome, bytes, ext, mime) => {
    expect(sniffImage(Buffer.from(bytes))).toEqual({ ext, mime });
  });

  it.each([
    ["html", HTML],
    ["svg (XML com script)", SVG],
    ["executável", EXE],
    ["vazio", []],
    ["curto demais", [0x89, 0x50]],
    ["RIFF que não é webp", [...Buffer.from("RIFF"), 4, 0, 0, 0, ...Buffer.from("WAVEfmt ")]],
    ["BM sem o campo reservado zerado", [0x42, 0x4d, 1, 2, 3, 4, 9, 9, 9, 9, 0, 0, 0, 0]],
    ["ftyp que não é heic", [0, 0, 0, 24, ...Buffer.from("ftypmp42"), 0, 0, 0, 0]],
  ])("recusa %s", (_nome, bytes) => {
    expect(sniffImage(Buffer.from(bytes))).toBeNull();
  });
});

describe("defaultCacheRoot", () => {
  const saved = process.env["RB_REPO_ROOT"];
  afterEach(() => {
    if (saved === undefined) delete process.env["RB_REPO_ROOT"];
    else process.env["RB_REPO_ROOT"] = saved;
  });

  it("é .trello-cache na raiz do repo — não no cwd", () => {
    process.env["RB_REPO_ROOT"] = path.join(os.tmpdir(), "raiz-do-repo");
    expect(defaultCacheRoot()).toBe(path.join(os.tmpdir(), "raiz-do-repo", ".trello-cache"));
  });
});

// ── downloadCardImages ───────────────────────────────────────────────────────

const res = (body: number[], extra: Partial<FetchResponseLike> = {}): FetchResponseLike => ({
  ok: true,
  status: 200,
  statusText: "OK",
  json: async () => ({}),
  text: async () => "",
  arrayBuffer: async () => new Uint8Array(body).buffer,
  ...extra,
});

describe("downloadCardImages", () => {
  let cache = "";
  beforeEach(() => {
    cache = fs.mkdtempSync(path.join(os.tmpdir(), "trello-cache-"));
  });
  afterEach(() => {
    fs.rmSync(cache, { recursive: true, force: true });
  });

  /** O Trello falso: o conteúdo de cada URL, e o registro do que foi pedido e com qual header. */
  function fakeStorage(byUrl: Record<string, number[]>) {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push({ url, auth: init?.headers?.["Authorization"] });
      const body = byUrl[url];
      if (!body) return res([], { ok: false, status: 404, statusText: "Not Found" });
      return res(body);
    };
    return { seen, fetchImpl };
  }

  const DL = (id: string, name: string) => `https://api.trello.com/1/cards/C1/attachments/${id}/download/${name}`;
  const card = (attachments: NonNullable<TrelloCard["attachments"]>): TrelloCard => ({ id: "ID1", name: "Card", shortLink: "SHORT1", idList: "LIST1", attachments });
  const filesUnder = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/")).sort();
  const run = (c: TrelloCard, fetchImpl: FetchLike, cap = 20) => downloadCardImages(c, { cacheRoot: cache, listKey: "LIST1", cap, creds, fetchImpl });

  it("grava sob <cache>/<lista>/<card>/NN-<nome>.<ext>, com a extensão do conteúdo", async () => {
    const t = fakeStorage({ [DL("A1", "shot.png")]: PNG, [DL("A2", "foto.jpg")]: JPEG });
    const out = await run(
      card([
        { id: "A1", name: "shot.png", url: "https://trello.com/1/cards/C1/attachments/A1/download/shot.png", isUpload: true, mimeType: "image/png" },
        { id: "A2", name: "foto.jpg", url: "https://trello.com/1/cards/C1/attachments/A2/download/foto.jpg", isUpload: true, mimeType: "image/jpeg" },
      ]),
      t.fetchImpl,
    );
    expect(out.errors).toEqual([]);
    expect(out.paths.map((p) => path.relative(cache, p).split(path.sep).join("/"))).toEqual(["LIST1/SHORT1/01-shot.png", "LIST1/SHORT1/02-foto.jpg"]);
    expect([...fs.readFileSync(out.paths[0]!)]).toEqual(PNG);
    // só o api.trello.com recebeu o header
    expect(t.seen.map((s) => [new URL(s.url).host, s.auth])).toEqual([
      ["api.trello.com", oauthHeader(creds)],
      ["api.trello.com", oauthHeader(creds)],
    ]);
  });

  it("a extensão sai do conteúdo: um PNG chamado .exe (ou sem extensão) é gravado como .png", async () => {
    const t = fakeStorage({ [DL("A1", "x")]: PNG, [DL("A2", "y")]: JPEG });
    const out = await run(
      card([
        { id: "A1", name: "relatorio.exe", url: DL("A1", "x"), isUpload: true, mimeType: "image/png" },
        { id: "A2", name: "semextensao", url: DL("A2", "y"), isUpload: true, mimeType: "image/jpeg" },
      ]),
      t.fetchImpl,
    );
    expect(out.errors).toEqual([]);
    expect(filesUnder(cache)).toEqual(["LIST1/SHORT1/01-relatorio.png", "LIST1/SHORT1/02-semextensao.jpg"]);
  });

  it("o que não é imagem NÃO é gravado, mesmo com mimeType e nome de imagem: html, svg, executável", async () => {
    const t = fakeStorage({ [DL("A1", "a.png")]: HTML, [DL("A2", "b.png")]: SVG, [DL("A3", "c.png")]: EXE });
    const out = await run(
      card([
        { id: "A1", name: "a.png", url: DL("A1", "a.png"), isUpload: true, mimeType: "image/png" },
        { id: "A2", name: "b.png", url: DL("A2", "b.png"), isUpload: true, mimeType: "image/png" },
        { id: "A3", name: "c.png", url: DL("A3", "c.png"), isUpload: true, mimeType: "image/png" },
      ]),
      t.fetchImpl,
    );
    expect(out.paths).toEqual([]);
    expect(out.errors).toHaveLength(3);
    expect(out.errors[0]).toMatch(/^a\.png: content is not a recognized image/);
    expect(fs.existsSync(path.join(cache, "LIST1"))).toBe(false);
  });

  it("nome com separador de caminho, traversal e caracteres de controle vira só o nome-base, sem sair do cache", async () => {
    const t = fakeStorage({ [DL("A1", "n")]: PNG, [DL("A2", "n")]: PNG, [DL("A3", "n")]: PNG });
    const out = await run(
      card([
        { id: "A1", name: "../../../../etc/cron.d/evil.png", url: DL("A1", "n"), isUpload: true, mimeType: "image/png" },
        { id: "A2", name: "..\\..\\Windows\\System32\\x.png", url: DL("A2", "n"), isUpload: true, mimeType: "image/png" },
        { id: "A3", name: "a\r\nb\tc.png", url: DL("A3", "n"), isUpload: true, mimeType: "image/png" },
      ]),
      t.fetchImpl,
    );
    expect(out.errors).toEqual([]);
    for (const p of out.paths) expect(path.relative(cache, p).startsWith("..")).toBe(false);
    expect(filesUnder(cache)).toEqual(["LIST1/SHORT1/01-evil.png", "LIST1/SHORT1/02-x.png", "LIST1/SHORT1/03-abc.png"]);
  });

  it("listKey e cardKey malformados (barra, ..) não escapam do cache", async () => {
    const t = fakeStorage({ [DL("A1", "n")]: PNG });
    const evil: TrelloCard = { id: "ID1", name: "C", shortLink: "../../../fora", idList: "L", attachments: [{ id: "A1", name: "a.png", url: DL("A1", "n"), isUpload: true, mimeType: "image/png" }] };
    const out = await downloadCardImages(evil, { cacheRoot: cache, listKey: "..\\..\\fora2", cap: 5, creds, fetchImpl: t.fetchImpl });
    expect(out.errors).toEqual([]);
    for (const p of out.paths) expect(path.relative(cache, p).startsWith("..")).toBe(false);
  });

  it("link externo e host de terceiros: nenhuma requisição, e o motivo vai em errors", async () => {
    const t = fakeStorage({});
    const out = await run(
      card([
        { id: "A1", name: "link.png", url: "https://evil.example.com/x.png", isUpload: false, mimeType: "image/png" },
        { id: "A2", name: "falso.png", url: "https://evil.example.com/y.png", isUpload: true, mimeType: "image/png" },
        { id: "A3", name: "semurl.png", isUpload: true, mimeType: "image/png" },
      ]),
      t.fetchImpl,
    );
    expect(t.seen).toEqual([]);
    expect(out.paths).toEqual([]);
    expect(out.errors).toEqual([
      "link.png: attachment is not an upload (an external link): not downloaded",
      "falso.png: refusing to download evil.example.com: not a Trello host",
      "semurl.png: the attachment has no url",
    ]);
  });

  it("o teto de imagens por card vale, e a numeração só conta as gravadas", async () => {
    const t = fakeStorage({ [DL("A1", "n")]: HTML, [DL("A2", "n")]: PNG, [DL("A3", "n")]: PNG });
    const out = await run(
      card([
        { id: "A1", name: "a.png", url: DL("A1", "n"), isUpload: true, mimeType: "image/png" },
        { id: "A2", name: "b.png", url: DL("A2", "n"), isUpload: true, mimeType: "image/png" },
        { id: "A3", name: "c.png", url: DL("A3", "n"), isUpload: true, mimeType: "image/png" },
      ]),
      t.fetchImpl,
      2,
    );
    expect(filesUnder(cache)).toEqual(["LIST1/SHORT1/01-b.png"]);
    expect(out.errors).toHaveLength(1);
  });

  it("erro de download de um anexo não derruba os outros nem vaza o token", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("/A1/")) throw new Error(`socket hang up ${url}`);
      return res(PNG);
    };
    const out = await run(
      card([
        { id: "A1", name: "a.png", url: DL("A1", "n"), isUpload: true, mimeType: "image/png" },
        { id: "A2", name: "b.png", url: DL("A2", "n"), isUpload: true, mimeType: "image/png" },
      ]),
      fetchImpl,
    );
    expect(out.paths).toHaveLength(1);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).not.toMatch(/KEY123|TOK456/);
  });

  // QA A-A1: path.relative confere o TEXTO do caminho, e um symlink ou uma junction dentro do cache é
  // seguido pelo mkdir e pela escrita — quem pode criar um link ali (um script, um pacote, outra ferramenta)
  // transforma "dentro do cache" em "onde o link apontar". A junction de verdade, não um mock.
  describe("link simbólico ou junction dentro do cache (A-A1)", () => {
    let outside = "";
    beforeEach(() => {
      outside = fs.mkdtempSync(path.join(os.tmpdir(), "trello-outside-"));
    });
    afterEach(() => {
      fs.rmSync(outside, { recursive: true, force: true });
    });

    const one = card([{ id: "A1", name: "a.png", url: DL("A1", "n"), isUpload: true, mimeType: "image/png" }]);
    const linkTo = (target: string, at: string) => fs.symlinkSync(target, at, "junction"); // junction no Windows, symlink no resto

    it("a pasta da lista é uma junction para fora: nada é gravado lá, e o erro diz o porquê", async () => {
      linkTo(outside, path.join(cache, "LIST1"));
      const out = await run(one, fakeStorage({ [DL("A1", "n")]: PNG }).fetchImpl);
      expect(out.paths).toEqual([]);
      expect(out.errors).toHaveLength(1);
      expect(out.errors[0]).toMatch(/^a\.png: refusing to write through a symbolic link or junction inside the Trello cache/);
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    it("a pasta do card (um nível abaixo) é a junction", async () => {
      fs.mkdirSync(path.join(cache, "LIST1"));
      linkTo(outside, path.join(cache, "LIST1", "SHORT1"));
      const out = await run(one, fakeStorage({ [DL("A1", "n")]: PNG }).fetchImpl);
      expect(out.paths).toEqual([]);
      expect(out.errors[0]).toMatch(/symbolic link or junction/);
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    it("o link aponta para dentro do próprio cache: também recusa (o destino real não é o caminho pedido)", async () => {
      const real = path.join(cache, "real");
      fs.mkdirSync(real);
      linkTo(real, path.join(cache, "LIST1"));
      const out = await run(one, fakeStorage({ [DL("A1", "n")]: PNG }).fetchImpl);
      expect(out.paths).toEqual([]);
      expect(fs.readdirSync(real)).toEqual([]);
    });

    it("o arquivo de destino já existe como link simbólico: não escreve através dele (só onde o SO deixa criar o link)", async () => {
      fs.mkdirSync(path.join(cache, "LIST1", "SHORT1"), { recursive: true });
      const victim = path.join(outside, "vitima.png");
      fs.writeFileSync(victim, "intacto");
      try {
        fs.symlinkSync(victim, path.join(cache, "LIST1", "SHORT1", "01-a.png"), "file");
      } catch {
        return; // sem privilégio para criar symlink de arquivo (Windows sem modo desenvolvedor): a junction acima já cobre o caso
      }
      const out = await run(one, fakeStorage({ [DL("A1", "n")]: PNG }).fetchImpl);
      expect(out.paths).toEqual([]);
      expect(out.errors[0]).toMatch(/symbolic link or junction/);
      expect(fs.readFileSync(victim, "utf8")).toBe("intacto");
    });

    it("o cacheRoot em si ser um link (a escolha de quem configurou) continua valendo: o que se confere é o que está DENTRO dele", async () => {
      const real = fs.mkdtempSync(path.join(os.tmpdir(), "trello-real-cache-"));
      const link = path.join(os.tmpdir(), `trello-link-cache-${path.basename(real)}`);
      try {
        linkTo(real, link);
        const out = await downloadCardImages(one, { cacheRoot: link, listKey: "LIST1", cap: 5, creds, fetchImpl: fakeStorage({ [DL("A1", "n")]: PNG }).fetchImpl });
        expect(out.errors).toEqual([]);
        expect(out.paths).toHaveLength(1);
        expect(fs.existsSync(path.join(real, "LIST1", "SHORT1", "01-a.png"))).toBe(true);
      } finally {
        fs.rmSync(link, { recursive: true, force: true });
        fs.rmSync(real, { recursive: true, force: true });
      }
    });

    it("sem link nenhum, nada muda: a pasta é criada e o arquivo gravado", async () => {
      const out = await run(one, fakeStorage({ [DL("A1", "n")]: PNG }).fetchImpl);
      expect(out.errors).toEqual([]);
      expect(filesUnder(cache)).toEqual(["LIST1/SHORT1/01-a.png"]);
    });
  });
});
