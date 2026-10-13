import { z } from "zod";
import { loadRootEnv, requireCreds } from "../creds.js";
import { trelloMutate } from "../client.js";

// Tier 2: mutates the user's board (adds a comment). Proceed + log to beads.
export const TIER = 2;

export const schema = z.object({
  cardId: z
    .string()
    .regex(/^[A-Za-z0-9]+$/, "Trello card id or shortLink")
    .describe("Card id or shortLink to comment on"),
  text: z.string().min(1).max(16384).describe("Comment body to post on the card"),
});

export async function commentCard(input: unknown): Promise<{ success: boolean; output: string }> {
  const { cardId, text } = schema.parse(input);
  loadRootEnv();
  const creds = requireCreds();
  const action = await trelloMutate<{ id: string }>(
    "POST",
    `/cards/${encodeURIComponent(cardId)}/actions/comments`,
    { text },
    creds,
  );
  return { success: true, output: JSON.stringify({ ok: true, cardId, actionId: action.id }, null, 2) };
}
