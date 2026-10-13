import { z } from "zod";
import { loadRootEnv, requireCreds } from "../creds.js";
import { trelloMutate } from "../client.js";

// Tier 2: mutates the user's board (moves a card between lists). Proceed + log to beads.
export const TIER = 2;

export const schema = z.object({
  cardId: z
    .string()
    .regex(/^[A-Za-z0-9]+$/, "Trello card id or shortLink")
    .describe("Card id or shortLink to move"),
  idList: z
    .string()
    .regex(/^[A-Za-z0-9]+$/, "Trello destination list id")
    .describe("Destination list id (use trello_list_lists to find it)"),
  pos: z.enum(["top", "bottom"]).optional().describe("Position within the destination list"),
});

export async function moveCard(input: unknown): Promise<{ success: boolean; output: string }> {
  const { cardId, idList, pos } = schema.parse(input);
  loadRootEnv();
  const creds = requireCreds();
  const card = await trelloMutate<{ id: string; idList: string }>(
    "PUT",
    `/cards/${encodeURIComponent(cardId)}`,
    { idList, pos },
    creds,
  );
  return { success: true, output: JSON.stringify({ ok: true, cardId: card.id, idList: card.idList }, null, 2) };
}
