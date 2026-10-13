import { z } from "zod";
import { loadRootEnv, requireCreds } from "../creds.js";
import { trelloGet } from "../client.js";
import { defaultCacheRoot, downloadCardImages, type ToolDeps } from "../attachments.js";
import { shapeCardManifest, type TrelloCard } from "../manifest.js";

export const TIER = 1;

// No `cacheRoot` here on purpose: where the prints are written is not an input of the model. They go
// to <repo root>/.trello-cache (git-ignored), and `deps.cacheRoot` is for the tests.
export const schema = z.object({
  cardId: z
    .string()
    .regex(/^[A-Za-z0-9]+$/, "Trello card id or shortLink")
    .describe("Card id or shortLink to fetch"),
  maxImages: z.number().int().positive().max(50).optional().describe("Cap images downloaded (default 20)"),
});

export async function getCard(input: unknown, deps: ToolDeps = {}): Promise<{ success: boolean; output: string }> {
  const { cardId, maxImages } = schema.parse(input);
  loadRootEnv();
  const creds = requireCreds();
  const cacheRoot = deps.cacheRoot ?? defaultCacheRoot();

  const card = await trelloGet<TrelloCard>(
    `/cards/${encodeURIComponent(cardId)}`,
    { attachments: "true", checklists: "all", fields: "name,desc,shortLink,shortUrl,idList,due,labels" },
    creds,
    deps.fetchImpl,
  );

  const { paths, errors } = await downloadCardImages(card, {
    cacheRoot,
    listKey: card.idList ?? "card",
    cap: maxImages ?? 20,
    creds,
    fetchImpl: deps.fetchImpl,
  });

  return {
    success: true,
    output: JSON.stringify({ card: shapeCardManifest(card, paths), errors }, null, 2),
  };
}
