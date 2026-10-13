import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findVitestBin } from "../mcp/tools/run_tests.js";

// O aiteam/ vendorizado leva o ci-aiteam-sync.test.ts para cada consumidor, onde
// não há tools/aiteam-sync (e o CI nem sempre é um ci.yml). O `describe.skipIf` do
// vitest pula os testes do bloco, mas EXECUTA o corpo do describe na coleta: um
// readFileSync do ci.yml ali lançava ENOENT e o arquivo inteiro falhava, deixando
// o CI do consumidor vermelho no sync seguinte (crm só tem build.yml; vigacapital,
// rb-content-team, riosbraz e robo também falhavam).
//
// Aqui o arquivo roda de verdade, num subprocesso do vitest, com a raiz do repo
// (RB_REPO_ROOT) apontando para um diretório de consumidor.

const AITEAM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = "src/ci-aiteam-sync.test.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function consumer(files: Record<string, string>): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sync-consumer-")));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

function runInConsumer(root: string): { status: number; out: string } {
  const vitest = findVitestBin(AITEAM);
  expect(vitest, "vitest não encontrado a partir de aiteam/").toBeDefined();
  const env: NodeJS.ProcessEnv = { ...process.env, RB_REPO_ROOT: root };
  // Um vitest dentro do vitest: nada do worker de fora pode vazar para o de dentro.
  for (const k of Object.keys(env)) if (k.startsWith("VITEST")) delete env[k];
  delete env["INIT_CWD"];
  const r = spawnSync(process.execPath, [vitest!, "run", TARGET], { cwd: AITEAM, env, encoding: "utf8", timeout: 100_000 });
  return { status: r.status ?? 1, out: `${r.stdout}${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, "") };
}

const BUILD_YML = "name: build\non: [push]\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm --prefix aiteam test\n";

describe("ci-aiteam-sync.test.ts num consumidor — pulado, sem erro de coleta", () => {
  it("só tem build.yml (sem ci.yml, sem tools/aiteam-sync): o arquivo é pulado e o vitest sai com 0", { timeout: 120_000 }, () => {
    const r = runInConsumer(consumer({ ".github/workflows/build.yml": BUILD_YML }));
    expect(r.out).not.toMatch(/ENOENT|Failed Suites|FAIL/);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/skipped/);
  });

  it("tem um ci.yml qualquer, mas não o tools/aiteam-sync: pulado, sem ler o YAML", { timeout: 120_000 }, () => {
    // YAML que não parseia: se o corpo do describe o lesse, estouraria.
    const r = runInConsumer(consumer({ ".github/workflows/ci.yml": "jobs: [unclosed\n  - : :\n" }));
    expect(r.out).not.toMatch(/YAMLException|FAIL/);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/skipped/);
  });

  it("não tem .github nenhum: pulado", { timeout: 120_000 }, () => {
    const r = runInConsumer(consumer({ "README.md": "# app\n" }));
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/skipped/);
  });

  it("controle: no repo do framework (com a ferramenta e o ci.yml) o mesmo arquivo roda e passa", { timeout: 120_000 }, () => {
    const root = path.resolve(AITEAM, "..");
    if (!fs.existsSync(path.join(root, "tools", "aiteam-sync", "sync.mjs"))) return; // num consumidor não há o que controlar
    const r = runInConsumer(root);
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toMatch(/skipped/);
  });
});
