import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { evaluateCiContract, FRAMEWORK_DIR, isAppManifest, readCiBlock } from "./ci-contract-core.mjs";
import { isUpstream, repoRoot } from "./repo-root.js";

// AGENTS.md §CI/CD Mandate, item 1: o pipeline de PR é bloqueante e roda os
// testes da app em todo PR — e lint e typecheck, quando o projeto os declara
// no bloco ci: do SPEC.md. O framework impõe isso aos consumidores e por um
// tempo não valeu para ele mesmo: um único `paths:` no topo do workflow
// governava os dois jobs, então mudança em aiteam/src/ ou aiteam/githooks/ não
// disparava nada. Dois PRs passaram sem CI e só tiveram checks por acidente,
// por terem tocado package.json e SPEC.md.
interface Job {
  steps?: Array<{ run?: string; uses?: string }>;
  "timeout-minutes"?: number;
}

interface Workflow {
  name?: string;
  on?: { push?: { branches?: string[] } | null; pull_request?: { paths?: string[] } | null };
  concurrency?: string | { group?: string; "cancel-in-progress"?: boolean | string };
  jobs?: Record<string, Job>;
}

const root = repoRoot();
const dir = path.resolve(root, ".github", "workflows");

const workflows = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  .map((f) => ({ file: f, doc: yaml.load(fs.readFileSync(path.join(dir, f), "utf8")) as Workflow }));

// O que o projeto declara no SPEC.md (bloco ci:) e o `scripts` do package.json
// de cada diretório que o núcleo precisar seguir — é por eles que ele recusa
// um `npm test` que só delega para o aiteam/.
const specText = (() => {
  try {
    return fs.readFileSync(path.join(root, "SPEC.md"), "utf8");
  } catch {
    return null;
  }
})();

const readScripts = (rel: string): Record<string, unknown> | null => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, rel, "package.json"), "utf8")) as { scripts?: unknown };
    return pkg.scripts !== null && typeof pkg.scripts === "object" ? (pkg.scripts as Record<string, unknown>) : {};
  } catch {
    return null;
  }
};

// Os manifestos de app na raiz: com algum deles, um ci.workdir dentro de
// aiteam/ declara o framework no lugar da app.
const rootManifests = fs.readdirSync(root).filter(isAppManifest);

const runsAll = (w: Workflow): string =>
  Object.values(w.jobs ?? {})
    .flatMap((j) => j.steps ?? [])
    .map((s) => s.run ?? "")
    .join("\n");

// Workflow que bate na API paga: roda `npm run eval`. O detector é este regex, e o
// teste que o usa prova o regex por fixture (rb-ai-team#62).
const hasPaidEval = (w: Workflow): boolean => /npm run eval\b/.test(runsAll(w));

// Os arquivos dos workflows com eval pago que NÃO têm `paths:` não vazio no
// pull_request. Lista vazia quando não há eval pago, ou não há workflow nenhum.
const paidEvalWithoutPathFilter = (ws: Array<{ file: string; doc: Workflow }>): string[] =>
  ws.filter((w) => hasPaidEval(w.doc) && !(w.doc.on?.pull_request?.paths?.length ?? 0)).map((w) => w.file);

// `on` pode vir como mapping ({push: {...}}), lista (on: [push, pull_request])
// ou escalar (on: push) — só a forma de mapping aparece nos workflows deste
// repo hoje. Formato não reconhecido lança em vez de virar "sem push": um
// falso-negativo aqui deixaria o teste abaixo passar verde sem checar nada,
// exatamente o tipo de furo que esta suíte existe para fechar.
function hasPushTrigger(w: Workflow): boolean {
  const on: unknown = w.on;
  if (on == null) return false;
  if (Array.isArray(on)) return on.includes("push");
  if (typeof on === "string") return on === "push";
  if (typeof on === "object" && on !== null) return "push" in on;
  throw new Error(`"on" de workflow em formato não tratado (${typeof on}) — estenda hasPushTrigger`);
}

const concurrencyGroup = (w: Workflow): string | undefined => {
  const c = w.concurrency;
  return typeof c === "string" ? c : c?.group;
};

