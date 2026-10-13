import { describe, expect, it } from "vitest";
import { z } from "zod";
import { dispatch, TOOLS, type ToolDef } from "./registry.js";

const okTool: ToolDef = {
  name: "ok_tool",
  tier: 1,
  needsApproval: false,
  schema: z.object({ x: z.string() }),
  run: async (input) => ({ success: true, output: `got ${(input as { x: string }).x}` }),
};

const tier3Tool: ToolDef = {
  name: "danger",
  tier: 3,
  needsApproval: true,
  schema: z.object({}),
  run: async () => ({ success: true, output: "ran" }),
};

const throwTool: ToolDef = {
  name: "boom",
  tier: 1,
  needsApproval: false,
  schema: z.object({}),
  run: async () => {
    throw new Error("kaboom");
  },
};

const tools = [okTool, tier3Tool, throwTool];

describe("dispatch", () => {
  it("runs a valid tool and passes its output through", async () => {
    expect(await dispatch("ok_tool", { x: "hi" }, { tools })).toEqual({ ok: true, output: "got hi" });
  });

  it("rejects an unknown tool", async () => {
    const r = await dispatch("nope", {}, { tools });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("Unknown tool");
  });

  it("rejects invalid input via zod", async () => {
    const r = await dispatch("ok_tool", { x: 123 }, { tools });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("Invalid input");
  });

  it("gates a Tier-3 tool without approval", async () => {
    const r = await dispatch("danger", {}, { tools, allowTier3: false });
    expect(r.ok).toBe(false);
    expect(r.approvalRequired).toBe(true);
  });

  it("runs a Tier-3 tool when explicitly allowed", async () => {
    expect(await dispatch("danger", {}, { tools, allowTier3: true })).toEqual({ ok: true, output: "ran" });
  });

  it("turns a throwing tool into an error result", async () => {
    const r = await dispatch("boom", {}, { tools });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("kaboom");
  });
});

// QA A-A8: o servidor descrevia toda ferramenta Tier 1 como "read-only", mas get_card e sync_list GRAVAM os
// prints no cache local (.trello-cache). O que o modelo lê na descrição é o que ele acha que a ferramenta faz.
describe("a descrição de cada ferramenta diz o que ela faz com o quadro e com o disco (A-A8)", () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

  it("toda ferramenta tem descrição própria, com o tier", () => {
    for (const t of TOOLS) {
      expect(t.description, t.name).toBeTruthy();
      expect(t.description, t.name).toMatch(new RegExp(`Tier ${t.tier}`));
    }
    expect(new Set(TOOLS.map((t) => t.description)).size).toBe(TOOLS.length);
  });

  it("as que gravam no cache não se dizem somente leitura: dizem que o quadro não muda e que escrevem em .trello-cache", () => {
    for (const name of ["trello_get_card", "trello_sync_list"]) {
      const d = byName[name]!.description!;
      expect(d, name).toContain(".trello-cache");
      expect(d, name).toMatch(/does not change the board/i);
      expect(d, name).not.toMatch(/read-only/i);
    }
  });

  it("as de leitura pura dizem somente leitura, e as de mutação dizem que mudam o quadro", () => {
    for (const name of ["trello_list_boards", "trello_list_lists", "trello_list_comments"]) {
      expect(byName[name]!.description, name).toMatch(/read-only/i);
      expect(byName[name]!.description, name).not.toContain(".trello-cache");
    }
    for (const name of ["trello_comment_card", "trello_move_card", "trello_create_card", "trello_add_label"]) {
      expect(byName[name]!.description, name).toMatch(/mutates the board/i);
    }
    expect(byName["trello_create_card"]!.description).toMatch(/labels/);
    expect(byName["trello_add_label"]!.description).toMatch(/idempotent/i);
  });
});

describe("TOOLS registry", () => {
  it("registers the nine Trello tools with the right tiers and no Tier-3", () => {
    const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual([
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
    expect(byName["trello_sync_list"]?.tier).toBe(1);
    expect(byName["trello_list_comments"]?.tier).toBe(1);
    expect(byName["trello_comment_card"]?.tier).toBe(2);
    expect(byName["trello_move_card"]?.tier).toBe(2);
    expect(byName["trello_create_card"]?.tier).toBe(2);
    expect(byName["trello_add_label"]?.tier).toBe(2);
    expect(TOOLS.every((t) => t.tier !== 3)).toBe(true);
  });
});
