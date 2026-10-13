import * as fs from "fs";
import * as path from "path";
import { repoRoot } from "../../src/repo-root.js";
import { MAX_ATTACHMENT_BYTES, TooLargeError, fetchAttachment, type FetchLike } from "./client.js";
import type { TrelloCreds } from "./creds.js";
import { assertInside, attachmentDestPath, sanitizeFilename, selectImageAttachments, type TrelloCard } from "./manifest.js";

// The prints of a card (trello_get_card, trello_sync_list) are downloaded to a cache folder in the
// repo. It is NOT versioned: the prints are internal screens of the product and customer data of the
// team's board, and the install adds `.trello-cache/` to the host's .gitignore. The destination is
// never an input of the model — a tool that let the model pick it could write files anywhere.
export const CACHE_DIRNAME = ".trello-cache";

/** `<repo root>/.trello-cache`: the root of the repo (git toplevel), not the cwd the server happened to start in. */
export function defaultCacheRoot(root: string = repoRoot()): string {
  return path.resolve(root, CACHE_DIRNAME);
}

/** What the tools take besides the model's input: only code (the tests) sets it. */
export interface ToolDeps {
  fetchImpl?: FetchLike | undefined;
  cacheRoot?: string | undefined;
  /** Total of attachments trello_sync_list attempts in one call (default MAX_DOWNLOADS_PER_SYNC). */
  maxDownloads?: number | undefined;
  /** Total bytes trello_sync_list downloads in one call (default MAX_BYTES_PER_SYNC). */
  maxBytes?: number | undefined;
}

/** A list can hold hundreds of cards: a sync downloads at most this many attachments, then says what it left out. */
export const MAX_DOWNLOADS_PER_SYNC = 200;
/** ...and at most this many bytes (200 attachments × 25 MB would be 5 GB in one call). */
export const MAX_BYTES_PER_SYNC = 250 * 1024 * 1024;

export interface SniffedImage {
  ext: string;
  mime: string;
}

const startsWith = (buf: Buffer, bytes: number[], at = 0) => buf.length >= at + bytes.length && bytes.every((b, i) => buf[at + i] === b);
const ascii = (buf: Buffer, at: number, text: string) => buf.length >= at + text.length && buf.toString("latin1", at, at + text.length) === text;

/**
 * The type of an image from its first bytes — what the file IS, not what Trello's `mimeType` or the
 * attachment name claim. SVG is left out on purpose (XML that can carry script), and so is anything
 * else that is not a raster image.
 */
export function sniffImage(buf: Buffer): SniffedImage | null {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: "png", mime: "image/png" };
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { ext: "jpg", mime: "image/jpeg" };
  if (ascii(buf, 0, "GIF87a") || ascii(buf, 0, "GIF89a")) return { ext: "gif", mime: "image/gif" };
  if (ascii(buf, 0, "RIFF") && ascii(buf, 8, "WEBP")) return { ext: "webp", mime: "image/webp" };
  // BMP is only two bytes of signature: the reserved field (bytes 6-9) must be zero as well.
  if (startsWith(buf, [0x42, 0x4d]) && startsWith(buf, [0, 0, 0, 0], 6)) return { ext: "bmp", mime: "image/bmp" };
  if (startsWith(buf, [0x49, 0x49, 0x2a, 0x00]) || startsWith(buf, [0x4d, 0x4d, 0x00, 0x2a])) return { ext: "tiff", mime: "image/tiff" };
  if (ascii(buf, 4, "ftyp") && ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].some((brand) => ascii(buf, 8, brand))) {
    return { ext: "heic", mime: "image/heic" };
  }
  return null;
}

const LINK_REFUSAL = "refusing to write through a symbolic link or junction inside the Trello cache";

const lstatOrNull = (p: string): fs.Stats | null => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};

/**
 * Create `dir` (under `root`) one level at a time, refusing any level that is a symbolic link or a
 * junction. path.relative checks the TEXT of the path, and a link planted inside the cache — by a
 * script, a package, another tool — is followed by mkdir and by the write: "inside the cache" would
 * become "wherever the link points". The real paths are compared again at the end (defense in depth).
 */
