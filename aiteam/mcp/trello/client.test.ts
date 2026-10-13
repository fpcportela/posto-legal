import { describe, expect, it } from "vitest";
import {
  buildUrl,
  classifyDownloadUrl,
  fetchAttachment,
  oauthHeader,
  redactSecrets,
  trelloGet,
  trelloMutate,
  type FetchLike,
  type FetchResponseLike,
} from "./client.js";

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

describe("buildUrl", () => {
  it("appends key and token and url-encodes params", () => {
    const url = buildUrl("/members/me/boards", { fields: "name,url" }, creds);
    expect(url.startsWith("https://api.trello.com/1/members/me/boards?")).toBe(true);
    expect(url).toContain("key=KEY123");
    expect(url).toContain("token=TOK456");
    expect(url).toContain("fields=name%2Curl");
  });

  it("skips undefined params", () => {
    const url = buildUrl("/x", { a: undefined, b: "1" }, creds);
    expect(url).not.toMatch(/[?&]a=/);
    expect(url).toContain("b=1");
  });
});

describe("oauthHeader", () => {
  it("formats the OAuth Authorization header", () => {
    expect(oauthHeader(creds)).toBe('OAuth oauth_consumer_key="KEY123", oauth_token="TOK456"');
  });
});

describe("redactSecrets", () => {
  it("removes key and token occurrences", () => {
    const r = redactSecrets("boom key=KEY123 token=TOK456", creds);
    expect(r).not.toContain("KEY123");
    expect(r).not.toContain("TOK456");
  });
});

describe("trelloGet", () => {
  it("returns parsed json on ok", async () => {
    const fetchImpl: FetchLike = async () => fakeResponse({ json: async () => [{ id: "1" }] });
    const r = await trelloGet<{ id: string }[]>("/x", {}, creds, fetchImpl);
    expect(r).toEqual([{ id: "1" }]);
  });

  it("throws a redacted error on non-ok responses", async () => {
    const fetchImpl: FetchLike = async () =>
      fakeResponse({ ok: false, status: 401, statusText: "Unauthorized", text: async () => "bad token TOK456" });
    let msg = "";
    try {
      await trelloGet("/x", {}, creds, fetchImpl);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("401");
    expect(msg).not.toContain("TOK456");
  });
});

// ── Nunca logar segredo ───────────────────────────────────────────────────────
// Um fetch que falha na rede pode carregar a URL (com key e token na query) na mensagem do erro, e
// essa mensagem vira a resposta da ferramenta para o modelo.
describe("erro de rede nunca carrega a chave nem o token", () => {
  const leaky: FetchLike = async (url) => {
    throw new Error(`connect ECONNRESET ${url}`);
  };

  it("trelloGet, trelloMutate e fetchAttachment reescrevem a mensagem sem os segredos", async () => {
    const calls = [
      () => trelloGet("/x", {}, creds, leaky),
      () => trelloMutate("POST", "/x", {}, creds, leaky),
      () => fetchAttachment("https://api.trello.com/1/cards/c/attachments/a/download/f.png", true, creds, leaky),
    ];
    for (const run of calls) {
      const err = await run().catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).toMatch(/^Trello .* request failed: /);
      expect(msg).not.toContain("KEY123");
      expect(msg).not.toContain("TOK456");
    }
  });
});

// QA A-A2: o doc promete que NENHUMA mensagem de erro carrega a chave nem o token, mas só o corpo da resposta
// passava pela redação — o statusText (e o próprio status) ia cru para a mensagem.
describe("a mensagem inteira do erro HTTP passa pela redação, não só o corpo (A-A2)", () => {
  const leakyStatus = () =>
    fakeResponse({ ok: false, status: 502, statusText: "Bad Gateway KEY123 TOK456", text: async () => "corpo KEY123 TOK456" });

  it("GET, mutação e download de anexo", async () => {
    const calls = [
      () => trelloGet("/x", {}, creds, async () => leakyStatus()),
      () => trelloMutate("PUT", "/x", {}, creds, async () => leakyStatus()),
      () => fetchAttachment("https://api.trello.com/1/cards/c/attachments/a/download/f.png", true, creds, async () => leakyStatus()),
    ];
    for (const run of calls) {
      const msg = await run().then(
        () => "",
        (e: Error) => e.message,
      );
      expect(msg).toContain("502");
      expect(msg).not.toMatch(/KEY123|TOK456/);
      expect(msg).toContain("<key>");
    }
  });

  it("a mensagem continua curta e útil: método, caminho, status", async () => {
    const msg = await trelloGet("/boards/B/lists", {}, creds, async () => leakyStatus()).then(
      () => "",
      (e: Error) => e.message,
    );
    expect(msg).toMatch(/^Trello GET \/boards\/B\/lists failed: 502 Bad Gateway /);
    expect(msg.length).toBeLessThanOrEqual(260);
  });
});

