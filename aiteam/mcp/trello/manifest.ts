import * as path from "path";

export interface TrelloAttachment {
  id: string;
  name?: string;
  url?: string;
  /** True for a file uploaded to Trello; false for an external link. Only uploads are downloaded. */
  isUpload?: boolean;
  mimeType?: string | null;
  bytes?: number | null;
}

export interface TrelloLabel {
  name?: string;
  color?: string;
}

export interface TrelloCheckItem {
  name: string;
  state: string;
}

export interface TrelloChecklist {
  name: string;
  checkItems?: TrelloCheckItem[];
}

export interface TrelloCard {
  id: string;
  name: string;
  desc?: string;
  shortLink?: string;
  shortUrl?: string;
  idList?: string;
  due?: string | null;
  labels?: TrelloLabel[];
  attachments?: TrelloAttachment[];
  checklists?: TrelloChecklist[];
}

export interface CardManifest {
  id: string;
  name: string;
  shortUrl: string;
  idList: string;
  due: string | null;
  labels: string[];
  desc: string;
  checklists: { name: string; items: { text: string; checked: boolean }[] }[];
  images: string[];
}

const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic)$/i;

/** Attachments that are images, by mimeType or by URL/name extension. */
export function selectImageAttachments(atts: TrelloAttachment[] = []): TrelloAttachment[] {
  return atts.filter((a) => {
    if (a.mimeType && a.mimeType.startsWith("image/")) return true;
    const urlPath = a.url ? (a.url.split("?")[0] ?? "") : "";
    if (urlPath && IMAGE_EXT.test(urlPath)) return true;
    if (a.name && IMAGE_EXT.test(a.name)) return true;
    return false;
  });
}

/**
 * Image URLs embedded in a card description (markdown images + bare image links). These URLs are
 * written by whoever edits the card, so they are DATA to show: nothing in this server fetches them,
 * and they must never be passed to fetchAttachment (client.ts), which sends the OAuth credential.
 */
export function extractDescImageUrls(desc = ""): string[] {
  const urls: string[] = [];
  let m: RegExpExecArray | null;

  const md = /!\[[^\]]*\]\(([^)\s]+)/g;
  while ((m = md.exec(desc)) !== null) {
    const u = m[1];
    if (u && !urls.includes(u)) urls.push(u);
  }

  const bare = /https?:\/\/[^\s)]+\.(?:png|jpe?g|gif|webp|bmp)/gi;
  while ((m = bare.exec(desc)) !== null) {
    const u = m[0];
    if (u && !urls.includes(u)) urls.push(u);
  }

  return urls;
}

/** Append an extension derived from the mimeType when the name has none. */
export function ensureImageExt(name: string, mimeType?: string | null): string {
  if (/\.[A-Za-z0-9]{1,5}$/.test(name)) return name;
  const sub = mimeType && mimeType.startsWith("image/") ? mimeType.slice(6) : "";
  const ext = sub === "jpeg" ? "jpg" : sub.replace(/[^a-z0-9]/gi, "");
  return ext ? `${name}.${ext}` : name;
}

// Drop control characters (< 0x20 and DEL) without embedding literal control
// bytes in the source — strips CR/LF/tab/NUL that could poison a path.
function stripControlChars(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  return out;
}

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

/** Filesystem-safe filename: basename only, no traversal/control chars, capped length. */
export function sanitizeFilename(name: string, maxLen = 120): string {
  const noControl = stripControlChars(name || "file");
  const justName = noControl.split(/[\\/]/).pop() ?? "file";
  let safe = justName.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  // Windows cuts trailing dots, so "a." and "a" would be the same name.
  safe = safe.replace(/\.+$/, (dots) => "_".repeat(dots.length));
  if (!safe) safe = "file";
  // Reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9), with or without an extension and in any
  // case, open a device instead of a directory entry on Windows: neutralized with a leading underscore.
  if (WINDOWS_RESERVED.test(safe)) safe = `_${safe}`;
  if (safe.length > maxLen) {
    const ext = path.extname(safe).slice(0, 10);
    safe = safe.slice(0, Math.max(1, maxLen - ext.length)) + ext;
  }
  return safe;
}

/** The path itself, if it is strictly inside `root`; throws otherwise. Compared with path.relative, never by string prefix. */
export function assertInside(root: string, target: string): string {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error("refusing to write outside the Trello cache folder");
  }
  return target;
}

/**
 * Local cache path for one attachment: <cacheRoot>/<listKey>/<cardKey>/NN-<safeName>. The three
 * keys come from Trello data (a list id, a card shortLink, an attachment name), so each one is reduced
 * to a plain base name and the result is checked to stay inside the cache root.
 */
export function attachmentDestPath(
  cacheRoot: string,
  listKey: string,
  cardKey: string,
  index: number,
  name: string,
  /** The reduction of each key to a base name. Injectable so the containment check below can be exercised on its own. */
  sanitize: (s: string) => string = sanitizeFilename,
): string {
  const idx = String(index + 1).padStart(2, "0");
  const file = `${idx}-${sanitize(name)}`;
  return assertInside(cacheRoot, path.join(cacheRoot, sanitize(listKey), sanitize(cardKey), file));
}

/** Reduce a raw Trello card + downloaded image paths into the manifest shape I read. */
export function shapeCardManifest(card: TrelloCard, imagePaths: string[]): CardManifest {
  return {
    id: card.id,
    name: card.name,
    shortUrl: card.shortUrl ?? "",
    idList: card.idList ?? "",
    due: card.due ?? null,
    labels: (card.labels ?? []).map((l) => l.name || l.color || "").filter((s) => s.length > 0),
    desc: card.desc ?? "",
    checklists: (card.checklists ?? []).map((cl) => ({
      name: cl.name,
      items: (cl.checkItems ?? []).map((ci) => ({ text: ci.name, checked: ci.state === "complete" })),
    })),
    images: imagePaths,
  };
}
