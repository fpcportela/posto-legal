import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveLabelIds, type BoardLabel } from "./labels.js";
import { createCard } from "./tools/create_card.js";
import { addLabel } from "./tools/add_label.js";
import type { FetchLike, FetchResponseLike } from "./client.js";

const BOARD: BoardLabel[] = [
  { id: "6a04be05693b5ca07cad2001", name: "MESA", color: "green" },
  { id: "6a04be05693b5ca07cad2002", name: "Operação", color: "blue" },
  { id: "6a04be05693b5ca07cad2003", name: "", color: "red" },
];

describe("resolveLabelIds", () => {
  it("matches names case- and accent-insensitively and keeps the request order", () => {
    expect(resolveLabelIds(BOARD, ["operacao", "mesa"])).toEqual(["6a04be05693b5ca07cad2002", "6a04be05693b5ca07cad2001"]);
  });

  it("accepts a raw label id that exists on the board, including an unnamed label", () => {
    expect(resolveLabelIds(BOARD, ["6a04be05693b5ca07cad2003"])).toEqual(["6a04be05693b5ca07cad2003"]);
  });

  it("deduplicates", () => {
    expect(resolveLabelIds(BOARD, ["MESA", "mesa", "6a04be05693b5ca07cad2001"])).toEqual(["6a04be05693b5ca07cad2001"]);
  });

  it("fails on an unknown name and lists the board's labels instead of silently dropping it", () => {
    expect(() => resolveLabelIds(BOARD, ["MESA", "Urgente"])).toThrow(/Unknown label\(s\): Urgente\. Labels on this board: MESA, Operação/);
  });

  it("fails on a name shared by two labels and asks for the id", () => {
    const dup = [...BOARD, { id: "6a04be05693b5ca07cad2004", name: "Mesa", color: "yellow" }];
    expect(() => resolveLabelIds(dup, ["mesa"])).toThrow(/ambiguous/);
  });
});

// A fake Trello: records every call and answers the few endpoints the tools use.
function fakeTrello(cardLabels: string[] = []) {
  const calls: Array<{ method: string; path: string; params: Record<string, string> }> = [];
  const res = (body: unknown): FetchResponseLike => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  const fetchImpl: FetchLike = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/1/, "");
    const params = Object.fromEntries(u.searchParams.entries());
    const method = init?.method ?? "GET";
    calls.push({ method, path, params });
    if (method === "GET" && path === "/lists/L1") return res({ idBoard: "B1" });
    if (method === "GET" && path === "/boards/B1/labels") return res(BOARD);
    if (method === "GET" && path === "/cards/C1") return res({ id: "C1", idBoard: "B1", idLabels: cardLabels });
    if (method === "POST" && path === "/cards") return res({ id: "NEW", shortUrl: "https://trello.com/c/x", idLabels: (params.idLabels ?? "").split(",").filter(Boolean) });
    if (method === "POST" && path === "/cards/C1/idLabels") return res([params.value]);
    return { ...res({}), ok: false, status: 404, statusText: "Not Found" };
  };
  return { calls, fetchImpl };
}

describe("trello_create_card with labels / trello_add_label", () => {
  const saved = { key: process.env.TRELLO_API_KEY, token: process.env.TRELLO_TOKEN };
  beforeEach(() => {
    process.env.TRELLO_API_KEY = "testkey";
    process.env.TRELLO_TOKEN = "testtoken";
  });
  afterEach(() => {
    process.env.TRELLO_API_KEY = saved.key;
    process.env.TRELLO_TOKEN = saved.token;
  });

  it("create_card resolves the label on the list's board and sends idLabels in the same POST", async () => {
    const t = fakeTrello();
    const out = JSON.parse((await createCard({ idList: "L1", name: "Card", labels: ["mesa"] }, t.fetchImpl)).output);
    const post = t.calls.find((c) => c.method === "POST");
    expect(post?.params.idLabels).toBe("6a04be05693b5ca07cad2001");
    expect(out.idLabels).toEqual(["6a04be05693b5ca07cad2001"]);
  });

  it("create_card with an unknown label creates NOTHING", async () => {
    const t = fakeTrello();
    await expect(createCard({ idList: "L1", name: "Card", labels: ["nope"] }, t.fetchImpl)).rejects.toThrow(/Unknown label/);
    expect(t.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("create_card without labels keeps the single POST (no board lookups)", async () => {
    const t = fakeTrello();
    await createCard({ idList: "L1", name: "Card" }, t.fetchImpl);
    expect(t.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /cards"]);
  });

  it("add_label posts only the labels the card does not have yet", async () => {
    const t = fakeTrello(["6a04be05693b5ca07cad2002"]);
    const out = JSON.parse((await addLabel({ cardId: "C1", labels: ["MESA", "Operação"] }, t.fetchImpl)).output);
    const posts = t.calls.filter((c) => c.method === "POST").map((c) => c.params.value);
    expect(posts).toEqual(["6a04be05693b5ca07cad2001"]);
    expect(out).toMatchObject({ added: ["6a04be05693b5ca07cad2001"], alreadyPresent: ["6a04be05693b5ca07cad2002"] });
  });
});
