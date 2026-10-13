import { z } from "zod";
import { loadRootEnv, requireCreds } from "../creds.js";
import { trelloGet } from "../client.js";
import { MAX_BYTES_PER_SYNC, MAX_DOWNLOADS_PER_SYNC, defaultCacheRoot, downloadCardImages, type ByteBudget, type ToolDeps } from "../attachments.js";
import { shapeCardManifest, type CardManifest, type TrelloCard } from "../manifest.js";

export const TIER = 1;

// No `cacheRoot` here on purpose: where the prints are written is not an input of the model. They go
// to <repo root>/.trello-cache (git-ignored), and `deps.cacheRoot` is for the tests.
export const schema = z.object({
  listId: z
    .string()
    .regex(/^[A-Za-z0-9]+$/, "Trello list id")
    .describe("List id whose cards to sync (use trello_list_lists to find it)"),
  maxImagesPerCard: z.number().int().positive().max(50).optional().describe("Cap images downloaded per card (default 20)"),
});

export async function syncList(input: unknown, deps: ToolDeps = {}): Promise<{ success: boolean; output: string }> {
  const { listId, maxImagesPerCard } = schema.parse(input);
  loadRootEnv();
  const creds = requireCreds();
  const perCard = maxImagesPerCard ?? 20;
  const cacheRoot = deps.cacheRoot ?? defaultCacheRoot();
  let remaining = deps.maxDownloads ?? MAX_DOWNLOADS_PER_SYNC;
  const budget: ByteBudget = { remaining: deps.maxBytes ?? MAX_BYTES_PER_SYNC, hit: false };

  const cards = await trelloGet<TrelloCard[]>(
    `/lists/${encodeURIComponent(listId)}/cards`,
    { attachments: "true", checklists: "all", fields: "name,desc,shortLink,shortUrl,idList,due,labels" },
    creds,
    deps.fetchImpl,
  );

  const manifest: CardManifest[] = [];
  const errors: string[] = [];
  let withoutPrints = 0;

  for (const card of cards) {
    const cardKey = card.shortLink ?? card.id;
    let paths: string[] = [];
    if (remaining > 0) {
      const done = await downloadCardImages(card, {
        cacheRoot,
        listKey: listId,
        cap: Math.min(perCard, remaining),
        creds,
        fetchImpl: deps.fetchImpl,
        budget,
      });
      paths = done.paths;
      remaining -= done.paths.length + done.errors.length;
      errors.push(...done.errors.map((e) => `${cardKey}/${e}`));
    } else {
      withoutPrints++;
    }
    manifest.push(shapeCardManifest(card, paths));
  }
  if (withoutPrints > 0 || remaining <= 0) {
    const total = deps.maxDownloads ?? MAX_DOWNLOADS_PER_SYNC;
    errors.push(
      `download cap of ${total} attachments per sync reached${withoutPrints > 0 ? `: ${withoutPrints} card(s) came without prints` : ""} — use trello_get_card for the cards that need theirs`,
    );
  }

  if (budget.hit) {
    errors.push(`byte cap of ${deps.maxBytes ?? MAX_BYTES_PER_SYNC} bytes per sync reached — some prints were not downloaded; use trello_get_card for the cards that need theirs`);
  }

  return {
    success: true,
    output: JSON.stringify({ listId, count: cards.length, cacheRoot, cards: manifest, errors }, null, 2),
  };
}
