import { trelloGet, type FetchLike } from "./client.js";
import type { TrelloCreds } from "./creds.js";

export interface BoardLabel {
  id: string;
  name: string;
  color: string | null;
}

const ID = /^[0-9a-f]{24}$/i;

/**
 * Resolve label NAMES (case- and accent-insensitive) or raw label ids to the ids
 * that exist on the board. Trello's POST /cards takes `idLabels` (ids only) and
 * a typo there fails silently on some boards, so an unknown name is an error
 * that lists what the board actually has — never a card created without the
 * label the caller asked for.
 */
export function resolveLabelIds(boardLabels: BoardLabel[], requested: string[]): string[] {
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
  const ids: string[] = [];
  const missing: string[] = [];
  for (const raw of requested) {
    const byId = ID.test(raw) ? boardLabels.find((l) => l.id === raw) : undefined;
    const matches = byId ? [byId] : boardLabels.filter((l) => l.name && norm(l.name) === norm(raw));
    const [only, ...rest] = matches;
    if (!only) {
      missing.push(raw);
      continue;
    }
    if (rest.length > 0) {
      throw new Error(
        `Label "${raw}" is ambiguous on this board (${matches.length} labels share the name); pass its id instead: ` +
          matches.map((l) => `${l.id} (${l.color ?? "no color"})`).join(", "),
      );
    }
    if (!ids.includes(only.id)) ids.push(only.id);
  }
  if (missing.length > 0) {
    const available = boardLabels.filter((l) => l.name).map((l) => l.name);
    throw new Error(
      `Unknown label(s): ${missing.join(", ")}. Labels on this board: ${available.length ? available.join(", ") : "(none named)"}`,
    );
  }
  return ids;
}

export async function boardLabels(boardId: string, creds: TrelloCreds, fetchImpl?: FetchLike): Promise<BoardLabel[]> {
  return trelloGet<BoardLabel[]>(
    `/boards/${encodeURIComponent(boardId)}/labels`,
    { fields: "name,color", limit: 1000 },
    creds,
    fetchImpl,
  );
}

export async function boardIdOf(
  kind: "lists" | "cards",
  id: string,
  creds: TrelloCreds,
  fetchImpl?: FetchLike,
): Promise<string> {
  const obj = await trelloGet<{ idBoard: string }>(
    `/${kind}/${encodeURIComponent(id)}`,
    { fields: "idBoard" },
    creds,
    fetchImpl,
  );
  return obj.idBoard;
}
