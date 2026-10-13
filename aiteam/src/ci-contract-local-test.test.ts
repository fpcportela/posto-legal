import * as yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { evaluateCiContract, readCiBlock } from "./ci-contract-core.mjs";
import type { CiEvaluation } from "./ci-contract-core.mjs";
import { extractFrontmatter } from "./frontmatter.mjs";

// Issue 51: o portão local do TDD. `ci.local_test` é o comando que o agente roda
// no loop Red-Green-Refactor quando a suíte completa não cabe na máquina de
// quem trabalha (no mesa-crm, a da api com 21 workers do jest, ~8 GB, trava o
// computador; o portão local é `test:changed`). É opcional e só local: o CI de
// PR segue rodando o `test` completo, e o local_test nunca o substitui.
const spec = (frontmatter: string) => `---\n${frontmatter}\n---\n\n# Spec\n`;
type Wf = { file: string; doc: unknown };
const wf = (file: string, text: string): Wf => ({ file, doc: yaml.load(text) });
const fails = (r: CiEvaluation) => r.findings.filter((f) => f.level === "fail");
const warns = (r: CiEvaluation) => r.findings.filter((f) => f.level === "warn");
const failText = (r: CiEvaluation) => fails(r).map((f) => f.message).join("\n");
const scriptsAt =
  (byDir: Record<string, Record<string, string>>) =>
  (dir: string): Record<string, string> | null =>
    byDir[dir] ?? null;

describe("readCiBlock — ci.local_test", () => {
  it("lê o comando; ausente vem null", () => {
    expect(readCiBlock(spec("ci:\n  test: npm test\n  local_test: npm run test:changed"))).toMatchObject({
      state: "ok",
      ci: { test: "npm test", local_test: "npm run test:changed" },
    });
    expect(readCiBlock(spec("ci:\n  test: npm test"))).toMatchObject({ state: "ok", ci: { local_test: null } });
  });

  it("aceita aspas e comentário, como as outras chaves", () => {
    const r = readCiBlock(spec("ci:\n  test: npm test\n  local_test: 'jest --changedSince=origin/main'   # só o que mudou"));
    expect(r).toMatchObject({ state: "ok", ci: { local_test: "jest --changedSince=origin/main" } });
  });

  it("a chave declarada sem comando vira string vazia (não null): o contrato a reprova", () => {
    expect(readCiBlock(spec("ci:\n  test: npm test\n  local_test:"))).toMatchObject({ ci: { local_test: "" } });
    expect(readCiBlock(spec('ci:\n  test: npm test\n  local_test: "   "'))).toMatchObject({ ci: { local_test: "" } });
  });

  it("duas vezes é erro de leitura, como qualquer chave", () => {
    const r = readCiBlock(spec("ci:\n  test: npm test\n  local_test: a\n  local_test: b"));
    expect(r).toMatchObject({ state: "malformed", reason: expect.stringMatching(/ci\.local_test aparece duas vezes/) });
  });

  it("a mensagem de chave desconhecida lista local_test entre as aceitas", () => {
    const r = readCiBlock(spec("ci:\n  test: npm test\n  local_tests: x"));
    expect(r).toMatchObject({ state: "malformed", reason: expect.stringMatching(/as aceitas são .*local_test/) });
  });

  it("o yaml de verdade lê o mesmo valor que o leitor linha a linha", () => {
    const fm = 'ci:\n  test: npm test\n  local_test: "npm run test:changed -- --silent"';
    const theirs = (yaml.load(extractFrontmatter(spec(fm)) ?? "") as { ci: Record<string, string> }).ci;
    expect(theirs["local_test"]).toBe("npm run test:changed -- --silent");
    expect(readCiBlock(spec(fm))).toMatchObject({ ci: { local_test: theirs["local_test"] } });
  });
});

