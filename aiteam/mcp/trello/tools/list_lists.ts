import { z } from "zod";
import { loadRootEnv, requireCreds } from "../creds.js";
import { trelloGet } from "../client.js";

export const TIER = 1;

export const schema = z.object({
  boardId: z
    .string()
    .regex(/^[A-Za-z0-9]+$/, "Trello board id or shortLink")
    .describe("Board id or shortLink whose lists to fetch"),
});

interface List {
  id: string;
  name: string;
}

export async function listLists(input: unknown): Promise<{ success: boolean; output: string }> {
  const { boardId } = schema.parse(input);
  loadRootEnv();
  const creds = requireCreds();
  const lists = await trelloGet<List[]>(
    `/boards/${encodeURIComponent(boardId)}/lists`,
    { fields: "name", filter: "open" },
    creds,
  );
  const out = lists.map((l) => ({ id: l.id, name: l.name }));
  return { success: true, output: JSON.stringify(out, null, 2) };
}
