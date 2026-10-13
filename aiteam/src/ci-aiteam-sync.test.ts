import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./repo-root.js";

// A suíte do tools/aiteam-sync (node --test, 60+ testes do plano, do overlay e do
// render do sync que entrega o framework aos consumidores) não rodava em CI nenhum:
// o ci.yml só roda os comandos do ci: do SPEC.md, em aiteam/, e o sync mora fora
// dele. Um PR que quebrasse o sync passava verde. Este teste fixa que o job de
// validação a roda, na raiz do repo, em todo PR.
//
// Só vale onde a ferramenta existe: tools/aiteam-sync é do repo do framework e não
// viaja para os consumidores, que herdam este arquivo junto do aiteam/.

const root = repoRoot();
const SYNC_DIR = path.join(root, "tools", "aiteam-sync");
const workflowFile = path.join(root, ".github", "workflows", "ci.yml");

interface Step {
  name?: string;
  run?: string;
  if?: unknown;
  "working-directory"?: string;
  "continue-on-error"?: unknown;
}
interface Job {
  steps?: Step[];
  if?: unknown;
  "continue-on-error"?: unknown;
  defaults?: { run?: { "working-directory"?: string } };
}
interface Workflow {
  on?: unknown;
  defaults?: { run?: { "working-directory"?: string } };
  jobs?: Record<string, Job>;
}

const hasSyncTool = fs.existsSync(path.join(SYNC_DIR, "sync.mjs"));

// Nada aqui lê arquivo na COLETA: o describe.skipIf pula os testes do bloco, mas o
// vitest executa o corpo do describe mesmo assim. Num consumidor (sem
// tools/aiteam-sync; só um build.yml, ou um ci.yml que não é o do framework) um
// readFileSync no corpo lança e o arquivo inteiro falha. A leitura e o parse do
// YAML ficam em load(), chamado de dentro de cada it.
function load() {
  const doc = yaml.load(fs.readFileSync(workflowFile, "utf8")) as Workflow;
  const found = Object.entries(doc.jobs ?? {}).flatMap(([jobName, job]) =>
    (job.steps ?? [])
      .filter((s) => /\bnode\s+--test\b/.test(s.run ?? "") && /tools\/aiteam-sync\/src\//.test(s.run ?? ""))
      .map((step) => ({
        jobName,
        job,
        step,
        // O working-directory vale do passo, senão do job, senão do workflow; a raiz do repo se nenhum.
        dir: step["working-directory"] ?? job.defaults?.run?.["working-directory"] ?? doc.defaults?.run?.["working-directory"] ?? ".",
      })),
  );
  return { doc, found };
}

describe.skipIf(!hasSyncTool || !fs.existsSync(workflowFile))("CI — a suíte do tools/aiteam-sync roda em PR", () => {
  it("o ci.yml tem um passo que roda node --test nos testes do aiteam-sync", () => {
    const { found } = load();
    expect(found.length, "nenhum passo run: do ci.yml roda `node --test tools/aiteam-sync/src/*.test.mjs`").toBeGreaterThan(0);
  });

  it("o passo roda a partir da raiz do repo, onde o caminho tools/aiteam-sync existe", () => {
    const { found } = load();
    for (const f of found) {
      expect(path.posix.normalize(f.dir.replace(/\\/g, "/")), `${f.jobName} › ${f.step.name ?? f.step.run}`).toBe(".");
    }
  });

  it("o passo é bloqueante: sem if:, sem continue-on-error, e o comando não engole a falha", () => {
    const { found } = load();
    for (const f of found) {
      expect(f.step.if, `${f.jobName}: passo condicional`).toBeUndefined();
      expect(f.job.if, `${f.jobName}: job condicional`).toBeUndefined();
      expect(f.step["continue-on-error"], `${f.jobName}: passo com continue-on-error`).toBeUndefined();
      expect(f.job["continue-on-error"], `${f.jobName}: job com continue-on-error`).toBeUndefined();
      expect(f.step.run).not.toMatch(/\|\|\s*(true|:)\b|;\s*(true|:)\s*$/m);
    }
  });

  it("dispara em pull_request, sem filtro de paths que deixe um PR sem o check", () => {
    const { doc } = load();
    const on = doc.on as Record<string, unknown> | string | string[] | undefined;
    const pr =
      typeof on === "string" ? on === "pull_request" : Array.isArray(on) ? on.includes("pull_request") : on != null && "pull_request" in on;
    expect(pr).toBe(true);
    const filter = typeof on === "object" && on !== null && !Array.isArray(on) ? (on["pull_request"] as { paths?: unknown } | null)?.paths : undefined;
    expect(filter).toBeUndefined();
  });

  it("o glob do comando casa os arquivos de teste que existem", () => {
    const { found } = load();
    const tests = fs.readdirSync(path.join(SYNC_DIR, "src")).filter((f) => f.endsWith(".test.mjs"));
    expect(tests.length).toBeGreaterThan(0);
    for (const f of found) expect(f.step.run).toMatch(/tools\/aiteam-sync\/src\/\*\.test\.mjs/);
  });
});
