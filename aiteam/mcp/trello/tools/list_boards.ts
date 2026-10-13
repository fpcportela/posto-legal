import { z } from "zod";
import { loadRootEnv, requireCreds } from "../creds.js";
import { trelloGet } from "../client.js";

export const TIER = 1;

export const schema = z.object({});

interface Board {
  id: string;
  name: string;
  shortLink?: string;
  url?: string;
}

export async function listBoards(_input: unknown): Promise<{ success: boolean; output: string }> {
  loadRootEnv();
  const creds = requireCreds();
  const boards = await trelloGet<Board[]>(
    "/members/me/boards",
    { fields: "name,url,shortLink", filter: "open" },
    creds,
  );
  const out = boards.map((b) => ({ id: b.id, name: b.name, shortLink: b.shortLink ?? "", url: b.url ?? "" }));
  return { success: true, output: JSON.stringify(out, null, 2) };
}
