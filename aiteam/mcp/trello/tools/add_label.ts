import { z } from "zod";
import { loadRootEnv, requireCreds } from "../creds.js";
import { trelloGet, trelloMutate, type FetchLike } from "../client.js";
import { boardLabels, resolveLabelIds } from "../labels.js";

// Tier 2: mutates the user's board (adds labels to an existing card). Proceed + log to beads.
export const TIER = 2;

export const schema = z.object({
  cardId: z
    .string()
    .regex(/^[A-Za-z0-9]+$/, "Trello card id or shortLink")
    .describe("Card id or shortLink to label"),
  labels: z
    .array(z.string().min(1).max(100))
    .min(1)
    .max(10)
    .describe('Label names (case-insensitive) or label ids to add, e.g. ["MESA"]; resolved on the card\'s board'),
});

export async function addLabel(input: unknown, fetchImpl?: FetchLike): Promise<{ success: boolean; output: string }> {
  const { cardId, labels } = schema.parse(input);
  loadRootEnv();
  const creds = requireCreds();
  const card = await trelloGet<{ id: string; idBoard: string; idLabels: string[] }>(
    `/cards/${encodeURIComponent(cardId)}`,
    { fields: "idBoard,idLabels" },
    creds,
    fetchImpl,
  );
  const wanted = resolveLabelIds(await boardLabels(card.idBoard, creds, fetchImpl), labels);
  const added: string[] = [];
  for (const id of wanted) {
    if (card.idLabels.includes(id)) continue; // idempotent: re-adding returns 400 on Trello
    await trelloMutate("POST", `/cards/${encodeURIComponent(card.id)}/idLabels`, { value: id }, creds, fetchImpl);
    added.push(id);
  }
  return {
    success: true,
    output: JSON.stringify({ ok: true, cardId: card.id, added, alreadyPresent: wanted.filter((id) => !added.includes(id)) }, null, 2),
  };
}
