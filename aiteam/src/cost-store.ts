import * as fs from "fs";
import * as path from "path";
import type { Redis } from "ioredis";
import { writeFileAtomic } from "./beads-io.mjs";
import { repoRoot } from "./repo-root.js";

/**
 * Pluggable session-cost backend for the circuit breaker.
 *
 * The file store keeps cost in `.beads/session.local.json` — local session
 * state, ignored by git (aiteam/docs/beads-schema.md §10). It used to live in
 * the tracked `.beads/active.yaml`, which is now a generated view: writing
 * cost there would be overwritten by the next hook, and without the file the
 * breaker silently stopped counting. The Redis store keeps an atomic counter
 * so several agent processes can share one budget and trip exactly once —
 * Blueprint 8.2 — and mirrors the total into the same local file.
 */
export interface CostStore {
  /** Current accumulated session cost in USD. */
  get(): Promise<number>;
  /** Atomically add `cost` USD and return the new running total. */
  incrBy(cost: number): Promise<number>;
  /** Whether the breaker has already tripped this session. */
  isCircuitOpen(): Promise<boolean>;
  /** Persist that the breaker has tripped. */
  setCircuitOpen(): Promise<void>;
  /** Release any held resources (e.g. the Redis connection). */
  close(): Promise<void>;
}

interface LocalSession {
  cost_accumulated_usd: number;
  circuit_open: boolean;
  updated_at?: string;
  [k: string]: unknown;
}

const sessionPath = () => path.resolve(repoRoot(), ".beads", "session.local.json");

/**
 * What reading the local session gave. `missing` is a fresh worktree or clone
 * (cost 0). `bad` — unparseable JSON, a cost that is not a finite
 * non-negative number, or a file that stays unreadable — is never "cost 0":
 * that would reset the budget of a session that already tripped.
 */
type SessionRead = { kind: "ok"; state: LocalSession } | { kind: "missing" } | { kind: "bad"; reason: string; raw: string | null };

const TRANSIENT_READ = new Set(["EBUSY", "EPERM", "EACCES"]);
const READ_RETRY_MS = [10, 25, 50, 100, 200];

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readSessionFile(): SessionRead {
  let raw: string | null = null;
  // On Windows a reader can hit the file mid-rename (EPERM/EBUSY): retry briefly.
  for (let i = 0; raw === null; i++) {
    try {
      raw = fs.readFileSync(sessionPath(), "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (code === "ENOENT") return { kind: "missing" };
      if (TRANSIENT_READ.has(code) && i < READ_RETRY_MS.length) {
        sleepSync(READ_RETRY_MS[i]!);
        continue;
      }
      return { kind: "bad", reason: `ilegível (${code || String(err)})`, raw: null };
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { kind: "bad", reason: `JSON inválido (${(err as Error).message})`, raw };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "bad", reason: "não é um objeto JSON", raw };
  const obj = parsed as Record<string, unknown>;
  const cost = obj["cost_accumulated_usd"] ?? 0;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
    return { kind: "bad", reason: `cost_accumulated_usd inválido (${JSON.stringify(cost)})`, raw };
  }
  return { kind: "ok", state: { ...obj, cost_accumulated_usd: cost, circuit_open: obj["circuit_open"] === true } };
}

// One copy and one warning per distinct bad content, per process: every call
// to the breaker reads the file, and it must not flood the disk or the log.
const reported = new Set<string>();

function compactStamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

function reportBad(read: { reason: string; raw: string | null }): void {
  const key = `${sessionPath()}\0${read.reason}\0${read.raw ?? ""}`;
  if (reported.has(key)) return;
  reported.add(key);
  let copy = "";
  if (read.raw !== null) {
    const base = `${sessionPath()}.corrupt-${compactStamp(new Date())}`;
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? base : `${base}-${n}`;
      try {
        fs.writeFileSync(candidate, read.raw, { encoding: "utf8", flag: "wx" });
        copy = ` Cópia em ${candidate}.`;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST" || n > 50) break;
      }
    }
  }
  console.warn(
    `[cost-store] ${sessionPath()} ${read.reason}: circuit breaker aberto por segurança (store em arquivo) e o arquivo não será sobrescrito.${copy} ` +
      "Confira o custo real da sessão, corrija ou apague o arquivo para voltar a contar (aiteam/docs/beads-schema.md §10)."
  );
}

