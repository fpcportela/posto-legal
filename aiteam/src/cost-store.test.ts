import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import {
  FileCostStore,
  RedisCostStore,
  createCostStore,
  type CostStore,
} from "./cost-store.js";

// O custo da sessão é estado local (aiteam/docs/beads-schema.md §10): mora em
// .beads/session.local.json, fora do git. Antes ele vivia no active.yaml
// rastreado — e, sem active.yaml, o breaker parava de somar sem aviso.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sessionFile = (dir: string) => path.join(dir, ".beads", "session.local.json");
const readSession = (dir: string) => JSON.parse(fs.readFileSync(sessionFile(dir), "utf8"));
const seedSession = (dir: string, cost: number, circuitOpen = false) => {
  fs.mkdirSync(path.join(dir, ".beads"), { recursive: true });
  fs.writeFileSync(sessionFile(dir), JSON.stringify({ cost_accumulated_usd: cost, circuit_open: circuitOpen }), "utf8");
};

function useTempRepo() {
  const originalCwd = process.cwd();
  const ctx = { dir: "" };
  beforeEach(() => {
    ctx.dir = fs.mkdtempSync(path.join(os.tmpdir(), "cost-store-"));
    process.chdir(ctx.dir);
    process.env["RB_REPO_ROOT"] = ctx.dir;
  });
  afterEach(() => {
    process.chdir(originalCwd);
    delete process.env["RB_REPO_ROOT"];
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  });
  return ctx;
}

describe("FileCostStore — .beads/session.local.json", () => {
  const repo = useTempRepo();
  let store: CostStore;
  beforeEach(() => {
    store = new FileCostStore();
  });
  afterEach(async () => {
    await store.close();
  });

  it("lê o custo acumulado do arquivo local", async () => {
    seedSession(repo.dir, 0.5);
    expect(await store.get()).toBeCloseTo(0.5, 10);
  });

  it("devolve 0 quando o arquivo não existe", async () => {
    expect(await store.get()).toBe(0);
  });

  it("incrBy cria o arquivo quando ele falta — o breaker nunca para de contar", async () => {
    expect(await store.incrBy(0.25)).toBeCloseTo(0.25, 10);
    expect(await store.incrBy(0.25)).toBeCloseTo(0.5, 10);
    expect(readSession(repo.dir).cost_accumulated_usd).toBeCloseTo(0.5, 10);
    expect(readSession(repo.dir).updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("persiste e informa o circuit breaker aberto", async () => {
    expect(await store.isCircuitOpen()).toBe(false);
    await store.setCircuitOpen();
    expect(await store.isCircuitOpen()).toBe(true);
    expect(readSession(repo.dir).circuit_open).toBe(true);
  });

  // Ilegível não é "custo zero": seria zerar o orçamento e fechar o circuito
  // de quem já estourou. Falha fechado, sem sobrescrever, e guarda uma cópia.
  it("arquivo corrompido: falha fechado, não sobrescreve, guarda uma cópia .corrupt-<ts> e avisa uma vez", async () => {
    fs.mkdirSync(path.join(repo.dir, ".beads"), { recursive: true });
    const broken = '{"cost_accumulated_usd": 1.75, "circuit_op';
    fs.writeFileSync(sessionFile(repo.dir), broken, "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await store.isCircuitOpen()).toBe(true);
      expect(await store.get()).toBe(Number.POSITIVE_INFINITY);
      expect(await store.incrBy(0.1)).toBe(Number.POSITIVE_INFINITY);
      await store.setCircuitOpen();
      expect(fs.readFileSync(sessionFile(repo.dir), "utf8")).toBe(broken);
      const copies = fs.readdirSync(path.join(repo.dir, ".beads")).filter((n) => n.startsWith("session.local.json.corrupt-"));
      expect(copies).toHaveLength(1);
      expect(fs.readFileSync(path.join(repo.dir, ".beads", copies[0]!), "utf8")).toBe(broken);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/session\.local\.json.*circuit breaker aberto/);
    } finally {
      warn.mockRestore();
    }
  });

  it("custo que não é número finito e não negativo também é corrupção", async () => {
    seedSession(repo.dir, -3);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await store.isCircuitOpen()).toBe(true);
      expect(await store.get()).toBe(Number.POSITIVE_INFINITY);
    } finally {
      warn.mockRestore();
    }
  });

  it("escreve atômico: nenhum temporário sobra e o arquivo é sempre JSON completo", async () => {
    for (let i = 0; i < 20; i++) await store.incrBy(0.01);
    expect(readSession(repo.dir).cost_accumulated_usd).toBeCloseTo(0.2, 10);
    expect(fs.readdirSync(path.join(repo.dir, ".beads"))).toEqual(["session.local.json"]);
  });

  it("dois processos somando ao mesmo tempo: nada corrompe nem abre o circuito à toa", { timeout: 120_000 }, async () => {
    const script = path.join(repo.dir, "incr.mts");
    const storeUrl = pathToFileURL(path.join(HERE, "cost-store.ts")).href;
    fs.writeFileSync(
      script,
      `import { FileCostStore } from ${JSON.stringify(storeUrl)};\n` +
        "const s = new FileCostStore();\n" +
        "for (let i = 0; i < 200; i++) await s.incrBy(0.01);\n" +
        "if (await s.isCircuitOpen()) { console.error('circuito aberto'); process.exit(3); }\n",
      "utf8"
    );
    const run = () =>
      new Promise<{ code: number | null; err: string }>((resolve) => {
        const p = spawn(process.execPath, ["--import", "tsx", script], {
          cwd: path.resolve(HERE, ".."),
          env: { ...process.env, RB_REPO_ROOT: repo.dir },
          windowsHide: true,
        });
        let err = "";
        p.stderr.on("data", (d) => (err += String(d)));
        p.on("close", (code) => resolve({ code, err }));
      });
    const results = await Promise.all([run(), run()]);
    for (const r of results) expect(r.code, r.err).toBe(0);
    const names = fs.readdirSync(path.join(repo.dir, ".beads"));
    expect(names).toEqual(["session.local.json"]);
    const total = readSession(repo.dir).cost_accumulated_usd;
    // Sem trava entre processos (o Redis é o store multi-processo): pode
    // perder incremento, nunca passar da soma nem zerar.
    expect(total).toBeGreaterThan(1.0);
    expect(total).toBeLessThanOrEqual(4.0 + 1e-9);
    expect(readSession(repo.dir).circuit_open).toBe(false);
  });

  it("nunca escreve no .beads/active.yaml (visão gerada) nem no git", async () => {
    fs.mkdirSync(path.join(repo.dir, ".beads"), { recursive: true });
    const view = "# GERADO por aiteam/scripts/beads-views.mjs\nversion: \"2\"\n";
    fs.writeFileSync(path.join(repo.dir, ".beads", "active.yaml"), view, "utf8");
    await store.incrBy(1);
    await store.setCircuitOpen();
    expect(fs.readFileSync(path.join(repo.dir, ".beads", "active.yaml"), "utf8")).toBe(view);
  });
});

