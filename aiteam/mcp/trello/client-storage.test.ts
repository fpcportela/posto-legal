import { describe, expect, it } from "vitest";
import { classifyDownloadUrl, fetchAttachment, type FetchResponseLike } from "./client.js";

// O armazenamento do Trello no download de anexo (client.ts, isStorageHost): separado do client.test.ts
// para a negativa do host ser lida — e quebrada por mutação — sozinha.
const creds = { key: "KEY123", token: "TOK456" };

function fakeResponse(partial: Partial<FetchResponseLike>): FetchResponseLike {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({}),
    text: async () => "",
    arrayBuffer: async () => new ArrayBuffer(0),
    ...partial,
  };
}

// QA A-2 (mutante M31): o armazenamento do Trello é UM bucket exato (trello-attachments.s3.amazonaws.com) e o
// domínio trellousercontent.com e seus subdomínios. Qualquer outro bucket do S3 — inclusive o de outra
// conta, ou o mesmo nome em path-style — NÃO é armazenamento do Trello: é host de terceiros, e a regra é a
// de qualquer host de terceiros (recusado antes de haver requisição; nunca recebe credencial). Um mutante que
// afrouxasse o teste do host (`endsWith(".s3.amazonaws.com")`, `endsWith("amazonaws.com")`, `includes(...)`)
// aceitaria estes, e nenhum teste o pegava.
describe("o armazenamento do Trello é só o bucket exato e o trellousercontent.com (A-2)", () => {
  const NOT_STORAGE = [
    "https://other-bucket.s3.amazonaws.com/x.png",
    "https://s3.amazonaws.com/trello-attachments/x.png",
    "https://trello-attachments.s3.amazonaws.com.evil.example/x.png",
    "https://evil-trello-attachments.s3.amazonaws.com/x.png",
    "https://trello-attachments.s3.eu-west-1.amazonaws.com/x.png",
    "https://trello-attachments.s3-eu-west-1.amazonaws.com/x.png",
    "https://amazonaws.com/x.png",
    "https://eviltrellousercontent.com/x.png",
    "https://trellousercontent.com.evil.example/x.png",
    "https://sub.trellousercontent.com.evil.example/x.png",
    "https://trellousercontent.co/x.png",
    "https://evil.com/trellousercontent.com/x.png",
  ];

  it.each(NOT_STORAGE)("%s não é armazenamento do Trello: recusado, e nunca como 'sem credencial' (que o deixaria baixar)", (url) => {
    expect(() => classifyDownloadUrl(url, true)).toThrow(/refusing to download .*: not a Trello host/);
  });

  it.each(NOT_STORAGE)("%s: pedido direto não gera requisição nenhuma", async (url) => {
    const seen: Array<{ url: string; headers: Record<string, string> | undefined }> = [];
    await expect(
      fetchAttachment(url, true, creds, async (u, init) => {
        seen.push({ url: u, headers: init?.headers });
        return fakeResponse({ arrayBuffer: async () => new Uint8Array([1]).buffer });
      }),
    ).rejects.toThrow(/refusing to download/);
    expect(seen).toEqual([]);
  });

  it.each(NOT_STORAGE)("%s: um redirect do endpoint para ele é bloqueado, e o segundo salto nunca é requisitado", async (target) => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const first = fakeResponse({ status: 302, statusText: "Found", headers: { get: (n) => (n.toLowerCase() === "location" ? target : null) } });
    await expect(
      fetchAttachment("https://api.trello.com/1/cards/c1/attachments/a1/download/f.png", true, creds, async (u, init) => {
        seen.push({ url: u, auth: init?.headers?.["Authorization"] });
        return first;
      }),
    ).rejects.toThrow(/refusing to download/);
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]!.url).host).toBe("api.trello.com");
  });

  it("os que SÃO armazenamento continuam: o bucket exato, o domínio e os subdomínios — sem credencial", () => {
    for (const url of [
      "https://trello-attachments.s3.amazonaws.com/b/c/a/h/f.png",
      "https://trellousercontent.com/f.png",
      "https://trellocdn.trellousercontent.com/f.png",
      "https://a.b.trellousercontent.com/f.png",
    ]) {
      expect(classifyDownloadUrl(url, true), url).toEqual({ url, credentialed: false });
    }
  });
});

