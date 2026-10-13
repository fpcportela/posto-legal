import type { TrelloCreds } from "./creds.js";

const API_BASE = "https://api.trello.com/1";

// Minimal fetch surface so this module needs no DOM/undici type dependency
// (aiteam/tsconfig.json uses lib: ES2022, which has no fetch types).
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  statusText: string;
  /** Present on a real fetch Response; the redirect and size checks of attachment downloads read it. */
  headers?: { get(name: string): string | null };
  /** The body as a stream (a real fetch Response has it): lets a download be cut at its size limit. */
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<unknown> } } | null;
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; redirect?: "manual" | "follow" },
) => Promise<FetchResponseLike>;

const defaultFetch: FetchLike = (url, init) =>
  (globalThis as unknown as { fetch: FetchLike }).fetch(url, init);

export type QueryParams = Record<string, string | number | boolean | undefined>;

/** Build a Trello REST URL with key+token as query params (JSON endpoints). The host is always api.trello.com. */
export function buildUrl(apiPath: string, params: QueryParams, creds: TrelloCreds): string {
  const url = new URL(API_BASE + (apiPath.startsWith("/") ? apiPath : `/${apiPath}`));
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    url.searchParams.set(k, String(v));
  }
  url.searchParams.set("key", creds.key);
  url.searchParams.set("token", creds.token);
  return url.toString();
}

// Trello's attachment/download endpoints reject the ?key&token query auth and
// require an OAuth Authorization header instead — the single most common reason
// a naive Trello integration "reads text but never gets the images".
export function oauthHeader(creds: TrelloCreds): string {
  return `OAuth oauth_consumer_key="${creds.key}", oauth_token="${creds.token}"`;
}

/** Strip key/token from a string before it can reach a log or an error message. */
export function redactSecrets(text: string, creds: TrelloCreds): string {
  let out = text;
  if (creds.key) out = out.split(creds.key).join("<key>");
  if (creds.token) out = out.split(creds.token).join("<token>");
  return out;
}

async function ensureOk(res: FetchResponseLike, what: string, creds: TrelloCreds): Promise<void> {
  if (res.ok) return;
  let body = "";
  try {
    body = await res.text();
  } catch {
    /* body is best-effort */
  }
  // The WHOLE message goes through the redaction — the status line too, not just the body: a proxy or a
  // gateway may echo the request (with key and token in its query) in the status text.
  throw new Error(redactSecrets(`Trello ${what} failed: ${res.status} ${res.statusText} ${body}`, creds).slice(0, 260).trim());
}

/**
 * The only place a request leaves the process. A network failure can carry the request URL — key and
 * token in its query — in the message of the error, and that message ends up in the tool's answer, so
 * it is rewritten here with the secrets stripped.
 */