// QA A-A6 (mutante M8): as chamadas à API não seguem redirect — um 3xx de api.trello.com é erro, não um salto
// que a credencial (que vai na query) devesse acompanhar. O fetch de verdade segue redirect por padrão; o
// `redirect: "manual"` é o que o impede, e nenhum teste o exigia.
describe("a API não segue redirect: trelloGet e trelloMutate pedem redirect manual, e um 3xx é erro (A-A6)", () => {
  it("o init de cada chamada traz redirect: manual", async () => {
    const inits: Array<{ method: string | undefined; redirect: string | undefined }> = [];
    const spy: FetchLike = async (_url, init) => {
      inits.push({ method: init?.method, redirect: init?.redirect });
      return fakeResponse({ json: async () => ({}) });
    };
    await trelloGet("/x", {}, creds, spy);
    await trelloMutate("POST", "/x", {}, creds, spy);
    await trelloMutate("PUT", "/x", {}, creds, spy);
    expect(inits).toEqual([
      { method: undefined, redirect: "manual" },
      { method: "POST", redirect: "manual" },
      { method: "PUT", redirect: "manual" },
    ]);
  });

  it("um 302 da API (que um fetch que segue redirect levaria para outro host, com a query) é erro e não é seguido", async () => {
    const seen: string[] = [];
    const redirecting: FetchLike = async (url) => {
      seen.push(url);
      return fakeResponse({ ok: false, status: 302, statusText: "Found", headers: { get: (n) => (n.toLowerCase() === "location" ? "https://evil.example.com/steal" : null) } });
    };
    const msg = await trelloGet("/x", {}, creds, redirecting).then(
      () => "",
      (e: Error) => e.message,
    );
    expect(msg).toMatch(/failed: 302/);
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]!).host).toBe("api.trello.com");
  });
});

describe("resposta JSON da API tem teto de tamanho (declarado)", () => {
  const huge = () =>
    fakeResponse({
      headers: { get: (n) => (n.toLowerCase() === "content-length" ? String(100 * 1024 * 1024) : null) },
      json: async () => {
        throw new Error("não devia ser lido");
      },
    });

  it("trelloGet e trelloMutate recusam sem ler o corpo", async () => {
    await expect(trelloGet("/x", {}, creds, async () => huge())).rejects.toThrow(/response larger than 20 MB/);
    await expect(trelloMutate("POST", "/x", {}, creds, async () => huge())).rejects.toThrow(/response larger than 20 MB/);
  });
});

describe("trelloMutate", () => {
  it("manda o método pedido e o corpo de erro sai redigido", async () => {
    const seen: string[] = [];
    const ok: FetchLike = async (url, init) => {
      seen.push(`${init?.method} ${new URL(url).pathname}`);
      return fakeResponse({ json: async () => ({ id: "x" }) });
    };
    expect(await trelloMutate("PUT", "/cards/c", { idList: "L" }, creds, ok)).toEqual({ id: "x" });
    expect(seen).toEqual(["PUT /1/cards/c"]);
    const bad: FetchLike = async () => fakeResponse({ ok: false, status: 400, statusText: "Bad", text: async () => "tok TOK456 key KEY123" });
    const msg = await trelloMutate("POST", "/cards", {}, creds, bad).catch((e: Error) => e.message);
    expect(msg).toContain("400");
    expect(msg).not.toMatch(/KEY123|TOK456/);
  });
});

