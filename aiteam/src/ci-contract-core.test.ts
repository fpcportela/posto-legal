import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { evaluateCiContract, isAppManifest, readCiBlock, shellSegments } from "./ci-contract-core.mjs";
import type { CiEvaluation } from "./ci-contract-core.mjs";
import { extractFrontmatter } from "./frontmatter.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const crlf = (s: string) => s.replace(/\n/g, "\r\n");
const spec = (frontmatter: string) => `---\n${frontmatter}\n---\n\n# Spec\n`;

// O doctor carrega este núcleo em node puro, sem tsx e sem garantia de
// aiteam/node_modules — mesmo invariante de frontmatter.mjs e tier-core.mjs.
// Só pode importar módulo local, nunca pacote: o js-yaml não está garantido ali.
describe("ci-contract-core.mjs — carregável pelo doctor em node puro", () => {
  const src = readFileSync(path.join(HERE, "ci-contract-core.mjs"), "utf8");

  it("não tem shebang", () => {
    expect(src.startsWith("#!")).toBe(false);
  });

  it("só importa módulo local (./), nunca pacote", () => {
    const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    for (const spec of imports) expect(spec, spec).toMatch(/^\.\//);
  });
});

describe("readCiBlock — o bloco ci: do frontmatter do SPEC.md", () => {
  it("lê os comandos declarados; o que não foi declarado vem null e o workdir padrão é a raiz", () => {
    const r = readCiBlock(spec("budget_usd: 2.00\nci:\n  test: npm test\n  lint: npm run lint\nlast_updated: \"\""));
    expect(r).toEqual({
      state: "ok",
      ci: { workdir: "", test: "npm test", local_test: null, typecheck: null, lint: "npm run lint", reason: null },
    });
  });

  it("lê workdir, typecheck e o opt-out com reason", () => {
    const r = readCiBlock(
      spec('ci:\n  workdir: aiteam\n  test: none\n  typecheck: npm run typecheck\n  reason: "app só de conteúdo estático"'),
    );
    expect(r).toEqual({
      state: "ok",
      ci: {
        workdir: "aiteam",
        test: "none",
        local_test: null,
        typecheck: "npm run typecheck",
        lint: null,
        reason: "app só de conteúdo estático",
      },
    });
  });

  it("CRLF e LF dão o mesmo resultado", () => {
    const s = spec("ci:  # o que o CI de PR roda\n  test: npm test   # obrigatório\n\n  # comentário no meio\n  typecheck: 'npm run typecheck'");
    expect(readCiBlock(crlf(s))).toEqual(readCiBlock(s));
    expect(readCiBlock(s)).toMatchObject({ state: "ok", ci: { test: "npm test", typecheck: "npm run typecheck" } });
  });

  it("o bloco termina na próxima chave de coluna 0; comentário e linha em branco não o fecham", () => {
    const r = readCiBlock(spec("ci:\n  test: npm test\n# comentário na coluna 0\n\n  lint: npm run lint\nlint: isto é outra chave de topo"));
    expect(r).toMatchObject({ state: "ok", ci: { test: "npm test", lint: "npm run lint" } });
  });

  it("aspas: duplas com escape, simples com '' e # dentro de aspas não é comentário", () => {
    const r = readCiBlock(
      spec(`ci:\n  test: "pytest -k \\"not slow\\" # sem comentário"\n  lint: 'ruff check . && echo ''ok'''`),
    );
    expect(r).toMatchObject({
      state: "ok",
      ci: { test: 'pytest -k "not slow" # sem comentário', lint: "ruff check . && echo 'ok'" },
    });
  });

  it("normaliza o workdir: ./app/ vira app; . e vazio são a raiz", () => {
    expect(readCiBlock(spec("ci:\n  workdir: ./app/\n  test: npm test"))).toMatchObject({ ci: { workdir: "app" } });
    expect(readCiBlock(spec("ci:\n  workdir: .\n  test: npm test"))).toMatchObject({ ci: { workdir: "" } });
    expect(readCiBlock(spec('ci:\n  workdir: ""\n  test: npm test'))).toMatchObject({ ci: { workdir: "" } });
    expect(readCiBlock(spec("ci:\n  workdir: apps\\web\n  test: npm test"))).toMatchObject({ ci: { workdir: "apps/web" } });
  });

  it("ausente: sem frontmatter, sem a chave ci de topo, ou ci só aninhado em outro bloco", () => {
    expect(readCiBlock("# Spec sem frontmatter\n")).toEqual({ state: "absent" });
    expect(readCiBlock(spec("budget_usd: 2.00"))).toEqual({ state: "absent" });
    expect(readCiBlock(spec("infra_kb:\n  ci:\n    test: npm test"))).toEqual({ state: "absent" });
    expect(readCiBlock(spec("# ci:\n#   test: npm test"))).toEqual({ state: "absent" });
    expect(readCiBlock(null)).toEqual({ state: "absent" });
    expect(readCiBlock(undefined)).toEqual({ state: "absent" });
  });

  it("ci: sem nenhuma chave é um bloco declarado e vazio (o núcleo cobra o test), não ausência", () => {
    expect(readCiBlock(spec("ci:\nbudget_usd: 2.00"))).toEqual({
      state: "ok",
      ci: { workdir: "", test: null, local_test: null, typecheck: null, lint: null, reason: null },
    });
  });

  // O leitor é por linha (o doctor não tem parser YAML). O que ele não sabe ler
  // com certeza vira "malformed" com o motivo — nunca um palpite silencioso que
  // deixaria um typo desligar uma checagem.
  describe("malformado — com o motivo", () => {
    const cases: Array<[string, string, RegExp]> = [
      ["valor na mesma linha do ci:", "ci: { test: npm test }", /bloco/],
      ["chave desconhecida (typo)", "ci:\n  tests: npm test", /tests/],
      ["chave duplicada", "ci:\n  test: npm test\n  test: pytest", /duas vezes/],
      ["bloco ci: duplicado", "ci:\n  test: a\nci:\n  test: b", /duas vezes/],
      ["valor continuado na linha de baixo", "ci:\n  test: npm run\n    test", /linha só/],
      ["mapa aninhado", "ci:\n  test:\n    cmd: npm test", /linha só/],
      ["tab na indentação", "ci:\n\ttest: npm test", /tab/],
      ["chave sem espaço depois dos dois-pontos", "ci:\n  test:npm test", /chave: valor/],
      ["': ' num valor sem aspas", "ci:\n  test: echo a: b", /aspas/],
      ["bloco literal do YAML", "ci:\n  test: |\n    npm test", /aspas|linha só/],
      ["aspas sem fechamento", 'ci:\n  test: "npm test', /aspas/],
      ["booleano no lugar de comando", "ci:\n  test: true", /booleano/],
      ["workdir absoluto", "ci:\n  workdir: /srv/app\n  test: npm test", /relativo/],
      ["workdir que sai do repo", "ci:\n  workdir: ../outro\n  test: npm test", /\.\./],
      ["workdir com variável", "ci:\n  workdir: $APP_DIR\n  test: npm test", /variável/],
    ];
    for (const [label, fm, motivo] of cases) {
      it(label, () => {
        const r = readCiBlock(spec(fm));
        expect(r.state, JSON.stringify(r)).toBe("malformed");
        if (r.state === "malformed") expect(r.reason).toMatch(motivo);
      });
    }

    it("o motivo cita a linha do SPEC.md", () => {
      const r = readCiBlock(spec("budget_usd: 2.00\nci:\n  tests: npm test"));
      expect(r).toMatchObject({ state: "malformed", reason: expect.stringMatching(/SPEC\.md:4/) });
    });
  });

  // O leitor sem dependência e o js-yaml (que lê o mesmo frontmatter em
  // outros pontos do framework) não podem discordar no subconjunto aceito.
  it("concorda com o js-yaml em tudo que aceita", () => {
    const fixtures = [
      "ci:\n  test: npm test",
      "ci:\n  workdir: aiteam\n  test: npm run test\n  typecheck: npm run typecheck",
      "ci:  # comentário\n  test: pytest   # obrigatório\n\n  lint: ruff check app tests",
      `ci:\n  test: "pytest -k \\"not slow\\""\n  lint: 'echo ''x'''`,
      'ci:\n  test: none\n  reason: "site estático, sem código testável"',
      "budget_usd: 2.00\nci:\n    test: npm test\n    lint: npm run lint\ntier_defaults:\n  allow_tier3: false",
    ];
    for (const fm of fixtures) {
      const ours = readCiBlock(spec(fm));
      const theirs = (yaml.load(extractFrontmatter(spec(fm)) ?? "") as { ci: Record<string, string> }).ci;
      expect(ours.state, fm).toBe("ok");
      if (ours.state !== "ok") continue;
      for (const key of ["test", "typecheck", "lint", "reason"] as const) {
        expect(ours.ci[key], `${key} em ${JSON.stringify(fm)}`).toBe(theirs[key] ?? null);
      }
    }
  });
});

// ── O que um `run:` executa, e onde ─────────────────────────────────────────
// O contrato compara comando E diretório: o `npm run test` do framework e o da
// app são a mesma string no YAML, e só o diretório efetivo os separa.
describe("shellSegments — cada comando de um run:, com o diretório em que roda", () => {
  const seg = (dir: string | null, ...argv: string[]) => ({ dir, argv });

  it("cd muda o diretório dos comandos seguintes; subshell não vaza", () => {
    expect(shellSegments("cd aiteam && npm run test", "")).toEqual([seg("aiteam", "npm", "run", "test")]);
    expect(shellSegments("(cd aiteam && npm run lint); npm run lint", "")).toEqual([
      seg("aiteam", "npm", "run", "lint"),
      seg("", "npm", "run", "lint"),
    ]);
    expect(shellSegments("cd .. && npm test", "aiteam")).toEqual([seg("", "npm", "run", "test")]);
  });

  it("npm --prefix roda o comando no diretório indicado, sem mudar o dos seguintes", () => {
    expect(shellSegments("npm --prefix aiteam ci && npm --prefix=app run lint && npm test", "")).toEqual([
      seg("aiteam", "npm", "ci"),
      seg("app", "npm", "run", "lint"),
      seg("", "npm", "run", "test"),
    ]);
    expect(shellSegments("npm run test --prefix aiteam", "")).toEqual([seg("aiteam", "npm", "run", "test")]);
  });

  it("os apelidos do npm para rodar script viram `npm run <script>`; depois de `--` nada é do npm", () => {
    for (const cmd of ["npm test", "npm t", "npm tst", "npm run test", "npm run-script test", "npm rum test"]) {
      expect(shellSegments(cmd, ""), cmd).toEqual([seg("", "npm", "run", "test")]);
    }
    expect(shellSegments("npm run test -- --prefix x", "")).toEqual([
      seg("", "npm", "run", "test", "--", "--prefix", "x"),
    ]);
  });

  it("ignora atribuição de ambiente, palavra-chave do shell, redirecionamento e comentário", () => {
    expect(shellSegments("CI=true FOO=bar npm test > out.log 2>&1 | tee log.txt # fim", "")).toEqual([
      seg("", "npm", "run", "test"),
      seg("", "tee", "log.txt"),
    ]);
    expect(shellSegments("if npm test; then\n  echo ok\nfi", "")).toEqual([
      seg("", "npm", "run", "test"),
      seg("", "echo", "ok"),
    ]);
    expect(shellSegments("# npm test só no comentário\nnpm run lint", "")).toEqual([seg("", "npm", "run", "lint")]);
  });

  it("não quebra dentro de aspas, nem em string de várias linhas; junta continuação de linha", () => {
    expect(shellSegments('echo "npm test && npm run lint"', "")).toEqual([seg("", "echo", "npm test && npm run lint")]);
    expect(shellSegments("node -e \"\n  console.log('a && b')\n\"\nnpm run \\\n  build", "")).toEqual([
      seg("", "node", "-e", "\n  console.log('a && b')\n"),
      seg("", "npm", "run", "build"),
    ]);
    expect(shellSegments("pytest -k 'not slow'", "")).toEqual(shellSegments('pytest -k "not slow"', ""));
  });

  it("github.workspace é a raiz; destino que não dá para resolver vira diretório desconhecido (null)", () => {
    expect(shellSegments("cd ${{ github.workspace }}/app && pytest", "aiteam")).toEqual([seg("app", "pytest")]);
    expect(shellSegments("cd $GITHUB_WORKSPACE && pytest", "aiteam")).toEqual([seg("", "pytest")]);
    expect(shellSegments("cd $APP_DIR && pytest", "")).toEqual([seg(null, "pytest")]);
    expect(shellSegments("cd .. && pytest", "")).toEqual([seg(null, "pytest")]);
  });
});

// Revisão de segurança da #31: pushd, `npm -C` (o atalho oficial de --prefix)
// e `npm -w aiteam` levavam o comando para dentro do framework sem o núcleo
// ver — o diretório ficava o de fora, e a delegação passava.
describe("shellSegments — pushd/popd, npm -C e npm -w", () => {
  const seg = (dir: string | null, ...argv: string[]) => ({ dir, argv });

  it("pushd e popd funcionam como cd, com pilha", () => {
    expect(shellSegments("pushd aiteam && npm test && popd && npm run lint", "")).toEqual([
      seg("aiteam", "npm", "run", "test"),
      seg("", "npm", "run", "lint"),
    ]);
    expect(shellSegments("pushd aiteam\npushd src\nnpm test\npopd\nnpm run lint\npopd\nnpm run build", "")).toEqual([
      seg("aiteam/src", "npm", "run", "test"),
      seg("aiteam", "npm", "run", "lint"),
      seg("", "npm", "run", "build"),
    ]);
    expect(shellSegments("popd && npm test", "")).toEqual([seg(null, "npm", "run", "test")]);
  });

  it("cd -- <dir> é cd <dir>", () => {
    expect(shellSegments("cd -- aiteam && npm test", "")).toEqual([seg("aiteam", "npm", "run", "test")]);
  });

  it("npm -C <dir> é npm --prefix <dir>", () => {
    expect(shellSegments("npm -C aiteam test", "")).toEqual([seg("aiteam", "npm", "run", "test")]);
    expect(shellSegments("npm run lint -C ./aiteam", "")).toEqual([seg("aiteam", "npm", "run", "lint")]);
  });

  it("-w/--workspace que resolve dentro de aiteam/ vira o diretório; outro workspace fica como está", () => {
    expect(shellSegments("npm -w aiteam run test", "")).toEqual([seg("aiteam", "npm", "run", "test")]);
    expect(shellSegments("npm run test --workspace=aiteam", "")).toEqual([seg("aiteam", "npm", "run", "test")]);
    expect(shellSegments("npm --workspace ./aiteam test", "")).toEqual([seg("aiteam", "npm", "run", "test")]);
    expect(shellSegments("npm -w @mesa/shared run build", "")).toEqual([seg("", "npm", "-w", "@mesa/shared", "run", "build")]);
  });
});

describe("evaluateCiContract — pushd, npm -C e npm -w na delegação e no passo", () => {
  const passoNaRaiz = wf("ci.yml", "on: pull_request\njobs:\n  app:\n    steps:\n      - run: npm test\n");
  for (const corpo of ["npm -C aiteam test", "npm -w aiteam run test", "npm run test --workspace=aiteam", "pushd aiteam && npm test"]) {
    it(`script test com corpo \`${corpo}\` só delega para o aiteam/`, () => {
      const r = evaluateCiContract({
        specText: spec("ci:\n  test: npm test"),
        workflows: [passoNaRaiz],
        readScripts: (dir: string) => (dir === "" ? { test: corpo } : null),
      });
      expect(fails(r).map((f) => f.key)).toEqual(["test"]);
      expect(failText(r)).toMatch(/delega/);
    });
  }

  it("um passo `pushd aiteam && npm run test` roda no framework, não na raiz", () => {
    const w = wf("ci.yml", "on: pull_request\njobs:\n  app:\n    steps:\n      - run: pushd aiteam && npm run test\n");
    const r = evaluateCiContract({ specText: spec("ci:\n  test: npm run test"), workflows: [w], readScripts: noScripts });
    expect(failText(r)).toMatch(/o mesmo comando roda em aiteam\//);
  });
});

// ── O contrato: cada comando declarado roda num PR, no workdir declarado ─────
type Wf = { file: string; doc: unknown };
const wf = (file: string, text: string): Wf => ({ file, doc: yaml.load(text) });
const fails = (r: CiEvaluation) => r.findings.filter((f) => f.level === "fail");
const warns = (r: CiEvaluation) => r.findings.filter((f) => f.level === "warn");
const failText = (r: CiEvaluation) => fails(r).map((f) => f.message).join("\n");
const noScripts = () => null;
const scriptsAt =
  (byDir: Record<string, Record<string, string>>) =>
  (dir: string): Record<string, string> | null =>
    byDir[dir] ?? null;

// O ci.yml de um consumidor que copiou o do framework (o furo da #31): tudo
// roda em aiteam/ por causa do defaults no nível do workflow.
const CI_COPIADO_DO_FRAMEWORK = `
on:
  push:
    branches: [main]
  pull_request:
defaults:
  run:
    working-directory: aiteam
jobs:
  validate:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - run: npm ci
      - run: npm run typecheck
      - run: npm run test
`;

// A forma corrigida (trabalhista depois da #31): working-directory por job, e
// um job da app na raiz.
const CI_DOIS_JOBS = `
on:
  push:
    branches: [main]
  pull_request:
jobs:
  framework:
    timeout-minutes: 10
    defaults:
      run:
        working-directory: aiteam
    steps:
      - run: npm ci
      - run: npm run typecheck
      - run: npm run test
  app:
    timeout-minutes: 20
    steps:
      - run: npm ci
      - name: Lint
        run: npm run lint
      - name: Type check
        run: npm run typecheck
      - name: Run tests
        run: npm run test
`;

const CI_DECLARADO = "ci:\n  test: npm run test\n  typecheck: npm run typecheck\n  lint: npm run lint";

describe("evaluateCiContract — o bloco ci: em si", () => {
  it("SPEC.md sem bloco ci: falha dizendo o que declarar, o opt-out e onde ler o mandato", () => {
    const r = evaluateCiContract({ specText: spec("budget_usd: 2.00"), workflows: [], readScripts: noScripts });
    expect(fails(r)).toHaveLength(1);
    expect(fails(r)[0]).toMatchObject({ key: "ci" });
    const msg = failText(r);
    expect(msg).toMatch(/ci:/);
    expect(msg).toMatch(/test/);
    expect(msg).toMatch(/test: none/);
    expect(msg).toMatch(/reason/);
    expect(msg).toMatch(/AGENTS\.md/);
  });

  it("SPEC.md ausente falha", () => {
    const r = evaluateCiContract({ specText: null, workflows: [], readScripts: noScripts });
    expect(fails(r)).toEqual([expect.objectContaining({ key: "spec", message: expect.stringMatching(/SPEC\.md/) })]);
  });

  it("bloco ilegível falha com o motivo do leitor", () => {
    const r = evaluateCiContract({ specText: spec("ci:\n  tests: npm test"), workflows: [], readScripts: noScripts });
    expect(failText(r)).toMatch(/ci\.tests/);
  });

  it("ci: sem test falha: test é obrigatório", () => {
    const r = evaluateCiContract({ specText: spec("ci:\n  lint: npm run lint"), workflows: [], readScripts: noScripts });
    expect(fails(r).map((f) => f.key)).toContain("test");
    expect(failText(r)).toMatch(/obrigatório/);
  });

  it("opt-out test: none com reason passa, e o motivo fica visível como aviso", () => {
    const r = evaluateCiContract({
      specText: spec('ci:\n  test: none\n  reason: "site estático, sem código testável"'),
      workflows: [],
      readScripts: noScripts,
    });
    expect(fails(r)).toEqual([]);
    expect(warns(r)).toEqual([
      expect.objectContaining({ key: "test", message: expect.stringMatching(/site estático, sem código testável/) }),
    ]);
  });

  it("opt-out sem reason falha", () => {
    const r = evaluateCiContract({ specText: spec("ci:\n  test: none"), workflows: [], readScripts: noScripts });
    expect(fails(r)).toEqual([expect.objectContaining({ key: "test", message: expect.stringMatching(/reason/) })]);
  });

  it("lint: none e typecheck: none não são opt-out: a chave é que se omite", () => {
    const r = evaluateCiContract({
      specText: spec("ci:\n  test: none\n  reason: x\n  lint: none"),
      workflows: [],
      readScripts: noScripts,
    });
    expect(fails(r)).toEqual([expect.objectContaining({ key: "lint", message: expect.stringMatching(/omita/) })]);
  });
});

describe("evaluateCiContract — o comando declarado roda num PR, no workdir declarado", () => {
  it("o ci.yml copiado do framework NÃO cumpre o test da app — e a mensagem aponta aiteam/ e o template", () => {
    const r = evaluateCiContract({
      specText: spec("ci:\n  test: npm run test"),
      workflows: [wf("ci.yml", CI_COPIADO_DO_FRAMEWORK)],
      readScripts: noScripts,
    });
    expect(fails(r).map((f) => f.key)).toEqual(["test"]);
    const msg = failText(r);
    expect(msg).toMatch(/npm run test/);
    expect(msg).toMatch(/aiteam\//);
    expect(msg).toMatch(/ci\.yml › validate/);
    expect(msg).toMatch(/ci\.yml\.example/);
  });

  it("o ci.yml de dois jobs cumpre test, typecheck e lint no job da app", () => {
    const r = evaluateCiContract({
      specText: spec(CI_DECLARADO),
      workflows: [wf("ci.yml", CI_DOIS_JOBS)],
      readScripts: noScripts,
    });
    expect(r.findings).toEqual([]);
    for (const key of ["test", "typecheck", "lint"]) {
      const l = r.located.find((x) => x.key === key);
      expect(l?.where.map((w) => `${w.file} › ${w.job}`), key).toEqual(["ci.yml › app"]);
    }
  });

  it("o framework, que declara workdir: aiteam, cumpre com o ci.yml de defaults no workflow", () => {
    const r = evaluateCiContract({
      specText: spec("ci:\n  workdir: aiteam\n  test: npm run test\n  typecheck: npm run typecheck"),
      workflows: [wf("ci.yml", CI_COPIADO_DO_FRAMEWORK)],
      readScripts: scriptsAt({ aiteam: { test: "vitest run", typecheck: "tsc --noEmit" } }),
    });
    expect(r.findings).toEqual([]);
  });

  it("lint e typecheck só são exigidos quando declarados", () => {
    const soTeste = "on: pull_request\njobs:\n  app:\n    steps:\n      - run: pytest\n";
    const r = evaluateCiContract({ specText: spec("ci:\n  test: pytest"), workflows: [wf("ci.yml", soTeste)], readScripts: noScripts });
    expect(r.findings).toEqual([]);
    const r2 = evaluateCiContract({
      specText: spec("ci:\n  test: pytest\n  lint: ruff check ."),
      workflows: [wf("ci.yml", soTeste)],
      readScripts: noScripts,
    });
    expect(fails(r2).map((f) => f.key)).toEqual(["lint"]);
  });

  it("working-directory do passo vale sobre o do job, que vale sobre o do workflow", () => {
    const w = wf(
      "ci.yml",
      [
        "on: [push, pull_request]",
        "defaults:",
        "  run:",
        "    working-directory: aiteam",
        "jobs:",
        "  a:",
        "    defaults:",
        "      run:",
        "        working-directory: apps/web",
        "    steps:",
        "      - run: npm run lint",
        "      - run: npm test",
        "        working-directory: .",
      ].join("\n"),
    );
    const at = (workdir: string, cmd: string) =>
      fails(evaluateCiContract({ specText: spec(`ci:\n  workdir: ${workdir}\n  test: ${cmd}`), workflows: [w], readScripts: noScripts }));
    expect(at(".", "npm test")).toEqual([]);
    expect(at("apps/web", "npm run lint")).toEqual([]);
    expect(at("aiteam", "npm run lint")).not.toEqual([]);
  });

  it("cd e npm --prefix no próprio run: contam para o diretório", () => {
    const w = wf(
      "ci.yml",
      "on:\n  pull_request:\njobs:\n  a:\n    steps:\n      - run: cd app && npm test\n      - run: npm --prefix aiteam test\n",
    );
    const at = (workdir: string) =>
      fails(evaluateCiContract({ specText: spec(`ci:\n  workdir: ${workdir}\n  test: npm test`), workflows: [w], readScripts: noScripts }));
    expect(at("app")).toEqual([]);
    expect(at("aiteam")).toEqual([]);
    expect(at(".")).not.toEqual([]);
  });

  it("os apelidos do npm se equivalem entre o declarado e o passo", () => {
    const w = wf("ci.yml", "on: pull_request\njobs:\n  a:\n    steps:\n      - run: npm t\n");
    expect(fails(evaluateCiContract({ specText: spec("ci:\n  test: npm run test"), workflows: [w], readScripts: noScripts }))).toEqual([]);
  });

  it("workflow que não dispara em pull_request não conta — e a mensagem diz por quê", () => {
    const w = wf("ci.yml", "on:\n  push:\n    branches: [main]\njobs:\n  a:\n    steps:\n      - run: npm test\n");
    const r = evaluateCiContract({ specText: spec("ci:\n  test: npm test"), workflows: [w], readScripts: noScripts });
    expect(failText(r)).toMatch(/pull_request/);
    expect(failText(r)).toMatch(/ci\.yml › a/);
  });

  it("on: em escalar ou lista com pull_request conta; pull_request só de types: [closed] não", () => {
    const job = "jobs:\n  a:\n    steps:\n      - run: npm test\n";
    const ok = (on: string) =>
      fails(evaluateCiContract({ specText: spec("ci:\n  test: npm test"), workflows: [wf("x.yml", `${on}\n${job}`)], readScripts: noScripts }));
    expect(ok("on: pull_request")).toEqual([]);
    expect(ok("on: [push, pull_request]")).toEqual([]);
    expect(ok("on:\n  pull_request:\n    types: [opened, synchronize]")).toEqual([]);
    expect(ok("on:\n  pull_request:\n    types: [closed]")).not.toEqual([]);
    expect(ok("on: pull_request_target")).not.toEqual([]);
  });

  // Decisão do PO na revisão da #31: um `paths:` positivo deixa sem check
  // todo PR que não toca aqueles caminhos — e o mandato diz "todo PR". O
  // paths-ignore recorta o contrário (PR que só mexe no ignorado) e fica
  // como ressalva. Vale igual atravessando um reutilizável local.
  describe("filtro de paths no workflow do acerto", () => {
    const passo = "jobs:\n  a:\n    steps:\n      - run: npm test\n";
    const avalia = (on: string) =>
      evaluateCiContract({ specText: spec("ci:\n  test: npm test"), workflows: [wf("ci.yml", `${on}\n${passo}`)], readScripts: noScripts });
    const viaReutilizavel = (on: string) =>
      evaluateCiContract({
        specText: spec("ci:\n  test: npm test"),
        workflows: [
          wf("ci.yml", `${on}\njobs:\n  app:\n    uses: ./.github/workflows/checks.yml\n`),
          wf("checks.yml", `on: workflow_call\n${passo}`),
        ],
        readScripts: noScripts,
      });

    for (const [label, run] of [["direto", avalia], ["via reutilizável local", viaReutilizavel]] as const) {
      it(`${label}: paths positivo reprova — o PR que não toca esses caminhos fica sem check`, () => {
        const r = run("on:\n  pull_request:\n    paths: ['src/**']");
        expect(fails(r).map((f) => f.key)).toEqual(["test"]);
        expect(failText(r)).toMatch(/paths: \[src\/\*\*\]/);
        expect(failText(r)).toMatch(/sem check/);
        expect(failText(r)).toMatch(/paths-ignore/);
      });

      it(`${label}: paths-ignore passa com ressalva, citando o filtro`, () => {
        const r = run("on:\n  pull_request:\n    paths-ignore: ['**.md']");
        expect(fails(r)).toEqual([]);
        expect(warns(r)).toEqual([expect.objectContaining({ key: "test", message: expect.stringMatching(/paths-ignore: \[\*\*\.md\]/) })]);
      });

      it(`${label}: sem filtro passa limpo`, () => {
        expect(run("on:\n  pull_request:").findings).toEqual([]);
      });
    }
  });

  it("um passo com continue-on-error passa, mas avisa: a falha não bloqueia o PR", () => {
    const w = wf("ci.yml", "on: pull_request\njobs:\n  a:\n    steps:\n      - run: npm test\n        continue-on-error: true\n");
    const r = evaluateCiContract({ specText: spec("ci:\n  test: npm test"), workflows: [w], readScripts: noScripts });
    expect(fails(r)).toEqual([]);
    expect(warns(r)).toEqual([expect.objectContaining({ key: "test", message: expect.stringMatching(/continue-on-error/) })]);
  });

  it("um passo limpo em qualquer workflow basta, mesmo com outro passo filtrado", () => {
    const filtrado = wf("eval.yml", "on:\n  pull_request:\n    paths: ['x/**']\njobs:\n  a:\n    steps:\n      - run: npm test\n");
    const limpo = wf("ci.yml", "on: pull_request\njobs:\n  b:\n    steps:\n      - run: npm test\n");
    const r = evaluateCiContract({ specText: spec("ci:\n  test: npm test"), workflows: [filtrado, limpo], readScripts: noScripts });
    expect(r.findings).toEqual([]);
  });

  it("segue workflow reutilizável local, com inputs do with: e o default do workflow_call", () => {
    const reutilizavel = wf(
      "app-checks.yml",
      [
        "on:",
        "  workflow_call:",
        "    inputs:",
        "      dir:",
        "        type: string",
        '        default: "."',
        "      cmd:",
        "        type: string",
        "        default: npm test",
        "jobs:",
        "  check:",
        "    defaults:",
        "      run:",
        "        working-directory: ${{ inputs.dir }}",
        "    steps:",
        "      - run: ${{ inputs.cmd }}",
      ].join("\n"),
    );
    const chamador = (withBlock: string) =>
      wf("ci.yml", `on: pull_request\njobs:\n  app:\n    uses: ./.github/workflows/app-checks.yml\n${withBlock}`);
    const declarado = (workdir: string, cmd: string) => spec(`ci:\n  workdir: ${workdir}\n  test: ${cmd}`);

    const viaWith = evaluateCiContract({
      specText: declarado("apps/api", "pytest -q"),
      workflows: [chamador("    with:\n      dir: apps/api\n      cmd: pytest -q\n"), reutilizavel],
      readScripts: noScripts,
    });
    expect(viaWith.findings).toEqual([]);
    expect(viaWith.located[0]?.where[0]).toMatchObject({ file: "app-checks.yml", job: "check", via: ["ci.yml › app"] });

    const viaDefault = evaluateCiContract({ specText: declarado(".", "npm test"), workflows: [chamador(""), reutilizavel], readScripts: noScripts });
    expect(viaDefault.findings).toEqual([]);
  });

  it("o reutilizável sozinho (só workflow_call) não conta, e reutilizável remoto é ignorado sem erro", () => {
    const reutilizavel = wf("app-checks.yml", "on: workflow_call\njobs:\n  c:\n    steps:\n      - run: npm test\n");
    const remoto = wf("ci.yml", "on: pull_request\njobs:\n  a:\n    uses: org/repo/.github/workflows/x.yml@v1\n");
    const r = evaluateCiContract({ specText: spec("ci:\n  test: npm test"), workflows: [reutilizavel, remoto], readScripts: noScripts });
    expect(fails(r).map((f) => f.key)).toEqual(["test"]);
  });

  it("comando em comentário ou dentro de string de outro comando não conta", () => {
    const w = wf(
      "ci.yml",
      'on: pull_request\njobs:\n  a:\n    steps:\n      - run: |\n          # npm test\n          echo "npm test"\n',
    );
    const r = evaluateCiContract({ specText: spec("ci:\n  test: npm test"), workflows: [w], readScripts: noScripts });
    expect(fails(r).map((f) => f.key)).toEqual(["test"]);
  });
});

// O caso do vigacapital: o `npm test` da raiz existe e roda em PR, mas o
// script delega para o framework vendorizado — a suíte da app não roda.
describe("evaluateCiContract — recusa comando que só delega para o aiteam/", () => {
  const raiz = wf("ci.yml", "on: pull_request\njobs:\n  app:\n    steps:\n      - run: npm test\n");
  const declara = (cmd: string) => spec(`ci:\n  test: ${cmd}`);

  it("script cujo corpo é npm --prefix aiteam …", () => {
    const r = evaluateCiContract({
      specText: declara("npm test"),
      workflows: [raiz],
      readScripts: scriptsAt({ "": { test: "npm --prefix aiteam run test" }, aiteam: { test: "vitest run" } }),
    });
    expect(fails(r).map((f) => f.key)).toEqual(["test"]);
    expect(failText(r)).toMatch(/delega/);
    expect(failText(r)).toMatch(/npm --prefix aiteam run test/);
    // A cadeia para no salto que entra em aiteam/: dali para dentro é o
    // framework, e o script dele só poluiria a mensagem.
    expect(failText(r)).not.toMatch(/aiteam\/package\.json|vitest run/);
  });

  it("script cujo corpo é cd aiteam && …", () => {
    const r = evaluateCiContract({
      specText: declara("npm test"),
      workflows: [raiz],
      readScripts: scriptsAt({ "": { test: "cd aiteam && vitest run" } }),
    });
    expect(failText(r)).toMatch(/delega/);
  });

  it("segue a cadeia de scripts npm run", () => {
    const r = evaluateCiContract({
      specText: declara("npm test"),
      workflows: [raiz],
      readScripts: scriptsAt({ "": { test: "npm run test:all", "test:all": "npm --prefix aiteam test" } }),
    });
    expect(failText(r)).toMatch(/delega/);
  });

  it("o próprio comando declarado rodando em aiteam/", () => {
    const w = wf("ci.yml", "on: pull_request\njobs:\n  app:\n    steps:\n      - run: npm --prefix aiteam test\n");
    const r = evaluateCiContract({ specText: declara("npm --prefix aiteam test"), workflows: [w], readScripts: noScripts });
    expect(fails(r).map((f) => f.key)).toEqual(["test"]);
    expect(failText(r)).toMatch(/aiteam\//);
  });

  it("script que roda a app E o framework não é delegação", () => {
    const r = evaluateCiContract({
      specText: declara("npm test"),
      workflows: [raiz],
      readScripts: scriptsAt({ "": { test: "vitest run && npm --prefix aiteam test" } }),
    });
    expect(r.findings).toEqual([]);
  });

  it("no próprio framework (workdir: aiteam) rodar em aiteam/ não é delegação", () => {
    const r = evaluateCiContract({
      specText: spec("ci:\n  workdir: aiteam\n  test: npm run test"),
      workflows: [wf("ci.yml", CI_COPIADO_DO_FRAMEWORK)],
      readScripts: scriptsAt({ aiteam: { test: "vitest run" } }),
    });
    expect(r.findings).toEqual([]);
  });
});

// Revisão de segurança da #31: o passo existir não basta, a falha dele tem de
// chegar ao status do passo. Um `|| true` (ou pipe sem pipefail, `&`, `!`,
// `set +e` com comando depois) deixa a suíte vermelha com o check verde. O
// acerto passa a contar com ressalva (WARN), pelo mesmo caminho do filtro de
// paths e do continue-on-error.
describe("evaluateCiContract — falha engolida pelo shell conta com ressalva", () => {
  const passo = (run: string, shell?: { step?: string; job?: string; workflow?: string }) =>
    wf(
      "ci.yml",
      [
        "on: pull_request",
        ...(shell?.workflow ? ["defaults:", "  run:", `    shell: ${shell.workflow}`] : []),
        "jobs:",
        "  app:",
        ...(shell?.job ? ["    defaults:", "      run:", `        shell: ${shell.job}`] : []),
        "    steps:",
        `      - run: ${JSON.stringify(run)}`,
        ...(shell?.step ? [`        shell: ${shell.step}`] : []),
      ].join("\n"),
    );
  const avalia = (w: Wf) =>
    evaluateCiContract({ specText: spec("ci:\n  test: npm run test"), workflows: [w], readScripts: noScripts });

  const engolidos: Array<[string, RegExp]> = [
    ["npm run test || true", /\|\| true/],
    ["npm run test || :", /\|\| :/],
    ["npm run test || echo falhou", /\|\| echo/],
    ["npm run test || exit 0", /\|\| exit 0/],
    ["(npm run test) || true", /\|\| true/],
    ["npm run test | tee out.log", /pipefail/],
    ["npm run test &", /segundo plano/],
    ["! npm run test", /negado/],
    ["set +e\nnpm run test\nexit 0", /set \+e/],
    ["npm run test && echo ok\necho fim", /&&/],
  ];
  for (const [run, motivo] of engolidos) {
    it(`${JSON.stringify(run)} passa com ressalva, dizendo por quê`, () => {
      const r = avalia(passo(run));
      expect(fails(r)).toEqual([]);
      expect(warns(r)).toEqual([expect.objectContaining({ key: "test", message: expect.stringMatching(motivo) })]);
    });
  }

  const propagam = [
    "npm run test || exit 1",
    "npm run test || exit",
    "npm run test || false",
    'npm run test || { echo "falhou"; exit 1; }',
    "set -o pipefail\nnpm run test | tee out.log",
    "set -eo pipefail\nnpm run test | tee out.log",
    "set +e\nnpm run test",
    "set +e\nset -e\nnpm run test\necho fim",
    "npm ci && npm run test\necho fim",
    "cat versao.txt | npm run test",
  ];
  for (const run of propagam) {
    it(`${JSON.stringify(run)} propaga a falha: passa limpo`, () => {
      expect(avalia(passo(run)).findings).toEqual([]);
    });
  }

  // Re-verificação da #31: numa lista and-or, a falha só chega ao status da
  // lista se nenhum `||` posterior no mesmo nível a capturar. Depois de `&&`
  // vale o próximo `||` da lista, e o que decide é o ÚLTIMO operando
  // executado da cadeia, não qualquer um.
  const listaAndOr: Array<[string, RegExp]> = [
    ["npm run test && echo ok || echo falhou", /\|\| echo falhou/],
    ["npm run test && echo ok || true", /\|\| true/],
    ["npm run test || false || true", /\|\| true/],
    ["npm run test || echo falhou && true", /\|\| echo falhou/],
    ["npm run test && npm run lint || true", /\|\| true/],
    // O exit 1 nunca roda: o true sucede e o segundo || é pulado.
    ["npm run test || true || exit 1", /\|\| true/],
  ];
  for (const [run, motivo] of listaAndOr) {
    it(`${JSON.stringify(run)}: o || posterior captura a falha — passa com ressalva`, () => {
      const r = avalia(passo(run));
      expect(fails(r)).toEqual([]);
      expect(warns(r)).toEqual([expect.objectContaining({ key: "test", message: expect.stringMatching(motivo) })]);
    });
  }

  for (const run of [
    "npm run test && echo ok || exit 1",
    "npm run test || false",
    "npm run test || (echo falhou; exit 1)",
    "npm run test && echo ok || { echo falhou; exit 1; }",
  ]) {
    it(`${JSON.stringify(run)}: o último operando executado leva a falha adiante — passa limpo`, () => {
      expect(avalia(passo(run)).findings).toEqual([]);
    });
  }

  // Uma linha só de atribuição depois do comando roda, sucede e vira o status
  // do passo: `st=$?` depois de set +e engole a falha do mesmo jeito.
  for (const run of ["npm run test && echo ok\nRESULT=done", "set +e\nnpm run test\nst=$?"]) {
    it(`${JSON.stringify(run)}: a atribuição depois conta como comando — passa com ressalva`, () => {
      const r = avalia(passo(run));
      expect(fails(r)).toEqual([]);
      expect(warns(r)).toHaveLength(1);
    });
  }

  // Re-verificação da #32: o comando na condição de um if/elif/while/until não
  // para o passo com bash -e — a falha só escolhe o desvio. `if npm test;
  // then …; fi` era dado como PROPAGA, um verde falso no contrato de CI.
  const naCondicao = [
    "if npm run test; then echo ok; fi",
    "if npm run test; then echo ok; else echo falhou; fi",
    "if true; then echo a; elif npm run test; then echo b; fi",
    "while npm run test; do sleep 1; done",
    "until npm run test; do sleep 1; done",
    "if npm ci && npm run test; then echo ok; fi",
  ];
  for (const run of naCondicao) {
    it(`${JSON.stringify(run)}: o comando na condição não para o passo — passa com ressalva`, () => {
      const r = avalia(passo(run));
      expect(fails(r)).toEqual([]);
      expect(warns(r)).toEqual([expect.objectContaining({ key: "test", message: expect.stringMatching(/condição/) })]);
    });
  }

  it("no corpo do then ou do do, o comando continua propagando", () => {
    for (const run of ["if true; then npm run test; fi", "if [ -f x ]; then echo a; else npm run test; fi", "for i in 1; do npm run test; done"]) {
      expect(avalia(passo(run)).findings, run).toEqual([]);
    }
  });

  it("shell: bash (no passo, no job ou no workflow) liga o pipefail", () => {
    for (const where of ["step", "job", "workflow"] as const) {
      expect(avalia(passo("npm run test | tee out.log", { [where]: "bash" })).findings, where).toEqual([]);
    }
    expect(warns(avalia(passo("npm run test | tee out.log", { step: "sh" })))).toHaveLength(1);
  });

  it("um passo limpo noutro lugar basta, mesmo com o mesmo comando engolido em outro passo", () => {
    const w = wf("ci.yml", "on: pull_request\njobs:\n  app:\n    steps:\n      - run: npm run test || true\n      - run: npm run test\n");
    expect(avalia(w).findings).toEqual([]);
  });

  it("o shellSegments continua devolvendo só {dir, argv}", () => {
    expect(shellSegments("npm run test || true", "")).toEqual([
      { dir: "", argv: ["npm", "run", "test"] },
      { dir: "", argv: ["true"] },
    ]);
  });
});

// Revisão de segurança da #31: o `if:` era ignorado. `if: false` num passo,
// num job ou no job que chama o reutilizável faz o comando nunca rodar — e um
// job pulado reporta Success no GitHub, então a falta não aparece. Qualquer
// outra condição (fora always(), success() e !cancelled()) deixa PRs sem o
// check, e vira ressalva citando a condição. Os dois atravessam `needs`.
describe("evaluateCiContract — if: em passo, job e cadeia de needs", () => {
  const avalia = (text: string, extra: Wf[] = []) =>
    evaluateCiContract({ specText: spec("ci:\n  test: npm run test"), workflows: [wf("ci.yml", text), ...extra], readScripts: noScripts });

  const nunca: Array<[string, string]> = [
    ["passo if: false", "on: pull_request\njobs:\n  app:\n    steps:\n      - if: false\n        run: npm run test\n"],
    ["passo if: ${{ false }}", "on: pull_request\njobs:\n  app:\n    steps:\n      - if: ${{ false }}\n        run: npm run test\n"],
    ["passo if: 'false'", "on: pull_request\njobs:\n  app:\n    steps:\n      - if: 'false'\n        run: npm run test\n"],
    ["job if: false", "on: pull_request\njobs:\n  app:\n    if: false\n    steps:\n      - run: npm run test\n"],
    ["job if: ${{ false }}", "on: pull_request\njobs:\n  app:\n    if: ${{ false }}\n    steps:\n      - run: npm run test\n"],
    [
      "needs de um job com if: false",
      "on: pull_request\njobs:\n  gate:\n    if: false\n    steps:\n      - run: echo\n  app:\n    needs: gate\n    steps:\n      - run: npm run test\n",
    ],
    [
      "needs em cadeia (lista)",
      "on: pull_request\njobs:\n  a:\n    if: ${{ false }}\n    steps:\n      - run: echo\n  b:\n    needs: [a]\n    steps:\n      - run: echo\n  app:\n    needs: [b]\n    steps:\n      - run: npm run test\n",
    ],
  ];
  for (const [label, text] of nunca) {
    it(`${label}: o comando nunca roda — reprova, e a mensagem diz por quê`, () => {
      const r = avalia(text);
      expect(fails(r).map((f) => f.key)).toEqual(["test"]);
      expect(failText(r)).toMatch(/if: false/);
    });
  }

  it("job chamador de reutilizável com if: false: o reutilizável nunca roda", () => {
    const reutilizavel = wf("checks.yml", "on: workflow_call\njobs:\n  t:\n    steps:\n      - run: npm run test\n");
    const r = avalia("on: pull_request\njobs:\n  app:\n    if: false\n    uses: ./.github/workflows/checks.yml\n", [reutilizavel]);
    expect(fails(r).map((f) => f.key)).toEqual(["test"]);
    expect(failText(r)).toMatch(/if: false/);
  });

  it("um needs pulado não pesa sobre o job com if: always() ou !cancelled()", () => {
    for (const cond of ["always()", "${{ !cancelled() }}"]) {
      const r = avalia(`on: pull_request\njobs:\n  gate:\n    if: false\n    steps:\n      - run: echo\n  app:\n    needs: gate\n    if: ${cond}\n    steps:\n      - run: npm run test\n`);
      expect(r.findings, cond).toEqual([]);
    }
  });

  it("always(), success(), !cancelled() e true não são condição: passa limpo", () => {
    for (const cond of ["always()", "success()", "${{ success() }}", "${{ !cancelled() }}", "true"]) {
      expect(avalia(`on: pull_request\njobs:\n  app:\n    steps:\n      - if: ${cond}\n        run: npm run test\n`).findings, cond).toEqual([]);
    }
  });

  const condicionais: Array<[string, string, RegExp]> = [
    [
      "passo",
      "on: pull_request\njobs:\n  app:\n    steps:\n      - if: github.event_name == 'push'\n        run: npm run test\n",
      /github\.event_name == 'push'/,
    ],
    [
      "job",
      "on: pull_request\njobs:\n  app:\n    if: github.actor != 'dependabot[bot]'\n    steps:\n      - run: npm run test\n",
      /github\.actor != 'dependabot\[bot\]'/,
    ],
    [
      "job do needs",
      "on: pull_request\njobs:\n  gate:\n    if: ${{ github.base_ref == 'main' }}\n    steps:\n      - run: echo\n  app:\n    needs: gate\n    steps:\n      - run: npm run test\n",
      /github\.base_ref == 'main'.*gate|gate.*github\.base_ref == 'main'/,
    ],
  ];
  for (const [onde, text, condicao] of condicionais) {
    it(`if: condicional no ${onde} passa com ressalva, citando a condição`, () => {
      const r = avalia(text);
      expect(fails(r)).toEqual([]);
      expect(warns(r)).toEqual([expect.objectContaining({ key: "test", message: expect.stringMatching(condicao) })]);
    });
  }
});

// Revisão de segurança da #31: `test: echo ok` passava — um opt-out
// disfarçado, sem o reason que o opt-out de verdade exige. E um comando
// declarado que engole a própria falha (`|| true`, `--if-present`) passava
// limpo, porque o passo rodava exatamente o que foi declarado.
describe("evaluateCiContract — comando declarado que não pode falhar", () => {
  const avalia = (ci: string, run: string) =>
    evaluateCiContract({
      specText: spec(ci),
      workflows: [wf("ci.yml", `on: pull_request\njobs:\n  app:\n    steps:\n      - run: ${JSON.stringify(run)}\n`)],
      readScripts: noScripts,
    });

  for (const cmd of ["echo ok", "'true'", "exit 0", "':'", "echo a && true"]) {
    it(`test: ${cmd} só tem comando trivial — reprova pedindo test: none com reason:`, () => {
      const run = cmd.replace(/^'|'$/g, "");
      const r = avalia(`ci:\n  test: ${cmd}`, run);
      expect(fails(r).map((f) => f.key)).toEqual(["test"]);
      expect(failText(r)).toMatch(/test: none com reason:/);
    });
  }

  it("lint trivial reprova pedindo para omitir a chave", () => {
    const r = avalia("ci:\n  test: npm test\n  lint: echo sem lint", "npm test && echo sem lint");
    expect(fails(r)).toEqual([expect.objectContaining({ key: "lint", message: expect.stringMatching(/omita a chave/) })]);
  });

  it("--if-present no comando declarado passa com ressalva", () => {
    const r = avalia("ci:\n  test: npm run test --if-present", "npm run test --if-present");
    expect(fails(r)).toEqual([]);
    expect(warns(r)).toEqual([expect.objectContaining({ key: "test", message: expect.stringMatching(/--if-present/) })]);
  });

  it("|| true no comando declarado passa com uma ressalva só, sobre a declaração", () => {
    const r = avalia("ci:\n  test: npm test || true", "npm test || true");
    expect(fails(r)).toEqual([]);
    expect(warns(r)).toEqual([
      expect.objectContaining({ key: "test", message: expect.stringMatching(/engole a própria falha.*\|\| true/) }),
    ]);
  });

  it("exit 1 não é trivial: o passo nunca passa, e isso não é verde falso", () => {
    expect(avalia("ci:\n  test: exit 1", "exit 1").findings).toEqual([]);
  });
});

// Revisão de segurança da #31: só o booleano `true` contava como
// continue-on-error. Uma expressão (`${{ true }}`, `${{ matrix.x }}`) ou o
// texto 'true' passavam limpos. Qualquer valor presente que não seja false
// conta como não bloqueante.
describe("evaluateCiContract — continue-on-error por expressão", () => {
  const avalia = (stepExtra: string, jobExtra = "") =>
    evaluateCiContract({
      specText: spec("ci:\n  test: npm run test"),
      workflows: [wf("ci.yml", `on: pull_request\njobs:\n  app:\n${jobExtra}    steps:\n      - run: npm run test\n${stepExtra}`)],
      readScripts: noScripts,
    });

  for (const valor of ["${{ true }}", "'true'", "${{ matrix.experimental }}"]) {
    it(`continue-on-error: ${valor} no passo passa com ressalva, citando o valor`, () => {
      const r = avalia(`        continue-on-error: ${valor}\n`);
      expect(fails(r)).toEqual([]);
      const citado = valor.replace(/^'|'$/g, "").replace(/[$.{}[\]()|*+?^]/g, "\\$&");
      expect(warns(r)).toEqual([expect.objectContaining({ key: "test", message: expect.stringMatching(new RegExp(`continue-on-error: ${citado}`)) })]);
    });
  }

  it("continue-on-error por expressão no job também conta", () => {
    const r = avalia("", "    continue-on-error: ${{ github.event_name == 'pull_request' }}\n");
    expect(warns(r)).toEqual([expect.objectContaining({ message: expect.stringMatching(/continue-on-error/) })]);
  });

  it("false e 'false' continuam limpos", () => {
    expect(avalia("        continue-on-error: false\n").findings).toEqual([]);
    expect(avalia("        continue-on-error: 'false'\n").findings).toEqual([]);
    expect(avalia("", "    continue-on-error: false\n").findings).toEqual([]);
  });
});

// Revisão de segurança da #31: o gatilho pull_request com `types` ou com
// filtro de base deixa PRs sem o check. Sem synchronize, um push novo no PR
// não roda nada (WARN); sem synchronize nem opened, o PR nunca é validado
// (não conta). branches e branches-ignore viram ressalva citando o filtro.
describe("evaluateCiContract — types e branches do pull_request", () => {
  const job = "jobs:\n  app:\n    steps:\n      - run: npm run test\n";
  const avalia = (on: string) =>
    evaluateCiContract({ specText: spec("ci:\n  test: npm run test"), workflows: [wf("ci.yml", `${on}\n${job}`)], readScripts: noScripts });

  for (const types of ["[opened]", "[labeled, opened]", "opened"]) {
    it(`types: ${types} (sem synchronize) passa com ressalva`, () => {
      const r = avalia(`on:\n  pull_request:\n    types: ${types}`);
      expect(fails(r)).toEqual([]);
      expect(warns(r)).toEqual([expect.objectContaining({ key: "test", message: expect.stringMatching(/synchronize/) })]);
    });
  }

  it("types com opened e synchronize passa limpo", () => {
    expect(avalia("on:\n  pull_request:\n    types: [opened, synchronize]").findings).toEqual([]);
    expect(avalia("on:\n  pull_request:\n    types: [opened, synchronize, reopened]").findings).toEqual([]);
  });

  // Re-verificação da #31 (N2): só synchronize deixa o PR recém-aberto sem o
  // check até o primeiro push.
  for (const types of ["[synchronize]", "[synchronize, reopened]", "synchronize"]) {
    it(`types: ${types} (sem opened) passa com ressalva`, () => {
      const r = avalia(`on:\n  pull_request:\n    types: ${types}`);
      expect(fails(r)).toEqual([]);
      expect(warns(r)).toEqual([
        expect.objectContaining({ key: "test", message: expect.stringMatching(/PR aberto fica sem o check até o primeiro push/) }),
      ]);
    });
  }

  for (const types of ["[reopened]", "[closed]", "[labeled, edited]"]) {
    it(`types: ${types} (sem opened nem synchronize) não conta, e a mensagem cita os types`, () => {
      const r = avalia(`on:\n  pull_request:\n    types: ${types}`);
      expect(fails(r).map((f) => f.key)).toEqual(["test"]);
      expect(failText(r)).toMatch(/types: \[/);
    });
  }

  it("branches e branches-ignore passam com ressalva citando o filtro", () => {
    const b = avalia("on:\n  pull_request:\n    branches: [develop]");
    expect(fails(b)).toEqual([]);
    expect(warns(b)).toEqual([expect.objectContaining({ key: "test", message: expect.stringMatching(/branches: \[develop\]/) })]);
    const bi = avalia("on:\n  pull_request:\n    branches-ignore: [main, 'release/**']");
    expect(fails(bi)).toEqual([]);
    expect(warns(bi)).toEqual([
      expect.objectContaining({ key: "test", message: expect.stringMatching(/branches-ignore: \[main, release\/\*\*\]/) }),
    ]);
  });

  it("a ressalva do gatilho chega ao passo de um reutilizável chamado por ele", () => {
    const reutilizavel = wf("checks.yml", "on: workflow_call\njobs:\n  t:\n    steps:\n      - run: npm run test\n");
    const chamador = wf("ci.yml", "on:\n  pull_request:\n    branches: [develop]\njobs:\n  app:\n    uses: ./.github/workflows/checks.yml\n");
    const r = evaluateCiContract({ specText: spec("ci:\n  test: npm run test"), workflows: [chamador, reutilizavel], readScripts: noScripts });
    expect(fails(r)).toEqual([]);
    expect(warns(r)).toEqual([expect.objectContaining({ message: expect.stringMatching(/branches: \[develop\]/) })]);
  });
});

// Revisão de segurança da #31: quem clona o framework como template herda o
// SPEC.md com workdir: aiteam e o ci.yml aiteam-scoped, põe a app na raiz, e o
// contrato passava testando só o framework. O núcleo não lê disco: quem chama
// passa os manifestos de app que achou na raiz. O framework não tem nenhum.
describe("evaluateCiContract — workdir dentro de aiteam/ com uma app na raiz", () => {
  const ciDoFramework = wf("ci.yml", CI_COPIADO_DO_FRAMEWORK);
  const avalia = (workdir: string, rootManifests?: string[]) =>
    evaluateCiContract({
      specText: spec(`ci:\n  workdir: ${workdir}\n  test: npm run test`),
      workflows: [ciDoFramework],
      readScripts: noScripts,
      ...(rootManifests ? { rootManifests } : {}),
    });

  for (const workdir of ["aiteam", "aiteam/src", "./aiteam/"]) {
    it(`workdir: ${workdir} com package.json na raiz reprova, nomeando o manifesto`, () => {
      const r = avalia(workdir, ["package.json"]);
      expect(fails(r)).toEqual([
        expect.objectContaining({
          key: "ci",
          message: expect.stringMatching(/a raiz tem uma app \(package\.json\), mas ci\.workdir aponta para o framework vendorizado/),
        }),
      ]);
    });
  }

  it("cita todos os manifestos achados", () => {
    expect(failText(avalia("aiteam", ["pyproject.toml", "go.mod"]))).toMatch(/\(pyproject\.toml, go\.mod\)/);
  });

  it("sem manifesto na raiz (o próprio framework) continua passando", () => {
    expect(avalia("aiteam", []).findings).toEqual([]);
    expect(avalia("aiteam").findings).toEqual([]);
  });

  it("workdir fora de aiteam/ com manifesto na raiz não é afetado", () => {
    const r = evaluateCiContract({
      specText: spec("ci:\n  test: npm run test"),
      workflows: [wf("ci.yml", CI_DOIS_JOBS)],
      readScripts: noScripts,
      rootManifests: ["package.json"],
    });
    expect(r.findings).toEqual([]);
  });

  it("isAppManifest reconhece os manifestos de app, e só eles", () => {
    for (const nome of ["package.json", "pyproject.toml", "go.mod", "Cargo.toml", "Gemfile", "composer.json", "pom.xml", "build.gradle", "build.gradle.kts"]) {
      expect(isAppManifest(nome), nome).toBe(true);
    }
    for (const nome of ["package-lock.json", "README.md", "SPEC.md", "tsconfig.json", "requirements.txt.bak", "build.gradle.bak/"]) {
      expect(isAppManifest(nome), nome).toBe(false);
    }
  });

  // Re-verificação da #31 (N3): um template-clone com app Python só de
  // requirements.txt, ou Deno, .NET, Elixir, Dart, Scala, passava.
  it("isAppManifest reconhece também Python, Deno, .NET, Elixir, Dart e Scala", () => {
    for (const nome of [
      "requirements.txt",
      "setup.py",
      "setup.cfg",
      "Pipfile",
      "deno.json",
      "deno.jsonc",
      "App.csproj",
      "App.fsproj",
      "App.sln",
      "mix.exs",
      "pubspec.yaml",
      "build.sbt",
    ]) {
      expect(isAppManifest(nome), nome).toBe(true);
    }
    for (const nome of [".csproj", "App.csproj.user", "Pipfile.lock", "deno.lock", "requirements-dev.txt.bak", "pubspec.lock"]) {
      expect(isAppManifest(nome), nome).toBe(false);
    }
  });

  it("um template-clone com app Python só de requirements.txt reprova (a raiz filtrada como quem chama faz)", () => {
    const raiz = ["README.md", "SPEC.md", "aiteam", "requirements.txt", "app.py"].filter(isAppManifest);
    expect(failText(avalia("aiteam", raiz))).toMatch(/a raiz tem uma app \(requirements\.txt\)/);
  });
});

describe("evaluateCiContract — entradas degradadas", () => {
  it("sem os workflows (sem parser YAML) avisa que não conferiu, e ainda julga o bloco", () => {
    const r = evaluateCiContract({ specText: spec("ci:\n  test: npm test"), workflows: null, readScripts: noScripts });
    expect(fails(r)).toEqual([]);
    expect(warns(r)).toEqual([expect.objectContaining({ key: "workflows" })]);

    const semBloco = evaluateCiContract({ specText: spec("budget_usd: 2.00"), workflows: null, readScripts: noScripts });
    expect(fails(semBloco).map((f) => f.key)).toEqual(["ci"]);
  });

  it("sem os workflows a delegação ainda é conferida: package.json não precisa de YAML", () => {
    const r = evaluateCiContract({
      specText: spec("ci:\n  test: npm test"),
      workflows: null,
      readScripts: scriptsAt({ "": { test: "npm --prefix aiteam test" } }),
    });
    expect(failText(r)).toMatch(/delega/);
  });

  it("workflow que não é YAML válido vira aviso com o nome do arquivo", () => {
    const r = evaluateCiContract({
      specText: spec("ci:\n  test: npm test"),
      workflows: [
        { file: "quebrado.yml", error: "bad indentation" },
        wf("ci.yml", "on: pull_request\njobs:\n  a:\n    steps:\n      - run: npm test\n"),
      ],
      readScripts: noScripts,
    });
    expect(fails(r)).toEqual([]);
    expect(warns(r)).toEqual([expect.objectContaining({ key: "workflows", message: expect.stringMatching(/quebrado\.yml/) })]);
  });

  it("workflow com forma inesperada não derruba a avaliação", () => {
    const estranhos = [
      { file: "a.yml", doc: null },
      { file: "b.yml", doc: "texto" },
      { file: "c.yml", doc: { on: 42, jobs: [1, 2] } },
      { file: "d.yml", doc: { on: "pull_request", jobs: { x: null, y: { steps: "não é lista" }, z: { steps: [null, { run: 7 }] } } } },
    ];
    const r = evaluateCiContract({ specText: spec("ci:\n  test: npm test"), workflows: estranhos, readScripts: noScripts });
    expect(fails(r).map((f) => f.key)).toEqual(["test"]);
  });
});
