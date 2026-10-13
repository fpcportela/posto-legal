import { z } from "zod";
import { loadRootEnv, requireCreds } from "../creds.js";
import { trelloGet } from "../client.js";

// Tier 1: read-only (fetches a card's comment actions).
export const TIER = 1;

export const schema = z.object({
  cardId: z
    .string()
    .regex(/^[A-Za-z0-9]+$/, "Trello card id or shortLink")
    .describe("Card id or shortLink whose comments to fetch"),
  limit: z.number().int().min(1).max(100).optional().describe("Max comments to return (default 20, newest first)"),
});

export interface CardComment {
  id: string;
  date: string;
  author: string;
  text: string;
}

/** Map raw Trello commentCard actions to compact comments, skipping malformed entries. */
export function formatCommentActions(actions: unknown[]): CardComment[] {
  const out: CardComment[] = [];
  for (const action of actions) {
    if (typeof action !== "object" || action === null) continue;
    const a = action as {
      id?: unknown;
      date?: unknown;
      data?: { text?: unknown };
      memberCreator?: { fullName?: unknown; username?: unknown };
    };
    if (typeof a.id !== "string" || typeof a.date !== "string" || typeof a.data?.text !== "string") continue;
    const member = a.memberCreator;
    const author =
      (typeof member?.fullName === "string" && member.fullName) ||
      (typeof member?.username === "string" && member.username) ||
      "?";
    out.push({ id: a.id, date: a.date, author, text: a.data.text });
  }
  return out;
}

export async function listComments(input: unknown): Promise<{ success: boolean; output: string }> {
  const { cardId, limit } = schema.parse(input);
  loadRootEnv();
  const creds = requireCreds();
  const actions = await trelloGet<unknown[]>(
    `/cards/${encodeURIComponent(cardId)}/actions`,
    { filter: "commentCard", limit: limit ?? 20 },
    creds,
  );
  const comments = formatCommentActions(Array.isArray(actions) ? actions : []);
  return { success: true, output: JSON.stringify({ ok: true, cardId, count: comments.length, comments }, null, 2) };
}