describe("evaluateCiContract — ci.local_test, o portão local", () => {
  const PR = "on: pull_request\njobs:\n  app:\n    steps:\n      - run: npm run test\n";
  const PR_IN_API =
    "on: pull_request\njobs:\n  app:\n    defaults:\n      run:\n        working-directory: api\n    steps:\n      - run: npm run test\n";
  const avalia = (ci: string, over: { workflows?: Wf[]; readScripts?: (dir: string) => Record<string, string> | null } = {}) =>
    evaluateCiContract({
      specText: spec(ci),
      workflows: over.workflows ?? [wf("ci.yml", PR)],
      readScripts: over.readScripts ?? scriptsAt({ "": { test: "jest", "test:changed": "jest --changedSince=origin/main" } }),
    });

  it("declarado e válido, passa sem achado — e nenhum workflow precisa rodá-lo", () => {
    const r = avalia("ci:\n  test: npm run test\n  local_test: npm run test:changed");
    expect(r.findings).toEqual([]);
    expect(r.located.map((l) => l.key)).toEqual(["test"]);
  });

  it("não substitui o test: sem ele o contrato falha, ainda que o workflow rode o comando local", () => {
    const sozinho = avalia("ci:\n  local_test: npm run test:changed", {
      workflows: [wf("ci.yml", "on: pull_request\njobs:\n  app:\n    steps:\n      - run: npm run test:changed\n")],
    });
    expect(fails(sozinho).map((f) => f.key)).toEqual(["test"]);
    expect(failText(sozinho)).toMatch(/ci\.test é obrigatório/);
  });

  it("não substitui o test no workflow: o PR que só roda o comando local reprova o test", () => {
    const r = avalia("ci:\n  test: npm run test\n  local_test: npm run test:changed", {
      workflows: [wf("ci.yml", "on: pull_request\njobs:\n  app:\n    steps:\n      - run: npm run test:changed\n")],
    });
    expect(fails(r).map((f) => f.key)).toEqual(["test"]);
    expect(failText(r)).toMatch(/não roda em nenhum passo run: de workflow disparado em pull_request/);
  });

  it("com o opt-out test: none, o local_test não o desfaz nem o dispensa do reason", () => {
    const r = avalia("ci:\n  test: none\n  local_test: npm run test:changed");
    expect(fails(r)).toEqual([expect.objectContaining({ key: "test", message: expect.stringMatching(/reason/) })]);
  });

  it("vazio reprova: omita a chave ou declare o comando", () => {
    const r = avalia("ci:\n  test: npm run test\n  local_test:");
    expect(fails(r)).toEqual([
      expect.objectContaining({ key: "local_test", message: expect.stringMatching(/sem comando.*omita a chave/) }),
    ]);
  });

  it("none não é opt-out: sem a chave, os agentes rodam o ci.test", () => {
    const r = avalia("ci:\n  test: npm run test\n  local_test: none");
    expect(fails(r)).toEqual([
      expect.objectContaining({ key: "local_test", message: expect.stringMatching(/none não é opt-out.*omita a chave.*ci\.test/) }),
    ]);
  });

  it.each(["echo ok", "'true'", "exit 0"])("`%s` não roda nada que possa falhar: é um test: none disfarçado", (cmd) => {
    const r = avalia(`ci:\n  test: npm run test\n  local_test: ${cmd}`);
    expect(fails(r)).toEqual([
      expect.objectContaining({ key: "local_test", message: expect.stringMatching(/não roda nada que possa falhar/) }),
    ]);
  });

  it("um script que só delega para o framework vendorizado reprova, como no test", () => {
    const r = avalia("ci:\n  test: npm run test\n  local_test: npm run test:changed", {
      readScripts: scriptsAt({ "": { test: "jest", "test:changed": "npm --prefix aiteam run test" } }),
    });
    expect(fails(r)).toEqual([
      expect.objectContaining({ key: "local_test", message: expect.stringMatching(/framework vendorizado.*ci\.local_test/) }),
    ]);
  });

  it("o comando que entra em aiteam/ por cd também é delegação", () => {
    const r = avalia("ci:\n  test: npm run test\n  local_test: cd aiteam && npm run test:changed");
    expect(failText(r)).toMatch(/roda em aiteam\/, que é o framework vendorizado, não a app/);
  });

  it("no próprio framework (workdir em aiteam/) o local_test roda no framework, e isso é o certo", () => {
    const r = evaluateCiContract({
      specText: spec("ci:\n  workdir: aiteam\n  test: npm run test\n  local_test: npm run test:changed"),
      workflows: [
        wf(
          "ci.yml",
          "on: pull_request\njobs:\n  app:\n    defaults:\n      run:\n        working-directory: aiteam\n    steps:\n      - run: npm run test\n",
        ),
      ],
      readScripts: scriptsAt({ aiteam: { test: "vitest run", "test:changed": "vitest run --changed" } }),
    });
    expect(r.findings).toEqual([]);
  });

  it("o script que o package.json do workdir não tem reprova, dizendo onde procurou", () => {
    const r = avalia("ci:\n  test: npm run test\n  local_test: npm run test:changed", {
      readScripts: scriptsAt({ "": { test: "jest" } }),
    });
    expect(fails(r)).toEqual([
      expect.objectContaining({
        key: "local_test",
        message: expect.stringMatching(/chama o script test:changed, que o package\.json da raiz não tem/),
      }),
    ]);
  });

  it("coerente com o workdir: o script tem de existir no package.json do workdir, não no da raiz", () => {
    const wfApi = wf("ci.yml", PR_IN_API);
    const ruim = avalia("ci:\n  workdir: api\n  test: npm run test\n  local_test: npm run test:changed", {
      workflows: [wfApi],
      readScripts: scriptsAt({ "": { "test:changed": "jest --changedSince=origin/main" }, api: { test: "jest" } }),
    });
    expect(fails(ruim)).toEqual([
      expect.objectContaining({
        key: "local_test",
        message: expect.stringMatching(/chama o script test:changed, que o package\.json de api\/ não tem/),
      }),
    ]);
    const boa = avalia("ci:\n  workdir: api\n  test: npm run test\n  local_test: npm run test:changed", {
      workflows: [wfApi],
      readScripts: scriptsAt({ api: { test: "jest", "test:changed": "jest --changedSince=origin/main" } }),
    });
    expect(boa.findings).toEqual([]);
  });

  it("sem package.json no diretório (readScripts devolve null) não há o que conferir, e não reprova", () => {
    const r = avalia("ci:\n  test: pytest\n  local_test: npm run test:changed", {
      workflows: [wf("ci.yml", "on: pull_request\njobs:\n  app:\n    steps:\n      - run: pytest\n")],
      readScripts: () => null,
    });
    expect(fails(r)).toEqual([]);
  });

  it("um comando que não é de package.json (pytest) não depende dele", () => {
    const r = avalia("ci:\n  test: npm run test\n  local_test: pytest --lf -x");
    expect(r.findings).toEqual([]);
  });

  it("fora do workdir, avisa: o portão local de outra app não é o desta", () => {
    const r = avalia("ci:\n  workdir: api\n  test: npm run test\n  local_test: cd ../web && npm run test:changed", {
      workflows: [wf("ci.yml", PR_IN_API)],
      readScripts: scriptsAt({ api: { test: "jest" }, web: { "test:changed": "jest" } }),
    });
    expect(fails(r)).toEqual([]);
    expect(warns(r)).toEqual([expect.objectContaining({ key: "local_test", message: expect.stringMatching(/fora do workdir/) })]);
  });

  it("--if-present e || true passam com ressalva, como no test", () => {
    const a = avalia("ci:\n  test: npm run test\n  local_test: npm run test:changed --if-present");
    expect(fails(a)).toEqual([]);
    expect(warns(a)).toEqual([expect.objectContaining({ key: "local_test", message: expect.stringMatching(/--if-present/) })]);
    const b = avalia("ci:\n  test: npm run test\n  local_test: npm run test:changed || true");
    expect(fails(b)).toEqual([]);
    expect(warns(b)).toEqual([
      expect.objectContaining({ key: "local_test", message: expect.stringMatching(/engole a própria falha/) }),
    ]);
  });

  it.each(["pnpm", "yarn", "bun"])("%s run também tem o script conferido", (bin) => {
    const r = avalia(`ci:\n  test: npm run test\n  local_test: ${bin} run test:changed`, {
      readScripts: scriptsAt({ "": { test: "jest" } }),
    });
    expect(failText(r)).toMatch(/chama o script test:changed, que o package\.json da raiz não tem/);
  });
});

