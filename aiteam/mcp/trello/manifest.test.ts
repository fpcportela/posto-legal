import { describe, expect, it } from "vitest";
import * as path from "path";
import {
  assertInside,
  attachmentDestPath,
  ensureImageExt,
  extractDescImageUrls,
  sanitizeFilename,
  selectImageAttachments,
  shapeCardManifest,
  type TrelloCard,
} from "./manifest.js";

describe("sanitizeFilename", () => {
  it("reduces path traversal to the basename", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("a/b\\c.png")).toBe("c.png");
  });

  it("strips CR/LF and other control characters", () => {
    const nasty = "na" + String.fromCharCode(13, 10, 9) + "me.png";
    expect(sanitizeFilename(nasty)).toBe("name.png");
  });

  it("replaces unsafe characters with underscore", () => {
    expect(sanitizeFilename('x";echo.png')).toBe("x__echo.png");
  });

  it("neutralizes leading dots and empty input", () => {
    expect(sanitizeFilename("")).toBe("file");
    expect(sanitizeFilename(".env")).toBe("_env");
  });

  // QA A-A7: nomes reservados do Windows (CON, NUL, AUX, COM1…) como pasta ou arquivo abrem um dispositivo, não
  // uma entrada de diretório — e valem com extensão (nul.txt) e em qualquer caixa. A pasta da lista e do card
  // vêm do Trello, então a defesa fica no sanitizador.
  it.each([
    "CON", "con", "PRN", "AUX", "NUL", "nul", "COM1", "com9", "LPT1", "lpt9", "Con.txt", "NUL.png", "aux.tar.gz", "COM3.anything",
  ])("neutraliza o nome reservado do Windows %s (nunca devolve o nome cru)", (name) => {
    const out = sanitizeFilename(name);
    expect(out).not.toMatch(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i);
    expect(out.startsWith("_")).toBe(true);
    expect(out.toLowerCase()).toContain(name.toLowerCase());
  });

  it("não encosta em nomes parecidos mas não reservados", () => {
    for (const name of ["console", "conn.png", "auxiliar", "nullable", "com10", "com", "lpt", "com1x", "a.con", "my-nul.png"]) {
      expect(sanitizeFilename(name), name).toBe(name);
    }
  });

  it("ponto no fim (o Windows o corta e dois nomes colidem) vira sublinhado", () => {
    expect(sanitizeFilename("a.")).toBe("a_");
    expect(sanitizeFilename("a...")).toBe("a___");
    expect(sanitizeFilename("a.b.")).toBe("a.b_");
  });

  it("a pasta da lista e a do card reservadas não viram dispositivo: attachmentDestPath", () => {
    const root = path.join(path.sep, "cache");
    expect(attachmentDestPath(root, "CON", "nul", 0, "a.png")).toBe(path.join(root, "_CON", "_nul", "01-a.png"));
  });

  it("caps length while preserving the extension", () => {
    const out = sanitizeFilename("a".repeat(200) + ".png", 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith(".png")).toBe(true);
  });
});

describe("selectImageAttachments", () => {
  it("keeps only images, by mimeType or extension", () => {
    const picked = selectImageAttachments([
      { id: "1", mimeType: "image/png", url: "https://x/y" },
      { id: "2", mimeType: "application/pdf", url: "https://x/doc.pdf", name: "doc.pdf" },
      { id: "3", url: "https://trello.com/z/photo.JPEG?token=abc" },
      { id: "4", name: "screenshot.webp" },
      { id: "5", mimeType: null, url: "https://x/nope" },
    ]);
    expect(picked.map((a) => a.id)).toEqual(["1", "3", "4"]);
  });
});

describe("extractDescImageUrls", () => {
  it("finds markdown and bare image URLs, de-duplicated", () => {
    const desc = "see ![shot](https://trello.com/a.png) and https://x.com/b.jpg done";
    expect(extractDescImageUrls(desc)).toEqual(["https://trello.com/a.png", "https://x.com/b.jpg"]);
  });
});

describe("ensureImageExt", () => {
  it("appends an extension from the mimeType only when missing", () => {
    expect(ensureImageExt("shot", "image/png")).toBe("shot.png");
    expect(ensureImageExt("shot", "image/jpeg")).toBe("shot.jpg");
    expect(ensureImageExt("shot.png", "image/png")).toBe("shot.png");
    expect(ensureImageExt("shot", null)).toBe("shot");
  });
});