// ── Download de anexo: a credencial só vai para o Trello ──────────────────────
// A URL do anexo vem do card, e quem tem acesso ao quadro escolhe esse valor. O download manda o par
// key/token num header OAuth: para um host de terceiros isso é vazamento de credencial (e, mesmo sem
// ela, uma requisição do computador do dev para onde o card mandar — SSRF).
describe("classifyDownloadUrl", () => {
  const UPLOAD = "https://api.trello.com/1/cards/c/attachments/a/download/f.png";

  it("api.trello.com é o host da credencial", () => {
    expect(classifyDownloadUrl(UPLOAD, true)).toEqual({ url: UPLOAD, credentialed: true });
  });

  it("trello.com/1/… (a URL que o campo url de um upload traz) é reescrita para o api.trello.com, com credencial", () => {
    expect(classifyDownloadUrl("https://trello.com/1/cards/c/attachments/a/download/f.png", true)).toEqual({ url: UPLOAD, credentialed: true });
  });

  it("os hosts de armazenamento do Trello são baixados SEM credencial", () => {
    for (const u of [
      "https://trello-attachments.s3.amazonaws.com/b/c/a/h/f.png",
      "https://trellocdn.trellousercontent.com/f.png",
      "https://trellousercontent.com/f.png",
    ]) {
      expect(classifyDownloadUrl(u, true), u).toEqual({ url: u, credentialed: false });
    }
  });

  it("link externo (isUpload false ou ausente) não é baixado, nem de host do Trello", () => {
    expect(() => classifyDownloadUrl(UPLOAD, false)).toThrow(/not an upload/);
    expect(() => classifyDownloadUrl(UPLOAD, undefined)).toThrow(/not an upload/);
  });

  // QA A-1: cada caso abaixo tem de reprovar POR CAUSA DO QUE ELE EXERCITA. Com um path que o regex do endpoint já
  // recusa (`/1/x.png`), o teste passava mesmo sem a checagem de host, de https, de userinfo ou de porta — e
  // os mutantes dessas checagens sobreviviam. Por isso, nos casos que imitam o endpoint, o path é o do endpoint
  // de download (EP): a ÚNICA coisa errada na URL é a que o caso nomeia.
  const EP = "/1/cards/c1/attachments/a1/download/x.png";
  it("a base do teste: o endpoint de download, no host certo, com https e sem userinfo nem porta, é aceito", () => {
    expect(classifyDownloadUrl(`https://api.trello.com${EP}`, true)).toEqual({ url: `https://api.trello.com${EP}`, credentialed: true });
    expect(classifyDownloadUrl(`https://trello.com${EP}`, true)).toEqual({ url: `https://api.trello.com${EP}`, credentialed: true });
  });

  it.each([
    ["host de terceiros", `https://evil.example.com${EP}`],
    ["host que só começa com trello.com", `https://trello.com.evil.example${EP}`],
    ["host que só termina em trellousercontent.com", "https://eviltrellousercontent.com/x.png"],
    ["host que contém api.trello.com", `https://api.trello.com.evil.example${EP}`],
    ["host que termina em api.trello.com", `https://evilapi.trello.com${EP}`],
    ["subdomínio de trello.com que não é o da API", `https://files.trello.com${EP}`],
    ["outro subdomínio com o caminho do endpoint", `https://api2.trello.com${EP}`],
    ["IP interno", `https://169.254.169.254${EP}`],
    ["IP interno, sem o caminho do endpoint", "https://169.254.169.254/latest/meta-data"],
    ["localhost", `https://localhost${EP}`],
    ["http, sem TLS", `http://api.trello.com${EP}`],
    ["http, sem TLS, no trello.com", `http://trello.com${EP}`],
    ["credencial embutida na URL", `https://user:pass@api.trello.com${EP}`],
    ["só o usuário embutido na URL", `https://user@api.trello.com${EP}`],
    ["porta explícita", `https://api.trello.com:8443${EP}`],
    ["porta explícita diferente da padrão (444)", `https://api.trello.com:444${EP}`],
    ["porta explícita no trello.com", `https://trello.com:8443${EP}`],
    ["trello.com fora de /1/", "https://trello.com/b/abc/quadro"],
    ["esquema que não é http", "file:///etc/passwd"],
    ["esquema que não é http, com o caminho do endpoint", `ftp://api.trello.com${EP}`],
    ["texto que não é URL", "não é url"],
  ])("recusa %s, sem pôr a URL (que pode ter token assinado) na mensagem", (_nome, url) => {
    let msg = "";
    try {
      classifyDownloadUrl(url, true);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/refusing to download|not a valid URL/);
    expect(msg).not.toContain("user:pass");
    expect(msg).not.toContain("/x.png");
  });
});