export function ensureRealDir(root: string, dir: string): void {
  fs.mkdirSync(root, { recursive: true });
  const base = path.resolve(root);
  let cur = base;
  for (const segment of path.relative(base, path.resolve(dir)).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, segment);
    let stat = lstatOrNull(cur);
    if (!stat) {
      fs.mkdirSync(cur);
      stat = fs.lstatSync(cur);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(LINK_REFUSAL);
  }
  assertInside(fs.realpathSync(base), fs.realpathSync(dir));
}

/** Write the bytes of one print: through real folders only, and never over an existing link. */
export function writeInsideCache(root: string, dest: string, bytes: Buffer): void {
  ensureRealDir(root, path.dirname(dest));
  if (lstatOrNull(dest)?.isSymbolicLink()) throw new Error(LINK_REFUSAL);
  fs.writeFileSync(dest, bytes);
}

export interface DownloadOptions {
  cacheRoot: string;
  /** The list the card is in: the first folder under the cache root. */
  listKey: string;
  /** Cap of attachments attempted for this card. */
  cap: number;
  creds: TrelloCreds;
  fetchImpl?: FetchLike | undefined;
  /** Bytes left for the whole sync (shared by every card of it): each download takes from it. */
  budget?: ByteBudget | undefined;
}

/** What is left of the bytes a sync may download; `hit` says that an attachment was refused for lack of it. */
export interface ByteBudget {
  remaining: number;
  hit: boolean;
}

/**
 * Download the image attachments of a card into `<cacheRoot>/<list>/<card>/NN-<name>.<ext>`.
 *
 * - only attachments Trello holds (uploads) are fetched, only from Trello's hosts (client.ts);
 * - the file is saved only if its content IS an image, and its extension comes from the content;
 * - the name is the attachment's, reduced to a plain base name — never a path;
 * - failures are reported per attachment in `errors` and never stop the others.
 */
export async function downloadCardImages(card: TrelloCard, opts: DownloadOptions): Promise<{ paths: string[]; errors: string[] }> {
  const paths: string[] = [];
  const errors: string[] = [];
  const cardKey = card.shortLink ?? card.id;
  let index = 0;
  for (const att of selectImageAttachments(card.attachments).slice(0, opts.cap)) {
    const label = sanitizeFilename(att.name ?? `attachment-${att.id}`);
    try {
      if (!att.url) throw new Error("the attachment has no url");
      const room = opts.budget ? Math.min(MAX_ATTACHMENT_BYTES, opts.budget.remaining) : MAX_ATTACHMENT_BYTES;
      if (room <= 0) {
        if (opts.budget) opts.budget.hit = true;
        throw new Error("not downloaded: the byte cap of this sync is used up");
      }
      let bytes: Buffer;
      const tally = { bytes: 0 };
      try {
        bytes = await fetchAttachment(att.url, att.isUpload, opts.creds, opts.fetchImpl, room, tally);
      } catch (err) {
        // Refused for size against what the SYNC had left (not against the per-attachment cap): the budget was the limit.
        if (err instanceof TooLargeError && opts.budget && err.limit === opts.budget.remaining && err.limit < MAX_ATTACHMENT_BYTES) opts.budget.hit = true;
        throw err;
      } finally {
        // What was read spends the budget whether the download worked, was cut mid-stream or failed after
        // part of the body — a run of refused attachments must not read past the cap of the whole sync.
        if (opts.budget) opts.budget.remaining -= tally.bytes;
      }
      const kind = sniffImage(bytes);
      if (!kind) throw new Error("content is not a recognized image (png, jpeg, gif, webp, bmp, tiff, heic) — not saved");
      const dest = attachmentDestPath(opts.cacheRoot, opts.listKey, cardKey, index, `${path.parse(label).name}.${kind.ext}`);
      writeInsideCache(opts.cacheRoot, dest, bytes);
      paths.push(dest);
      index++;
    } catch (err) {
      errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { paths, errors };
}