describe("attachmentDestPath", () => {
  it("builds a numbered, sanitized path under the cache root", () => {
    expect(attachmentDestPath("/cache", "listABC", "cardXYZ", 0, "my shot.png")).toBe(
      path.join("/cache", "listABC", "cardXYZ", "01-my_shot.png"),
    );
  });
});

describe("assertInside — nada é gravado fora da pasta de cache", () => {
  const root = path.join(path.sep, "repo", ".trello-cache");

  it("devolve o caminho quando ele fica dentro da raiz", () => {
    const p = path.join(root, "L", "C", "01-a.png");
    expect(assertInside(root, p)).toBe(p);
  });

  it.each([
    ["sobe com ..", path.join(root, "..", "fora.png")],
    ["sobe e desce", path.join(root, "L", "..", "..", "fora.png")],
    ["é a própria raiz", root],
    ["é um irmão com o mesmo prefixo", `${root}-outro${path.sep}a.png`],
    ["é outro lugar", path.join(path.sep, "etc", "passwd")],
  ])("recusa o caminho que %s", (_nome, p) => {
    expect(() => assertInside(root, p)).toThrow(/refusing to write outside the Trello cache folder/);
  });
});

// QA A-A6 (mutante M4): o assertInside dentro do attachmentDestPath é a segunda camada — o sanitizeFilename já
// reduz as três chaves a nome-base, então nenhuma entrada real o aciona, e tirar a chamada não reprovava teste
// algum. O sanitizador é injetável para exercitar a camada sozinha: com um que deixa passar o `..`, o caminho
// que sairia da raiz tem de ser recusado POR ELA.
describe("attachmentDestPath — a conferência de contenção funciona sozinha, mesmo com um sanitizador que falhe (A-A6)", () => {
  const root = path.join(path.sep, "cache");
  const identity = (s: string) => s;

  it("sanitizador que deixa passar .. e separador: o caminho que sai da raiz é recusado", () => {
    for (const [list, card, name] of [
      ["..", "c", "a.png"],
      ["..", "..", "a.png"],
      ["l", "c", "../../../../../../../fora.png"],
      ["l/../..", "c", "a.png"],
    ] as const) {
      expect(() => attachmentDestPath(root, list, card, 0, name, identity), `${list}/${card}/${name}`).toThrow(/refusing to write outside the Trello cache folder/);
    }
  });

  it("o mesmo sanitizador, com chaves seguras, produz o caminho normal (a camada não recusa o que está dentro)", () => {
    expect(attachmentDestPath(root, "l", "c", 1, "a.png", identity)).toBe(path.join(root, "l", "c", "02-a.png"));
  });

  it("sem o parâmetro, o sanitizador é o sanitizeFilename (as chaves hostis viram nome-base)", () => {
    expect(attachmentDestPath(root, "../l", "..\\c", 0, "../../x.png")).toBe(path.join(root, "l", "c", "01-x.png"));
  });
});

describe("attachmentDestPath — as três chaves viram só o nome-base e o resultado fica dentro da raiz", () => {
  it("lista, card e arquivo com .. e separadores não escapam", () => {
    const p = attachmentDestPath(path.join(path.sep, "cache"), "../../etc", "..\\..\\x", 2, "../../../passwd.png");
    expect(p).toBe(path.join(path.sep, "cache", "etc", "x", "03-passwd.png"));
  });
});

describe("shapeCardManifest", () => {
  it("maps a raw card into the manifest shape", () => {
    const card: TrelloCard = {
      id: "id1",
      name: "Ajuste X",
      desc: "corpo",
      shortUrl: "https://trello.com/c/abc",
      idList: "list1",
      due: null,
      labels: [{ name: "bug" }, { name: "", color: "red" }],
      checklists: [{ name: "AC", checkItems: [{ name: "faz Y", state: "complete" }, { name: "faz Z", state: "incomplete" }] }],
    };
    expect(shapeCardManifest(card, ["/cache/a.png"])).toEqual({
      id: "id1",
      name: "Ajuste X",
      shortUrl: "https://trello.com/c/abc",
      idList: "list1",
      due: null,
      labels: ["bug", "red"],
      desc: "corpo",
      checklists: [{ name: "AC", items: [{ text: "faz Y", checked: true }, { text: "faz Z", checked: false }] }],
      images: ["/cache/a.png"],
    });
  });
});