// QA A-A5: "api.trello.com" sozinho como host da credencial ainda deixava o card escolher QUALQUER endpoint
// da API (um GET /1/members/me, um token...) para a requisição autenticada. O download credenciado é só do
// endpoint de download de anexo: /1/cards/<id>/attachments/<id>/download/<arquivo>.
describe("a credencial só vai para o endpoint de download de anexo (A-A5)", () => {
  const OK = "https://api.trello.com/1/cards/c1/attachments/a1/download/f.png";

  it("aceita só /1/cards/<id>/attachments/<id>/download/<arquivo>, no api.trello.com e no trello.com", () => {
    expect(classifyDownloadUrl(OK, true)).toEqual({ url: OK, credentialed: true });
    expect(classifyDownloadUrl("https://trello.com/1/cards/c1/attachments/a1/download/f%20x.png", true)).toEqual({
      url: "https://api.trello.com/1/cards/c1/attachments/a1/download/f%20x.png",
      credentialed: true,
    });
  });

  it.each([
    ["outro endpoint da API", "https://api.trello.com/1/members/me/boards"],
    ["um token", "https://api.trello.com/1/tokens/abc/member"],
    ["o card, sem anexo", "https://api.trello.com/1/cards/c1"],
    ["o anexo, sem /download/", "https://api.trello.com/1/cards/c1/attachments/a1"],
    ["download sem o nome do arquivo", "https://api.trello.com/1/cards/c1/attachments/a1/download/"],
    ["versão da API que não é a 1", "https://api.trello.com/2/cards/c1/attachments/a1/download/f.png"],
    ["a raiz do host", "https://api.trello.com/"],
    ["traversal que sai do endpoint (normalizado pela URL)", "https://api.trello.com/1/cards/c1/attachments/a1/download/../../../members/me"],
    ["traversal codificado", "https://api.trello.com/1/cards/c1/attachments/a1/download/%2e%2e/%2e%2e/%2e%2e/members/me"],
    ["segmento a mais depois do arquivo", "https://api.trello.com/1/cards/c1/attachments/a1/download/f.png/extra"],
    ["id do card com caractere estranho", "https://api.trello.com/1/cards/c1%2Fx/attachments/a1/download/f.png"],
    ["o mesmo endpoint errado via trello.com/1/", "https://trello.com/1/members/me/boards"],
  ])("recusa %s, antes de qualquer requisição", async (_nome, url) => {
    expect(() => classifyDownloadUrl(url, true)).toThrow(/refusing to download/);
    const seen: string[] = [];
    await expect(
      fetchAttachment(url, true, creds, async (u) => {
        seen.push(u);
        return fakeResponse({});
      }),
    ).rejects.toThrow(/refusing to download/);
    expect(seen).toEqual([]);
  });

  // Revisão de segurança: `[^/]+` no último segmento aceitava %2F, %5C e %2E. Um parser ou servidor que
  // decodifique ANTES de rotear lê isso como `../` e sai do endpoint de download — mesmo com o host certo
  // (é diferença entre parsers). O segmento do arquivo só aceita não reservados ou percent-encoding que não
  // seja de `/`, `\` nem `.`, e o alvo credenciado não leva query nem fragmento.
  const D = "https://api.trello.com/1/cards/c1/attachments/a1/download";
  it.each([
    ["%2e%2e%2f no arquivo", `${D}/%2e%2e%2fx`],
    ["..%2F..%2F no arquivo", `${D}/..%2F..%2Fboards`],
    ["%5C no arquivo", `${D}/a%5Cb`],
    ["%5c minúsculo", `${D}/a%5cb`],
    ["%2E%2E como o arquivo inteiro", `${D}/%2E%2E`],
    ["%2e sozinho", `${D}/%2e`],
    ["%2F no meio do nome", `${D}/f%2Fg.png`],
    ["%2f minúsculo", `${D}/f%2fg.png`],
    ["ponto codificado no meio do nome", `${D}/f%2Epng`],
    ["%2F num id do caminho", "https://api.trello.com/1/cards/c1%2Fx/attachments/a1/download/f.png"],
    ["%2E num id do caminho", "https://api.trello.com/1/cards/c1/attachments/%2E%2E/download/f.png"],
    ["query", `${D}/f.png?x=1`],
    ["query vazia", `${D}/f.png?`],
    ["fragmento", `${D}/f.png#frag`],
    ["fragmento vazio", `${D}/f.png#`],
    ["query pelo trello.com/1/", "https://trello.com/1/cards/c1/attachments/a1/download/f.png?x=1"],
    ["barra invertida literal (o parser a lê como /)", `${D}/a\\..\\..\\boards`],
  ])("recusa %s: nem requisição, nem header", async (_nome, url) => {
    expect(() => classifyDownloadUrl(url, true)).toThrow(/refusing to download/);
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    await expect(
      fetchAttachment(url, true, creds, async (u, init) => {
        seen.push({ url: u, auth: init?.headers?.["Authorization"] });
        return fakeResponse({});
      }),
    ).rejects.toThrow(/refusing to download/);
    expect(seen).toEqual([]);
  });

  it("o nome normal continua baixando: espaço codificado, acento em UTF-8, parênteses, ponto no meio", async () => {
    for (const name of ["my%20file.png", "a%20(1).png", "tela%20%C3%A7ao.final.png", "f.png", "x_y-z~1.JPEG", "a%2Bb.png", "%E2%9C%93.png"]) {
      const url = `${D}/${name}`;
      expect(classifyDownloadUrl(url, true), name).toEqual({ url, credentialed: true });
    }
    const seen: string[] = [];
    const buf = await fetchAttachment(`${D}/my%20file.png`, true, creds, async (u, init) => {
      seen.push(`${new URL(u).pathname} ${init?.headers?.["Authorization"] === oauthHeader(creds)}`);
      return fakeResponse({ arrayBuffer: async () => new Uint8Array([1]).buffer });
    });
    expect([...buf]).toEqual([1]);
    expect(seen).toEqual(["/1/cards/c1/attachments/a1/download/my%20file.png true"]);
  });

  it("o armazenamento do Trello pode ter query (URL assinada): a restrição de query é só do alvo credenciado", () => {
    const u = "https://trellocdn.trellousercontent.com/signed/f.png?X-Sig=abc&Expires=1#x";
    expect(classifyDownloadUrl(u, true)).toEqual({ url: u, credentialed: false });
  });

  it("o redirect do endpoint para uma URL do endpoint COM query é recusado, e o segundo salto nunca é requisitado", async () => {
    const seen: string[] = [];
    const first = fakeResponse({ status: 302, statusText: "Found", headers: { get: (n) => (n.toLowerCase() === "location" ? `${D}/g.png?x=1` : null) } });
    await expect(
      fetchAttachment(`${D}/f.png`, true, creds, async (u) => {
        seen.push(u);
        return first;
      }),
    ).rejects.toThrow(/refusing to download/);
    expect(seen).toHaveLength(1);
  });

  it("o armazenamento do Trello é baixado SEM credencial, mesmo quando a URL é pedida direto", async () => {
    for (const url of ["https://trello-attachments.s3.amazonaws.com/b/c/a/h/f.png", "https://trellocdn.trellousercontent.com/signed/f.png?X-Sig=abc", "https://trellousercontent.com/f.png"]) {
      const seen: Array<{ url: string; headers: Record<string, string> | undefined }> = [];
      const buf = await fetchAttachment(url, true, creds, async (u, init) => {
        seen.push({ url: u, headers: init?.headers });
        return fakeResponse({ arrayBuffer: async () => new Uint8Array([7]).buffer });
      });
      expect([...buf]).toEqual([7]);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.headers?.["Authorization"], url).toBeUndefined();
      expect(JSON.stringify(seen[0]!.headers ?? {})).not.toMatch(/KEY123|TOK456|oauth/i);
    }
  });

  it("o armazenamento também não passa a credencial por query: a URL requisitada não carrega key nem token", async () => {
    const url = "https://trellocdn.trellousercontent.com/signed/f.png?X-Sig=abc";
    let asked = "";
    await fetchAttachment(url, true, creds, async (u) => {
      asked = u;
      return fakeResponse({ arrayBuffer: async () => new ArrayBuffer(1) });
    });
    expect(asked).toBe(url);
    expect(asked).not.toMatch(/KEY123|TOK456/);
  });
});

