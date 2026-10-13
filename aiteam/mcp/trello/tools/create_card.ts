import { z } from "zod";
import { loadRootEnv, requireCreds } from "../creds.js";
import { trelloMutate, type FetchLike } from "../client.js";
import { boardIdOf, boardLabels, resolveLabelIds } from "../labels.js";

// Tier 2: mutates the user's board (creates a card). Proceed + log to beads.
export const TIER = 2;

export const schema = z.object({
  idList: z
    .string()
    .regex(/^[A-Za-z0-9]+$/, "Trello destination list id")
    .describe("List id to create the card in (use trello_list_lists to find it)"),
  name: z.string().min(1).max(16384).describe("Card title"),
  desc: z.string().max(16384).optional().describe("Card description (Trello markdown)"),
  pos: z.enum(["top", "bottom"]).optional().describe("Position within the list"),
  labels: z
    .array(z.string().min(1).max(100))
    .max(10)
    .optional()
    .describe('Label names (case-insensitive) or label ids to apply, e.g. ["MESA"]; resolved on the list\'s board'),
});

export async function createCard(
  input: unknown,
  fetchImpl?: FetchLike,
): Promise<{ success: boolean; output: string }> {
  const { idList, name, desc, pos, labels } = schema.parse(input);
  loadRootEnv();
  const creds = requireCreds();
  // Resolve BEFORE creating: an unknown label fails the call instead of leaving
  // a card on the board without the label the caller asked for.
  let idLabels: string | undefined;
  if (labels && labels.length > 0) {
    const boardId = await boardIdOf("lists", idList, creds, fetchImpl);
    idLabels = resolveLabelIds(await boardLabels(boardId, creds, fetchImpl), labels).join(",");
  }
  const card = await trelloMutate<{ id: string; shortUrl: string; idLabels?: string[] }>(
    "POST",
    "/cards",
    { idList, name, desc, pos, idLabels },
    creds,
    fetchImpl,
  );
  return {
    success: true,
    output: JSON.stringify({ ok: true, cardId: card.id, shortUrl: card.shortUrl, idLabels: card.idLabels ?? [] }, null, 2),
  };
}