describe("CI — o mandato do framework vale para o próprio framework", () => {
  // Esta asserção era "existe workflow que roda a suíte de testes em PR", e
  // casava /npm (run )?test/ em qualquer run:. Num consumidor que copiou o
  // ci.yml do framework, o único `npm run test` rodava em aiteam/ — e ela
  // passava, certificando o mandato onde a suíte da app nunca rodava em PR
  // (rb-ai-team#31). Agora o projeto declara no SPEC.md, no bloco ci:, o que o
  // CI de PR roda, e o núcleo confere comando E diretório
  // (aiteam/src/ci-contract-core.mjs, o mesmo do doctor). Num consumidor sem o
  // bloco este teste falha de propósito, com a mensagem do que declarar.
  it("o CI de PR roda os comandos que o SPEC.md declara em ci:, no workdir declarado", () => {
    const r = evaluateCiContract({ specText, workflows, readScripts, rootManifests });
    const reprovados = r.findings.filter((f) => f.level === "fail").map((f) => f.message);
    expect(reprovados, "contrato de CI — aiteam/AGENTS.md §CI/CD Mandate, item 1").toEqual([]);
  });

  // Revisão de segurança da #31: o fluxo "Using This Repo as a Template" do
  // aiteam/README.md clona este repo inteiro, com o SPEC.md de workdir: aiteam
  // e o ci.yml aiteam-scoped, e põe a app na raiz. Esse mesmo SPEC.md e esses
  // mesmos workflows, com uma app na raiz, têm de reprovar. Só se aplica onde o
  // SPEC.md declara o workdir dentro de aiteam/ (o framework e quem o clonou);
  // num consumidor com o workdir da app o caso não existe, e o teste é pulado.
  const declarado = readCiBlock(specText);
  const workdirNoFramework =
    declarado.state === "ok" &&
    (declarado.ci.workdir === FRAMEWORK_DIR || declarado.ci.workdir.startsWith(`${FRAMEWORK_DIR}/`));
  it.skipIf(!workdirNoFramework)("clonado como template, com uma app na raiz, este SPEC.md e estes workflows reprovam", () => {
    const r = evaluateCiContract({ specText, workflows, readScripts, rootManifests: ["package.json"] });
    const reprovados = r.findings.filter((f) => f.level === "fail").map((f) => f.message);
    expect(reprovados).toEqual([
      expect.stringMatching(/a raiz tem uma app \(package\.json\), mas ci\.workdir aponta para o framework vendorizado/),
    ]);
  });

  // Havia aqui uma asserção "o workflow que roda os testes NÃO tem filtro de
  // path", que achava esse workflow por /npm (run )?test/ e não via um pytest
  // nem um pnpm. Saiu na revisão da #31: o filtro de paths agora é julgado
  // pelo núcleo, no workflow onde o comando declarado roda — paths positivo
  // reprova, paths-ignore avisa —, e o contract test e o doctor dão o mesmo
  // veredito pela asserção do contrato acima.

  // O contrapeso: eval bate na API paga. Rodar em todo PR trocaria um furo de
  // cobertura por queima de budget — o filtro ali é correto e deve continuar.
  // Vale QUANDO o workflow existe: um consumidor sem eval pago (o robo-pb-raspagem
  // aposentou o eval.yml herdado do template) é uma topologia legítima, não um
  // defeito, e a asserção não pode exigir que haja um (rb-ai-team#62). Como no
  // hasPushTrigger abaixo, fixtures sintéticas provam o detector e o filtro
  // diretamente, e a asserção sobre os workflows reais itera sobre o que houver,
  // inclusive nada — vácuo correto num repo sem eval pago.
  it("o detector de eval pago acha `npm run eval` e a checagem de filtro reprova eval sem paths:", () => {
    const eval_ = (on: NonNullable<Workflow["on"]>): Workflow => ({ on, jobs: { evals: { steps: [{ run: "npm run eval" }] } } });
    const filtrado = eval_({ pull_request: { paths: ["aiteam/src/**"] } });
    const semFiltro = eval_({ pull_request: null });
    const filtroVazio = eval_({ pull_request: { paths: [] } });
    const semEval: Workflow = { on: { pull_request: null }, jobs: { build: { steps: [{ run: "npm test" }, { run: "npm run evaluate-later" }] } } };

    expect(hasPaidEval(filtrado)).toBe(true);
    expect(hasPaidEval(semEval)).toBe(false);

    expect(paidEvalWithoutPathFilter([{ file: "eval.yml", doc: filtrado }])).toEqual([]);
    expect(paidEvalWithoutPathFilter([{ file: "eval.yml", doc: semFiltro }])).toEqual(["eval.yml"]);
    expect(paidEvalWithoutPathFilter([{ file: "eval.yml", doc: filtroVazio }])).toEqual(["eval.yml"]);
    // Sem eval pago, ou sem workflow nenhum, não há o que reprovar.
    expect(paidEvalWithoutPathFilter([{ file: "build.yml", doc: semEval }])).toEqual([]);
    expect(paidEvalWithoutPathFilter([])).toEqual([]);
  });

  it("o workflow que roda os evals pagos CONTINUA filtrado por path", () => {
    expect(paidEvalWithoutPathFilter(workflows), "workflow que roda eval pago sem filtro de path").toEqual([]);
  });

  // No upstream o eval pago existe (eval.yml): sem isto, apagá-lo ou trocar o passo por uma
  // forma que o detector não reconhece deixaria a checagem acima passar em silêncio. O
  // consumidor sem eval pago (#62) não roda este caso.
  it.skipIf(!isUpstream())("no upstream, o eval pago existe e o detector o acha", () => {
    expect(workflows.filter((w) => hasPaidEval(w.doc)).map((w) => w.file)).toContain("eval.yml");
  });

  // AGENTS.md §CI/CD Mandate: o contrato protegia cobertura e não custo. A cota
  // de Actions estourou em 2026-07-29 (4.063 min faturáveis em julho contra
  // 2.000 de cota) e derrubou a pipeline inteira, deploy de produção incluído.
  // Spec: docs/superpowers/specs/2026-07-30-ci-actions-minutes-design.md
  it("todo workflow declara concurrency — run superseded não queima cota", () => {
    for (const w of workflows) {
      expect(w.doc.concurrency, `${w.file} não declara concurrency`).toBeDefined();
    }
  });

  // A garantia que interessa aqui é "hasPushTrigger funciona", não "este repo
  // tem workflow com push" — um consumidor legitimamente PR-only (só
  // pull_request/workflow_dispatch) não é bug, e não deve ficar com CI
  // vermelho por uma topologia válida. Fixtures sintéticas provam o detector
  // diretamente; a asserção seguinte pode então iterar sobre um comPush vazio
  // sem exigir que ele não seja vazio — vácuo correto num repo PR-only.
  it("hasPushTrigger reconhece push e ignora workflow só de pull_request", () => {
    expect(hasPushTrigger({ on: { push: { branches: ["main"] } } })).toBe(true);
    expect(hasPushTrigger({ on: { pull_request: { paths: ["src/**"] } } })).toBe(false);
  });

  // O toBeDefined() acima não pega a fórmula errada: um group de 2 segmentos
  // (workflow+ref) passa nele tão bem quanto um de 3. Em push para main o
  // github.ref é sempre "refs/heads/main" — constante — e o GitHub mantém no
  // máximo 1 run pending por group, descartando o anterior quando outro chega
  // (cancel-in-progress não muda isso). Uma rajada de 3+ pushes deixa commits
  // do meio com status "cancelled": sem veredito de CI. Medido: 17 commits em
  // julho/2026 nos repos consumidores. Esse bug já foi introduzido e
  // corrigido seis vezes em documentos diferentes deste trabalho — daí a
  // asserção mecânica. Workflow sem gatilho push (ex.: eval.yml, só
  // pull_request + workflow_dispatch) fica de fora: o github.ref de um PR já
  // é específico (refs/pull/<N>/merge), 2 segmentos bastam. Repo legitimamente
  // PR-only (comPush vazio) passa por vacuidade correta — ver o teste acima,
  // que prova hasPushTrigger por fixture em vez de depender da topologia
  // deste repo.
  it("workflow com push em branch usa github.sha no group de concurrency", () => {
    const comPush = workflows.filter((w) => hasPushTrigger(w.doc));
    for (const w of comPush) {
      expect(
        concurrencyGroup(w.doc),
        `${w.file} dispara em push mas o group de concurrency não contém github.sha — o group fica constante em push para main (github.ref não muda) e uma rajada de 3+ pushes descarta os runs do meio, que ficam "cancelled": sem veredito de CI. Medido: 17 commits em julho/2026 nos repos consumidores.`,
      ).toContain("github.sha");
    }
  });

  it("todo job declara timeout-minutes — o teto padrão do GitHub é 6h", () => {
    for (const w of workflows) {
      for (const [jobName, job] of Object.entries(w.doc.jobs ?? {})) {
        expect(
          job["timeout-minutes"],
          `${w.file} → job "${jobName}" não declara timeout-minutes`,
        ).toBeDefined();
      }
    }
  });

  // 973 min (49% da cota mensal) foram runners ociosos rodando manual-approval
  // à espera de um "approved" numa issue — ~1,4x o custo dos deploys que
  // guardavam (707 min). O gate humano agora é o ASK do tier-guard no IDE.
  it("nenhum workflow usa manual-approval — gate humano não mora em runner", () => {
    for (const w of workflows) {
      const usos = Object.values(w.doc.jobs ?? {})
        .flatMap((j) => j.steps ?? [])
        .map((s) => s.uses ?? "");
      for (const u of usos) {
        expect(u, `${w.file} usa ${u} — gate pago, ver spec 2026-07-30`).not.toMatch(
          /manual-approval/,
        );
      }
    }
  });
});