// QA A-A4: o teto de 25 MB só valia com Content-Length declarado — sem ele, res.arrayBuffer() lia TUDO antes de
// a conferência acontecer. Agora a leitura é em stream, com corte no teto (e o corpo que não vem em stream tem a
// conferência depois de ler). Os dois ramos têm teste, e o limite é injetável.
describe("teto de tamanho do anexo, com e sem Content-Length (A-A4)", () => {
  const UPLOAD = "https://api.trello.com/1/cards/c1/attachments/a1/download/f.png";
  type Chunk = number[];
  function streamed(chunks: Chunk[], headers?: FetchResponseLike["headers"]) {
    const state = { reads: 0, cancelled: false };
    const res = fakeResponse({
      ...(headers ? { headers } : {}),
      body: {
        getReader: () => ({
          read: async () => {
            const next = chunks[state.reads++];
            return next ? { done: false, value: new Uint8Array(next) } : { done: true };
          },
          cancel: async () => {
            state.cancelled = true;
          },
        }),
      },
      arrayBuffer: async () => {
        throw new Error("não devia usar arrayBuffer quando há stream");
      },
    });
    return { res, state };
  }

  it("sem Content-Length, o stream é cortado no teto: cancela a leitura e não consome o resto", async () => {
    const { res, state } = streamed([[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16]]);
    await expect(fetchAttachment(UPLOAD, true, creds, async () => res, 6)).rejects.toThrow(/larger than 6 bytes/);
    expect(state.cancelled).toBe(true);
    expect(state.reads).toBe(2); // 4 + 4 > 6: parou no segundo pedaço, sem ler o terceiro nem o quarto
  });

  it("stream dentro do teto: devolve os pedaços concatenados, na ordem", async () => {
    const { res, state } = streamed([[1, 2], [3], [4, 5]]);
    const buf = await fetchAttachment(UPLOAD, true, creds, async () => res, 5);
    expect([...buf]).toEqual([1, 2, 3, 4, 5]);
    expect(state.cancelled).toBe(false);
  });

  it("Content-Length declarado acima do teto: recusa sem abrir o stream", async () => {
    const { res, state } = streamed([[1]], { get: (n) => (n.toLowerCase() === "content-length" ? "1000" : null) });
    await expect(fetchAttachment(UPLOAD, true, creds, async () => res, 100)).rejects.toThrow(/larger than 100 bytes/);
    expect(state.reads).toBe(0);
  });

  it("Content-Length que mente (declara pouco e manda muito): o corte do stream pega do mesmo jeito", async () => {
    const { res, state } = streamed([[1, 2, 3], [4, 5, 6]], { get: (n) => (n.toLowerCase() === "content-length" ? "2" : null) });
    await expect(fetchAttachment(UPLOAD, true, creds, async () => res, 4)).rejects.toThrow(/larger than 4 bytes/);
    expect(state.cancelled).toBe(true);
  });

  it("sem stream (a resposta só tem arrayBuffer) e sem Content-Length: a conferência vem depois de ler, e recusa", async () => {
    const big = fakeResponse({ arrayBuffer: async () => new Uint8Array(10).buffer });
    await expect(fetchAttachment(UPLOAD, true, creds, async () => big, 4)).rejects.toThrow(/larger than 4 bytes/);
    const ok = fakeResponse({ arrayBuffer: async () => new Uint8Array(3).buffer });
    expect((await fetchAttachment(UPLOAD, true, creds, async () => ok, 4)).length).toBe(3);
  });

  // Revisão de segurança: o orçamento do sync só descontava o download que deu certo. O que foi LIDO antes de a
  // recusa acontecer (cortado no meio do stream, ou lido por arrayBuffer e só então recusado) também conta.
  it("os bytes consumidos são informados também quando o download é recusado no meio do stream", async () => {
    const tally = { bytes: 0 };
    const { res } = streamed([[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13]]);
    await expect(fetchAttachment(UPLOAD, true, creds, async () => res, 6, tally)).rejects.toThrow(/larger than 6 bytes/);
    expect(tally.bytes).toBe(8); // o pedaço que estourou o teto também foi lido
  });

  it("sucesso: tally = o tamanho do corpo; Content-Length acima do teto: 0 (nada foi lido); arrayBuffer recusado depois de lido: o tamanho lido", async () => {
    const ok = streamed([[1, 2], [3, 4, 5]]);
    const tOk = { bytes: 0 };
    expect((await fetchAttachment(UPLOAD, true, creds, async () => ok.res, 10, tOk)).length).toBe(5);
    expect(tOk.bytes).toBe(5);

    const declared = streamed([[1]], { get: (n) => (n.toLowerCase() === "content-length" ? "1000" : null) });
    const tDeclared = { bytes: 0 };
    await expect(fetchAttachment(UPLOAD, true, creds, async () => declared.res, 100, tDeclared)).rejects.toThrow(/larger than/);
    expect(tDeclared.bytes).toBe(0);

    const fallback = fakeResponse({ arrayBuffer: async () => new Uint8Array(10).buffer });
    const tFallback = { bytes: 0 };
    await expect(fetchAttachment(UPLOAD, true, creds, async () => fallback, 4, tFallback)).rejects.toThrow(/larger than 4 bytes/);
    expect(tFallback.bytes).toBe(10);
  });

  it("falha de leitura no meio do stream: o que já foi lido fica no tally", async () => {
    let n = 0;
    const res = fakeResponse({
      body: {
        getReader: () => ({
          read: async () => {
            if (n++ === 0) return { done: false, value: new Uint8Array([1, 2, 3]) };
            throw new Error("socket hang up");
          },
          cancel: async () => undefined,
        }),
      },
    });
    const tally = { bytes: 0 };
    await expect(fetchAttachment(UPLOAD, true, creds, async () => res, 100, tally)).rejects.toThrow(/socket hang up/);
    expect(tally.bytes).toBe(3);
  });

  it("o teto padrão é 25 MB, e a recusa nomeia o limite em MB", async () => {
    const big = fakeResponse({ headers: { get: (n) => (n.toLowerCase() === "content-length" ? String(26 * 1024 * 1024) : null) } });
    await expect(fetchAttachment(UPLOAD, true, creds, async () => big)).rejects.toThrow(/larger than 25 MB/);
  });
});

