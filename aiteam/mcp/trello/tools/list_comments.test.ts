import { describe, expect, it } from "vitest";
import { formatCommentActions } from "./list_comments.js";

describe("formatCommentActions", () => {
  it("maps Trello commentCard actions to compact comments", () => {
    const actions = [
      {
        id: "a1",
        date: "2026-07-20T18:00:00.000Z",
        data: { text: "Fechado: virou task." },
        memberCreator: { fullName: "Thiago Braz", username: "thiagoriosbraz" },
      },
    ];
    expect(formatCommentActions(actions)).toEqual([
      { id: "a1", date: "2026-07-20T18:00:00.000Z", author: "Thiago Braz", text: "Fechado: virou task." },
    ]);
  });

  it("falls back to username, then '?' when the member is missing", () => {
    const actions = [
      { id: "a2", date: "d", data: { text: "t" }, memberCreator: { username: "beatriz" } },
      { id: "a3", date: "d", data: { text: "t" } },
    ];
    expect(formatCommentActions(actions).map((c) => c.author)).toEqual(["beatriz", "?"]);
  });

  it("skips malformed entries instead of throwing", () => {
    const actions = [null, 42, { id: "a4" }, { id: "a5", date: "d", data: { text: "ok" } }];
    expect(formatCommentActions(actions).map((c) => c.id)).toEqual(["a5"]);
  });
});