describe("RedisCostStore", () => {
  const repo = useTempRepo();
  let redis: Redis;
  let store: CostStore;

  beforeEach(async () => {
    redis = new RedisMock() as unknown as Redis;
    // ioredis-mock shares one in-memory dataset across instances — clear it so
    // counters don't leak between tests.
    await redis.flushall();
    store = new RedisCostStore(redis, "sess-test");
  });

  afterEach(async () => {
    await store.close();
  });

  it("starts at zero", async () => {
    expect(await store.get()).toBe(0);
  });

  it("accrues concurrent increments against one atomic counter", async () => {
    await Promise.all([store.incrBy(0.1), store.incrBy(0.2), store.incrBy(0.3)]);
    expect(await store.get()).toBeCloseTo(0.6, 6);
  });

  it("persists the circuit-open flag in redis", async () => {
    expect(await store.isCircuitOpen()).toBe(false);
    await store.setCircuitOpen();
    expect(await store.isCircuitOpen()).toBe(true);
  });

  it("espelha o total e o circuit breaker no arquivo local, para o brief e o board", async () => {
    await store.incrBy(0.42);
    expect(readSession(repo.dir).cost_accumulated_usd).toBeCloseTo(0.42, 10);
    await store.setCircuitOpen();
    expect(readSession(repo.dir).circuit_open).toBe(true);
  });
});

describe("createCostStore", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("defaults to the file store", () => {
    delete process.env["AI_COST_STORE"];
    const store = createCostStore();
    expect(store).toBeInstanceOf(FileCostStore);
  });

  it("returns a redis store when AI_COST_STORE=redis", async () => {
    process.env["AI_COST_STORE"] = "redis";
    process.env["REDIS_URL"] = "redis://localhost:6379";
    const store = createCostStore(() => new RedisMock() as unknown as Redis);
    expect(store).toBeInstanceOf(RedisCostStore);
    await store.close();
  });
});