// Revisão do QA da #51 (R3). Quem roda o local_test é o agente, num shell sem -e e
// sem pipefail, e não o `bash -e` de um passo de Actions. O contrato analisava o
// comando como se fosse o passo, e um portão que não pode falhar passava limpo.
describe("evaluateCiContract — o local_test é analisado como o agente o roda", () => {
  const PR = "on: pull_request\njobs:\n  app:\n    steps:\n      - run: npm run test\n";
  const SCRIPTS = { "": { test: "jest", "test:changed": "jest -o", lint: "eslint ." }, app: { "test:changed": "jest -o" }, aiteam: { test: "vitest" } };
  const avalia = (lt: string, wd?: string) => {
    const wfDoc = wd
      ? `on: pull_request\njobs:\n  app:\n    defaults:\n      run:\n        working-directory: ${wd}\n    steps:\n      - run: npm run test\n`
      : PR;
    return evaluateCiContract({
      specText: spec(`ci:\n${wd ? `  workdir: ${wd}\n` : ""}  test: npm run test\n  local_test: ${JSON.stringify(lt)}`),
      workflows: [wf("ci.yml", wfDoc)],
      readScripts: scriptsAt({ ...SCRIPTS, ...(wd ? { [wd]: { test: "jest", "test:changed": "jest -o" } } : {}) }),
    });
  };
  const soLocal = (r: CiEvaluation) => r.findings.filter((f) => f.key === "local_test");

  describe("(a) sem errexit e sem pipefail: a falha que o status não carrega é engolida", () => {
    it.each([
      "npm run test:changed; exit 0",
      "npm run test:changed; true",
      "npm run test:changed; :",
      "npm run test:changed; echo feito",
      "npm run test:changed\nexit 0",
      "npm run test:changed | tee out.txt",
      "npm run test:changed | cat",
    ])("`%s` avisa que engole a falha", (lt) => {
      const r = avalia(lt);
      expect(fails(r), lt).toEqual([]);
      expect(soLocal(r).map((f) => f.level), lt).toEqual(["warn"]);
      expect(soLocal(r)[0]?.message, lt).toMatch(/engole a própria falha/);
    });

    it("o motivo fala do shell do agente, não do workflow", () => {
      const msg = soLocal(avalia("npm run test:changed; true"))[0]?.message ?? "";
      expect(msg).toMatch(/num shell sem set -e/);
      expect(msg).not.toMatch(/set \+e/);
      const pipe = soLocal(avalia("npm run test:changed | tee out.txt"))[0]?.message ?? "";
      expect(pipe).not.toMatch(/use shell: bash/);
      expect(pipe).toMatch(/pipefail/);
    });

    it.each([
      "npm run lint && npm run test:changed",
      "npm run test:changed",
      "npm run test:changed; exit",
      "set -e; npm run test:changed; exit 0",
      "set -eo pipefail; npm run test:changed | tee out.txt",
      "npm run test:changed || exit 1",
    ])("`%s` segue limpo: a falha chega ao status", (lt) => {
      expect(avalia(lt).findings, lt).toEqual([]);
    });

    it("o `exit` sem argumento leva o status do comando anterior, então não é um engole-falha", () => {
      expect(avalia("npm run test:changed; exit").findings).toEqual([]);
    });

    it("o test dos workflows segue analisado como o bash -e do passo: `; true` depois de um comando que para o passo não engole", () => {
      const r = evaluateCiContract({
        specText: spec("ci:\n  test: 'npm run test; true'"),
        workflows: [wf("ci.yml", "on: pull_request\njobs:\n  app:\n    steps:\n      - run: npm run test; true\n")],
        readScripts: scriptsAt(SCRIPTS),
      });
      expect(warns(r).filter((w) => w.key === "test")).toEqual([]);
    });
  });

  describe("(b) o que vem depois de exit/return nunca roda", () => {
    it.each([
      "exit 0; npm run test:changed",
      "exit 0 && npm run test:changed",
      "exit 1 || npm run test:changed",
      "{ exit 0; } && npm run test:changed",
      "return 0; npm run test:changed",
      "exit 0\nnpm run test:changed",
    ])("`%s` reprova: o shell sai antes", (lt) => {
      const r = avalia(lt);
      expect(fails(r), lt).toEqual([
        expect.objectContaining({ key: "local_test", message: expect.stringMatching(/nunca roda.*exit/) }),
      ]);
    });

    it.each([
      "(exit 0) && npm run test:changed",
      "(exit 0); npm run test:changed",
      "if npm run lint; then exit 0; fi; npm run test:changed",
      "npm run lint || exit 1; npm run test:changed",
      "npm run lint && exit 0; npm run test:changed",
    ])("`%s` não reprova: o exit sai só da subshell, ou é condicional, e o comando roda", (lt) => {
      expect(fails(avalia(lt)), lt).toEqual([]);
    });

    it("o exit num pipe ou em segundo plano não encerra o shell", () => {
      expect(fails(avalia("exit 0 | cat; npm run test:changed"))).toEqual([]);
      expect(fails(avalia("exit 0 & npm run test:changed"))).toEqual([]);
      expect(fails(avalia("cat x | exit 0; npm run test:changed"))).toEqual([]);
    });

    it("código vivo antes do exit e morto depois: avisa do que nunca roda, e reprova só quando não sobra nada", () => {
      const r = avalia("npm run test:changed && exit 0; npm run lint");
      expect(fails(r)).toEqual([]);
      const w = soLocal(r).filter((f) => /nunca roda/.test(f.message));
      expect(w).toEqual([]);
      const r2 = avalia("npm run test:changed\nexit 0\nnpm run lint");
      expect(fails(r2)).toEqual([]);
      expect(soLocal(r2).some((f) => f.level === "warn" && /nunca roda/.test(f.message))).toBe(true);
    });
  });

  describe("(c) um diretório que não dá para resolver está fora do workdir", () => {
    it.each([
      "cd /tmp && npm run test:changed",
      "cd ../../x && npm run test:changed",
      "cd $HOME && npm run test:changed",
      "cd $APP_DIR && npm run test:changed",
      "npm --prefix /abs run test:changed",
      "npm --prefix ../x run nope",
      "(cd .. && npm run test:changed)",
    ])("`%s` avisa que roda fora do workdir, sem reprovar", (lt) => {
      const r = avalia(lt);
      expect(fails(r), lt).toEqual([]);
      expect(soLocal(r).map((f) => f.level), lt).toEqual(["warn"]);
      expect(soLocal(r)[0]?.message, lt).toMatch(/num diretório que não dá para resolver, fora do workdir declarado/);
    });

    it("com workdir, subir para a raiz também é fora, e o aviso diz onde", () => {
      const r = avalia("cd .. && npm run test:changed", "app");
      expect(soLocal(r).map((f) => f.level)).toEqual(["warn"]);
      expect(soLocal(r)[0]?.message).toMatch(/roda na raiz, fora do workdir declarado \(app\/\)/);
    });

    it("um comando trivial num diretório que não resolve não conta (só o que roda de verdade)", () => {
      expect(avalia("(cd /tmp && echo oi); npm run test:changed").findings.filter((f) => /fora do workdir/.test(f.message))).toEqual([]);
    });

    it("o cd persiste: o que vem depois de `cd /tmp;` roda lá", () => {
      const r = avalia("cd /tmp; npm run test:changed");
      expect(soLocal(r).some((f) => /fora do workdir/.test(f.message))).toBe(true);
    });
  });

  describe("(A3) none em qualquer caixa não é opt-out", () => {
    it.each(["NONE", "None", "nOnE", "'none'", "' None '"])("local_test: %s", (v) => {
      const r = evaluateCiContract({
        specText: spec(`ci:\n  test: npm run test\n  local_test: ${v}`),
        workflows: [wf("ci.yml", PR)],
        readScripts: scriptsAt(SCRIPTS),
      });
      expect(fails(r)).toEqual([
        expect.objectContaining({ key: "local_test", message: expect.stringMatching(/none não é opt-out.*omita a chave/) }),
      ]);
    });
  });
});