describe("fetchAttachment", () => {
  const UPLOAD = "https://trello.com/1/cards/c/attachments/a/download/f.png";
  const redirect = (to: string, status = 302): FetchResponseLike =>
    fakeResponse({ status, statusText: "Found", headers: { get: (n) => (n.toLowerCase() === "location" ? to : null) } });
  const bytes = (...b: number[]): FetchResponseLike => fakeResponse({ arrayBuffer: async () => new Uint8Array(b).buffer });
  const recorder = (answers: FetchResponseLike[]) => {
    const seen: Array<{ url: string; auth: string | undefined; redirect: string | undefined }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push({ url, auth: init?.headers?.["Authorization"], redirect: init?.redirect });
      const next = answers.shift();
      if (!next) throw new Error("fetch demais");
      return next;
    };
    return { seen, fetchImpl };
  };

  it("pede ao api.trello.com com o header OAuth e redirect manual", async () => {
    const t = recorder([bytes(1, 2, 3)]);
    const buf = await fetchAttachment(UPLOAD, true, creds, t.fetchImpl);
    expect([...buf]).toEqual([1, 2, 3]);
    expect(t.seen).toEqual([{ url: "https://api.trello.com/1/cards/c/attachments/a/download/f.png", auth: oauthHeader(creds), redirect: "manual" }]);
  });

  it("host de terceiros: nenhuma requisição, nenhum header", async () => {
    const t = recorder([bytes(1)]);
    await expect(fetchAttachment("https://evil.example.com/x.png", true, creds, t.fetchImpl)).rejects.toThrow(/refusing to download evil\.example\.com/);
    expect(t.seen).toEqual([]);
  });

  it("http é recusado antes de qualquer requisição", async () => {
    const t = recorder([bytes(1)]);
    await expect(fetchAttachment("http://api.trello.com/1/x.png", true, creds, t.fetchImpl)).rejects.toThrow(/refusing to download/);
    expect(t.seen).toEqual([]);
  });

  it("link externo não é baixado", async () => {
    const t = recorder([bytes(1)]);
    await expect(fetchAttachment("https://api.trello.com/1/x.png", false, creds, t.fetchImpl)).rejects.toThrow(/not an upload/);
    expect(t.seen).toEqual([]);
  });

  it("redirect para o armazenamento do Trello segue, e o header OAuth NÃO vai junto", async () => {
    const t = recorder([redirect("https://trellocdn.trellousercontent.com/signed/f.png?X-Sig=abc"), bytes(9)]);
    const buf = await fetchAttachment(UPLOAD, true, creds, t.fetchImpl);
    expect([...buf]).toEqual([9]);
    expect(t.seen.map((s) => [new URL(s.url).host, s.auth])).toEqual([
      ["api.trello.com", oauthHeader(creds)],
      ["trellocdn.trellousercontent.com", undefined],
    ]);
  });

  it("redirect para fora da lista é bloqueado: o segundo salto nunca é requisitado", async () => {
    const t = recorder([redirect("https://evil.example.com/steal.png"), bytes(9)]);
    const err = await fetchAttachment(UPLOAD, true, creds, t.fetchImpl).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/refusing to download evil\.example\.com/);
    expect(t.seen).toHaveLength(1);
  });

  it("redirect para http, ou relativo que sobe para outro host, é bloqueado", async () => {
    const http = recorder([redirect("http://api.trello.com/1/x.png"), bytes(9)]);
    await expect(fetchAttachment(UPLOAD, true, creds, http.fetchImpl)).rejects.toThrow(/refusing to download/);
    expect(http.seen).toHaveLength(1);
    const proto = recorder([redirect("//evil.example.com/x.png"), bytes(9)]);
    await expect(fetchAttachment(UPLOAD, true, creds, proto.fetchImpl)).rejects.toThrow(/refusing to download evil\.example\.com/);
    expect(proto.seen).toHaveLength(1);
  });

  it("redirect sem Location, e cadeia de redirects longa demais, falham", async () => {
    const none = recorder([fakeResponse({ status: 302, statusText: "Found" })]);
    await expect(fetchAttachment(UPLOAD, true, creds, none.fetchImpl)).rejects.toThrow(/redirect without a Location/);
    const loop = recorder(Array.from({ length: 10 }, () => redirect("https://api.trello.com/1/cards/c/attachments/a/download/f.png")));
    await expect(fetchAttachment(UPLOAD, true, creds, loop.fetchImpl)).rejects.toThrow(/too many redirects/);
    expect(loop.seen.length).toBeLessThanOrEqual(5);
  });

  it("resposta de erro sai redigida, e acima do teto de tamanho não é lida", async () => {
    const bad = recorder([fakeResponse({ ok: false, status: 403, statusText: "Forbidden", text: async () => "key KEY123" })]);
    const msg = await fetchAttachment(UPLOAD, true, creds, bad.fetchImpl).catch((e: Error) => e.message);
    expect(msg).toContain("403");
    expect(msg).not.toContain("KEY123");

    let read = false;
    const big = recorder([
      fakeResponse({
        headers: { get: (n) => (n.toLowerCase() === "content-length" ? String(200 * 1024 * 1024) : null) },
        arrayBuffer: async () => {
          read = true;
          return new ArrayBuffer(0);
        },
      }),
    ]);
    await expect(fetchAttachment(UPLOAD, true, creds, big.fetchImpl)).rejects.toThrow(/larger than/);
    expect(read).toBe(false);
  });
});
