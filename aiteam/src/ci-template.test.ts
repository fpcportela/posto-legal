import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { evaluateCiContract } from "./ci-contract-core.mjs";
import { repoRoot } from "./repo-root.js";

// O template é o pipeline de PR que os consumidores COPIAM (copy-once), irmão
// do deploy.yml.example. Até a #31 o framework não oferecia nenhum, e quem
// adotava copiava o .github/workflows/ci.yml do próprio framework: aiteam-
// scoped, o que é certo lá, onde o aiteam/ é a aplicação, mas que num
// consumidor valida a dependência em vez do produto. Este teste lê só o
// template vendorizado, então vale igual no framework e no consumidor.
const raw = fs.readFileSync(path.resolve(repoRoot(), "aiteam", "templates", "ci.yml.example"), "utf8");

interface Step {
  run?: string;
  uses?: string;
}
interface Job {
  defaults?: { run?: { "working-directory"?: string } };
  steps?: Step[];
  "timeout-minutes"?: number;
}
interface Workflow {
  on?: { push?: unknown; pull_request?: { paths?: unknown; "paths-ignore"?: unknown } | null };
  defaults?: unknown;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs?: Record<string, Job>;
}

const doc = yaml.load(raw) as Workflow;
const jobs = doc.jobs ?? {};
const runs = (job: Job | undefined) => (job?.steps ?? []).map((s) => s.run ?? "").filter(Boolean);

// A fórmula que já foi reescrita errada sete vezes (docs/consuming-INDEX.md §4).
const CONCURRENCY_3_SEGMENTOS =
  "${{ github.workflow }}-${{ github.ref }}-${{ github.event_name == 'push' && github.sha || 'pr' }}";

const CI_DA_APP = "---\nci:\n  test: npm run test\n  typecheck: npm run typecheck\n  lint: npm run lint\n---\n";

describe("ci.yml.example — dois jobs: o framework e a app", () => {
  it("tem exatamente os jobs framework e app", () => {
    expect(Object.keys(jobs).sort()).toEqual(["app", "framework"]);
  });

  it("o diretório mora em cada job: framework em aiteam/, app na raiz, nada no nível do workflow", () => {
    expect(doc.defaults, "defaults no nível do workflow vale para os dois jobs").toBeUndefined();
    expect(jobs.framework?.defaults?.run?.["working-directory"]).toBe("aiteam");
    expect(jobs.app?.defaults).toBeUndefined();
  });

  it("o job framework tem os passos do ci.yml do framework", () => {
    const passos = runs(jobs.framework);
    for (const cmd of ["npm ci", "npm run typecheck", "npm run validate:beads", "npm run validate:agents", "npm run test"]) {
      expect(passos, cmd).toContain(cmd);
    }
  });

  it("um comentário diz que o job app é o que torna o item 1 verdadeiro", () => {
    expect(raw).toMatch(/O job `app` é o que torna o item 1 verdadeiro/);
    expect(raw).toMatch(/CI\/CD Mandate/);
    expect(raw).toMatch(/SPEC\.md/);
  });
});

describe("ci.yml.example — o contrato de CI aceita o job app, e só ele", () => {
  it("o ci: de uma app na raiz (test, typecheck e lint) roda inteiro no job app", () => {
    const r = evaluateCiContract({ specText: CI_DA_APP, workflows: [{ file: "ci.yml", doc }], readScripts: () => null });
    expect(r.findings).toEqual([]);
    expect(r.located.map((l) => l.key).sort()).toEqual(["lint", "test", "typecheck"]);
    for (const l of r.located) expect(l.where.map((w) => w.job), l.key).toEqual(["app"]);
  });

  it("sem o job app, o mesmo ci: reprova — o job framework roda os mesmos comandos, mas em aiteam/", () => {
    const soFramework = { ...doc, jobs: { framework: jobs.framework } };
    const r = evaluateCiContract({ specText: CI_DA_APP, workflows: [{ file: "ci.yml", doc: soFramework }], readScripts: () => null });
    const reprovados = r.findings.filter((f) => f.level === "fail");
    expect(reprovados.map((f) => f.key)).toEqual(["test", "typecheck", "lint"]);
    expect(reprovados.find((f) => f.key === "test")?.message).toMatch(/framework vendorizado/);
  });
});

describe("ci.yml.example — higiene de CI (as regras do ci-contract.test.ts)", () => {
  it("dispara em todo PR: pull_request sem filtro de paths", () => {
    expect(doc.on).toHaveProperty("pull_request");
    expect(doc.on?.pull_request?.paths).toBeUndefined();
    expect(doc.on?.pull_request?.["paths-ignore"]).toBeUndefined();
  });

  it("dispara em push, então o group de concurrency é a fórmula de 3 segmentos", () => {
    expect(doc.on).toHaveProperty("push");
    expect(doc.concurrency?.group).toBe(CONCURRENCY_3_SEGMENTOS);
    expect(doc.concurrency?.["cancel-in-progress"]).toBe(true);
  });

  it("todo job declara timeout-minutes", () => {
    for (const [nome, job] of Object.entries(jobs)) {
      expect(job["timeout-minutes"], `job ${nome}`).toBeGreaterThan(0);
    }
  });

  it("nenhum passo usa manual-approval", () => {
    for (const job of Object.values(jobs)) {
      for (const s of job.steps ?? []) expect(s.uses ?? "").not.toMatch(/manual-approval/);
    }
  });
});