/** The session state, or null when the file is bad (already reported). */
function readSession(): LocalSession | null {
  const read = readSessionFile();
  if (read.kind === "ok") return read.state;
  if (read.kind === "missing") return { cost_accumulated_usd: 0, circuit_open: false };
  reportBad(read);
  return null;
}

// Creates the file (and .beads/) when missing: the breaker must keep counting
// in a fresh worktree or clone, where no local session exists yet. Temp file
// + rename: a concurrent reader never sees a half-written file.
function writeSession(state: LocalSession): void {
  try {
    fs.mkdirSync(path.dirname(sessionPath()), { recursive: true });
    const body = JSON.stringify({ ...state, updated_at: new Date().toISOString() }, null, 2);
    writeFileAtomic(sessionPath(), `${body}\n`);
  } catch {
    // Non-fatal — never block an API call over a file write failure.
  }
}

// ── File store (default, single-process) ─────────────────────────────────────
// Fails closed: with a bad session file the breaker reports an infinite cost
// and an open circuit, and never overwrites the file.
export class FileCostStore implements CostStore {
  async get(): Promise<number> {
    return readSession()?.cost_accumulated_usd ?? Number.POSITIVE_INFINITY;
  }

  async incrBy(cost: number): Promise<number> {
    const state = readSession();
    if (!state) return Number.POSITIVE_INFINITY;
    state.cost_accumulated_usd += cost;
    writeSession(state);
    return state.cost_accumulated_usd;
  }

  async isCircuitOpen(): Promise<boolean> {
    return readSession()?.circuit_open ?? true;
  }

  async setCircuitOpen(): Promise<void> {
    const state = readSession();
    if (!state) return;
    state.circuit_open = true;
    writeSession(state);
  }

  async close(): Promise<void> {
    // No resources to release.
  }
}

// ── Redis store (shared, atomic across processes) ────────────────────────────
export class RedisCostStore implements CostStore {
  private readonly costKey: string;
  private readonly circuitKey: string;

  constructor(
    private readonly redis: Redis,
    sessionId: string
  ) {
    this.costKey = `session:${sessionId}:cost`;
    this.circuitKey = `session:${sessionId}:circuit_open`;
  }

  async get(): Promise<number> {
    const raw = await this.redis.get(this.costKey);
    return raw ? parseFloat(raw) : 0;
  }

  async incrBy(cost: number): Promise<number> {
    const total = parseFloat(await this.redis.incrbyfloat(this.costKey, cost));
    // Mirror the running total into the local session file for the brief and the board.
    this.mirror(total);
    return total;
  }

  async isCircuitOpen(): Promise<boolean> {
    return (await this.redis.get(this.circuitKey)) === "1";
  }

  async setCircuitOpen(): Promise<void> {
    await this.redis.set(this.circuitKey, "1");
    const state = readSession();
    if (!state) return; // bad local mirror: reported, never overwritten
    state.circuit_open = true;
    writeSession(state);
  }

  async close(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      // Connection may already be closed.
    }
  }

  private mirror(total: number): void {
    const state = readSession();
    if (!state) return; // bad local mirror: reported, never overwritten
    state.cost_accumulated_usd = total;
    writeSession(state);
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────
type RedisFactory = () => Redis;

/**
 * Select a CostStore from the environment: `AI_COST_STORE=redis` (with
 * `REDIS_URL`) uses Redis; anything else (default) uses the file store.
 * `redisFactory` is injectable so tests can supply an in-memory client.
 */
export function createCostStore(redisFactory?: RedisFactory): CostStore {
  if ((process.env["AI_COST_STORE"] ?? "file") === "redis") {
    const sessionId = process.env["AI_SESSION_ID"] ?? "default";
    const redis = redisFactory ? redisFactory() : defaultRedis();
    return new RedisCostStore(redis, sessionId);
  }
  return new FileCostStore();
}

function defaultRedis(): Redis {
  // Lazy require so the ioredis dependency is only loaded on the redis path.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const RedisCtor = require("ioredis").Redis as typeof import("ioredis").Redis;
  return new RedisCtor(process.env["REDIS_URL"] ?? "redis://localhost:6379");
}