async function send(
  fetchImpl: FetchLike,
  url: string,
  init: NonNullable<Parameters<FetchLike>[1]>,
  what: string,
  creds: TrelloCreds,
): Promise<FetchResponseLike> {
  try {
    return await fetchImpl(url, init);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Trello ${what} request failed: ${redactSecrets(reason, creds)}`.slice(0, 260));
  }
}

/** A JSON answer of the API, unless it declares a size no list of cards or labels needs. */
const MAX_JSON_BYTES = 20 * 1024 * 1024;
async function readJson<T>(res: FetchResponseLike, what: string): Promise<T> {
  const declared = Number(res.headers?.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
    throw new Error(`Trello ${what} failed: response larger than ${MAX_JSON_BYTES / (1024 * 1024)} MB`);
  }
  return (await res.json()) as T;
}

// api.trello.com does not redirect; a 3xx there is an error, not a hop the credential should follow.
export async function trelloGet<T = unknown>(
  apiPath: string,
  params: QueryParams,
  creds: TrelloCreds,
  fetchImpl: FetchLike = defaultFetch,
): Promise<T> {
  const res = await send(
    fetchImpl,
    buildUrl(apiPath, params, creds),
    { headers: { Accept: "application/json" }, redirect: "manual" },
    `GET ${apiPath}`,
    creds,
  );
  await ensureOk(res, `GET ${apiPath}`, creds);
  return readJson<T>(res, `GET ${apiPath}`);
}

export async function trelloMutate<T = unknown>(
  method: "POST" | "PUT",
  apiPath: string,
  params: QueryParams,
  creds: TrelloCreds,
  fetchImpl: FetchLike = defaultFetch,
): Promise<T> {
  const what = `${method} ${apiPath}`;
  const res = await send(
    fetchImpl,
    buildUrl(apiPath, params, creds),
    { method, headers: { Accept: "application/json" }, redirect: "manual" },
    what,
    creds,
  );
  await ensureOk(res, what, creds);
  return readJson<T>(res, what);
}

// ── Attachment downloads ─────────────────────────────────────────────────────
// The attachment `url` comes from the card, and anyone with access to the board chooses it. So the
// OAuth header goes only to Trello's own API host, a link attachment is never fetched at all, and
// every redirect hop is checked again — a 302 must not carry the credential (or the request) out.

/** What the attachment endpoints serve from: redirects from the API land here, unauthenticated. */
function isStorageHost(host: string): boolean {
  return host === "trello-attachments.s3.amazonaws.com" || host === "trellousercontent.com" || host.endsWith(".trellousercontent.com");
}

/**
 * The only path that receives the credential: /1/cards/<id>/attachments/<id>/download/<file>. The file
 * segment takes unreserved characters, or a percent-encoding that is NOT of `/` (%2F), `\` (%5C) or `.`
 * (%2E): a parser or a server that decodes before it routes would read those as `../` and leave the
 * endpoint even with the right host (a difference between parsers, not something to bet on).
 */
const ATTACHMENT_DOWNLOAD_PATH = /^\/1\/cards\/[A-Za-z0-9]+\/attachments\/[A-Za-z0-9]+\/download\/(?:[A-Za-z0-9._~!'()*-]|%(?!2[eEfF]|5[cC])[0-9A-Fa-f]{2})+$/;

/** True when the (still percent-encoded) file segment, decoded, is a dot segment. Belt and braces: %2E is already refused. */
function isDotSegment(pathname: string): boolean {
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  try {
    const decoded = decodeURIComponent(last);
    return decoded === "." || decoded === "..";
  } catch {
    return true; // a malformed escape is not a file name
  }
}

export interface DownloadTarget {
  url: string;
  /** True only for api.trello.com: the one host that receives the Authorization header. */
  credentialed: boolean;
}

function classifyHost(raw: string): DownloadTarget {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("attachment URL is not a valid URL");
  }
  const host = u.hostname.toLowerCase();
  const refuse = (why: string) => new Error(`refusing to download ${host || "(no host)"}: ${why}`);
  if (u.protocol !== "https:") throw refuse(`${u.protocol} is not https`);
  if (u.username || u.password) throw refuse("credentials embedded in the URL");
  if (u.port) throw refuse("explicit port");
  if (host === "api.trello.com" || host === "trello.com") {
    // The credential is for ONE endpoint, not for "the API": a card must not be able to aim an
    // authenticated request at /1/members/me, a token, or anything else on the host. The URL parser has
    // already resolved dot segments (%2e%2e included), so the pathname below is what the server sees.
    if (!ATTACHMENT_DOWNLOAD_PATH.test(u.pathname) || isDotSegment(u.pathname)) {
      throw refuse("only the attachment download endpoint (/1/cards/<id>/attachments/<id>/download/<file>) receives the credential");
    }
    // The credentialed target carries no query and no fragment: nothing else may ride on the request that holds the credential.
    if (u.search !== "" || u.hash !== "" || /[?#]/.test(raw)) throw refuse("the credentialed request takes no query string or fragment");
    // The `url` of an uploaded attachment is https://trello.com/1/cards/…/download/…: the same endpoint, on the API host.
    u.hostname = "api.trello.com";
    return { url: u.toString(), credentialed: true };
  }
  if (isStorageHost(host)) return { url: u.toString(), credentialed: false };
  throw refuse("not a Trello host");
}

/** Whether (and how) an attachment may be downloaded. Throws with the reason; the URL is never put in the message. */
export function classifyDownloadUrl(raw: string, isUpload: boolean | undefined): DownloadTarget {
  if (isUpload !== true) throw new Error("attachment is not an upload (an external link): not downloaded");
  return classifyHost(raw);
}

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 3;

/** An attachment bigger than the limit the caller allowed. `limit` is that limit, in bytes. */
export class TooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`Trello attachment download failed: larger than ${limit % (1024 * 1024) === 0 ? `${limit / (1024 * 1024)} MB` : `${limit} bytes`}`);
  }
}

/** How many bytes a download actually read, filled in while it runs — so a failed download is still accounted for. */
export interface ByteTally {
  bytes: number;
}

/**
 * The body of a response, never more than `max` bytes. A declared Content-Length above the limit is
 * refused without reading; a body without one (or one that lies) is read as a stream and cut at the
 * limit — `arrayBuffer()` would read it all first. A response with no stream (a test fake) is checked
 * after reading.
 */
async function readCapped(res: FetchResponseLike, max: number, tally?: ByteTally): Promise<Buffer> {
  const declared = Number(res.headers?.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) throw new TooLargeError(max);
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (tally) tally.bytes += buf.length;
    if (buf.length > max) throw new TooLargeError(max);
    return buf;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    // Counted as it is read, BEFORE any refusal: what came off the wire spends the caller's budget even
    // when the download is then cut, refused or fails half way.
    if (tally) tally.bytes += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new TooLargeError(max);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/**
 * Download an uploaded attachment's bytes, at most `maxBytes` (default 25 MB). Credentials go only to
 * the attachment download endpoint of api.trello.com; redirects are checked hop by hop.
 */
export async function fetchAttachment(
  url: string,
  isUpload: boolean | undefined,
  creds: TrelloCreds,
  fetchImpl: FetchLike = defaultFetch,
  maxBytes: number = MAX_ATTACHMENT_BYTES,
  tally?: ByteTally,
): Promise<Buffer> {
  let target = classifyDownloadUrl(url, isUpload);
  for (let hop = 0; ; hop++) {
    const headers: Record<string, string> = target.credentialed ? { Authorization: oauthHeader(creds) } : {};
    const res = await send(fetchImpl, target.url, { headers, redirect: "manual" }, "attachment download", creds);
    if (res.status >= 300 && res.status < 400) {
      if (hop >= MAX_REDIRECTS) throw new Error("Trello attachment download failed: too many redirects");
      const location = res.headers?.get("location");
      if (!location) throw new Error("Trello attachment download failed: redirect without a Location header");
      let next: string;
      try {
        next = new URL(location, target.url).toString();
      } catch {
        throw new Error("Trello attachment download failed: redirect to a URL that is not valid");
      }
      target = classifyHost(next);
      continue;
    }
    await ensureOk(res, "attachment download", creds);
    return readCapped(res, maxBytes, tally);
  }
}
