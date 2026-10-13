import * as fs from "fs";
import * as path from "path";
import { repoRoot } from "../../src/repo-root.js";

export interface TrelloCreds {
  key: string;
  token: string;
}

type EnvLike = Record<string, string | undefined>;

// Trello API keys/tokens are alphanumeric; enforcing that both blocks
// header-injection into the OAuth Authorization header (client.ts) and catches
// obviously-malformed values early.
const VALID = /^[A-Za-z0-9]+$/;

// The only variables this process takes from the .env: the root .env also holds the
// project's database, deploy and API secrets, and none of them belongs in the MCP's environment.
const TRELLO_VAR = /^TRELLO_[A-Z0-9_]+$/;

/**
 * Minimal .env loader so `npx tsx aiteam/mcp/trello-server.ts` picks up TRELLO_*
 * from the gitignored repo-root .env without adding a dotenv dependency. Only
 * TRELLO_* lines are read. Values already present in the environment win, so
 * .mcp.json ${VAR} expansion or the OS environment still override the file.
 * The root is the repo's (git toplevel), not the cwd the server started in.
 */
export function loadRootEnv(root: string = repoRoot(), env: EnvLike = process.env): void {
  let raw: string;
  try {
    raw = fs.readFileSync(path.resolve(root, ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    if (!TRELLO_VAR.test(k) || env[k] !== undefined) continue;
    let v = trimmed.slice(eq + 1).trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1);
    }
    env[k] = v;
  }
}

/** Read and validate Trello creds. Throws a message that never contains the values. */
export function requireCreds(env: EnvLike = process.env): TrelloCreds {
  const key = env.TRELLO_API_KEY?.trim() ?? "";
  const token = env.TRELLO_TOKEN?.trim() ?? "";

  const missing: string[] = [];
  if (!key) missing.push("TRELLO_API_KEY");
  if (!token) missing.push("TRELLO_TOKEN");
  if (missing.length > 0) {
    throw new Error(
      `Trello MCP: missing ${missing.join(" and ")}. Add them to the gitignored root .env ` +
        `(TRELLO_API_KEY=… and TRELLO_TOKEN=…), then reload the agent — the server reads .env once, at start. ` +
        `Get the key at https://trello.com/power-ups/admin and a token with scope=read,write at https://trello.com/1/authorize.`,
    );
  }

  for (const [name, val] of [
    ["TRELLO_API_KEY", key],
    ["TRELLO_TOKEN", token],
  ] as const) {
    if (!VALID.test(val)) {
      throw new Error(`Trello MCP: ${name} has an invalid format (expected alphanumeric).`);
    }
  }

  return { key, token };
}
