import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { evaluateCiContract, readCiBlock } from "./ci-contract-core.mjs";
import { evaluateDeployContract, readDeployBlock } from "./deploy-contract-core.mjs";
import { extractFrontmatter } from "./frontmatter.mjs";
import { buildPrompt, detectPackageManager, renderCiBlock, renderDeployBlock, withContractBlocks } from "./spec-draft.js";

// O rascunho do generate-spec saía sem os blocos ci: e deploy:, e todo
// consumidor reprovava no contrato até editar o frontmatter à mão. Os blocos
// agora vêm de código (não do LLM): ci: com o que o package.json declara,
// deploy: com um placeholder que o contrato e o doctor reprovam até ser
// preenchido — nunca um opt-out silencioso (workflow: none).

const spec = (...blocks: string[]) =>
  ["---", 'project: "x"', "version: \"0.1.0\"", ...blocks, 'last_updated: "2026-10-06"', "---", "", "# Project Specification", ""].join("\n");

const pkg = (scripts: Record<string, string> | undefined) => JSON.stringify({ name: "x", ...(scripts ? { scripts } : {}) });

const NPM_INIT_TEST = 'echo "Error: no test specified" && exit 1';

describe("renderCiBlock — o ci: do rascunho, do package.json", () => {
  it("declara test, typecheck e lint com os scripts detectados, e o workdir na raiz", () => {
    const block = renderCiBlock(pkg({ test: "vitest run", typecheck: "tsc --noEmit", lint: "eslint ." }));
    const read = readCiBlock(spec(block));
    expect(read).toEqual({
      state: "ok",
      ci: { workdir: "", test: "npm run test", local_test: null, typecheck: "npm run typecheck", lint: "npm run lint", reason: null },
    });
  });

  it("só declara typecheck e lint se o package.json os tem (omitir a chave não reprova)", () => {
    const read = readCiBlock(spec(renderCiBlock(pkg({ test: "jest" }))));
    expect(read.state).toBe("ok");
    if (read.state === "ok") {
      expect(read.ci.test).toBe("npm run test");
      expect(read.ci.typecheck).toBeNull();
      expect(read.ci.lint).toBeNull();
    }
  });

  it.each([
    ["sem package.json", null],
    ["package.json ilegível", "{ não é json"],
    ["package.json sem scripts", pkg(undefined)],
    ["sem script test", pkg({ build: "tsc" })],
    ["o test que o npm init gera (sai sempre com 1)", pkg({ test: NPM_INIT_TEST })],
  ])("%s: deixa o test: vazio, e o contrato reprova até alguém preencher", (_label, text) => {
    const text2 = spec(renderCiBlock(text));
    const read = readCiBlock(text2);
    expect(read.state).toBe("ok");
    if (read.state === "ok") expect(read.ci.test).toBeNull();
    const verdict = evaluateCiContract({ specText: text2, workflows: [], readScripts: () => null, rootManifests: [] });
    expect(verdict.findings.some((f) => f.level === "fail" && f.key === "test")).toBe(true);
  });

  it("não vira um opt-out: nunca emite test: none", () => {
    for (const text of [null, pkg({ test: NPM_INIT_TEST }), pkg({ test: "vitest" })]) {
      const read = readCiBlock(spec(renderCiBlock(text)));
      expect(read.state === "ok" && read.ci.test).not.toBe("none");
      expect(read.state === "ok" && read.ci.reason).toBeNull();
    }
  });

  it("é YAML válido, no formato que o doctor lê", () => {
    const fm = extractFrontmatter(spec(renderCiBlock(pkg({ test: "vitest", lint: "eslint ." }))));
    const doc = yaml.load(fm ?? "") as { ci: { workdir: string; test: string; lint: string } };
    expect(doc.ci).toMatchObject({ test: "npm run test", lint: "npm run lint" });
  });
});

// O ci: declara o comando que o CI de PR roda, e o contrato o confere contra os
// workflows: num repo pnpm ou yarn, `npm run test` não é o que o CI roda.
describe("o gerenciador de pacotes do ci:", () => {
  const scripts = pkg({ test: "vitest run", typecheck: "tsc --noEmit", lint: "eslint ." });

  it.each([
    ["pnpm", "pnpm run"],
    ["yarn", "yarn run"],
    ["bun", "bun run"],
    ["npm", "npm run"],
  ] as const)("%s: os três comandos usam `%s`", (manager, runner) => {
    const read = readCiBlock(spec(renderCiBlock(scripts, manager)));
    expect(read).toMatchObject({
      state: "ok",
      ci: { test: `${runner} test`, typecheck: `${runner} typecheck`, lint: `${runner} lint` },
    });
  });

  it("sem o argumento, é npm (como antes)", () => {
    const read = readCiBlock(spec(renderCiBlock(scripts)));
    expect(read).toMatchObject({ state: "ok", ci: { test: "npm run test" } });
  });

  it.each([
    [["pnpm-lock.yaml"], "pnpm"],
    [["yarn.lock"], "yarn"],
    [["bun.lockb"], "bun"],
    [["bun.lock"], "bun"],
    [["package-lock.json"], "npm"],
    [["npm-shrinkwrap.json"], "npm"],
    [[], "npm"],
    [["README.md", "src"], "npm"],
  ] as const)("o lockfile %j indica %s", (files, manager) => {
    expect(detectPackageManager(pkg({ test: "x" }), files)).toBe(manager);
  });

  it("vários lockfiles: pnpm vale mais que yarn, que vale mais que bun, que vale mais que npm", () => {
    expect(detectPackageManager(null, ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"])).toBe("pnpm");
    expect(detectPackageManager(null, ["package-lock.json", "yarn.lock"])).toBe("yarn");
    expect(detectPackageManager(null, ["package-lock.json", "bun.lockb"])).toBe("bun");
  });

  it("o campo packageManager do package.json vale mais que o lockfile", () => {
    const comCampo = JSON.stringify({ name: "x", packageManager: "yarn@4.1.0", scripts: { test: "x" } });
    expect(detectPackageManager(comCampo, ["package-lock.json"])).toBe("yarn");
    expect(detectPackageManager(JSON.stringify({ packageManager: "pnpm@9.1.0+sha512.abc" }), [])).toBe("pnpm");
    expect(detectPackageManager(JSON.stringify({ packageManager: "bun@1.1.0" }), ["yarn.lock"])).toBe("bun");
  });

  it("packageManager desconhecido ou sem sentido cai no lockfile", () => {
    expect(detectPackageManager(JSON.stringify({ packageManager: "cnpm@1" }), ["pnpm-lock.yaml"])).toBe("pnpm");
    expect(detectPackageManager(JSON.stringify({ packageManager: 7 }), ["yarn.lock"])).toBe("yarn");
    expect(detectPackageManager("{ não é json", ["yarn.lock"])).toBe("yarn");
  });

  it("o comando com o gerenciador certo é o que o contrato confere contra o workflow", () => {
    const text = spec(renderCiBlock(scripts, "pnpm"));
    const workflows = [
      { file: "ci.yml", doc: { name: "CI", on: { pull_request: null }, jobs: { app: { steps: [{ run: "pnpm run test" }, { run: "pnpm run typecheck" }, { run: "pnpm run lint" }] } } } },
    ];
    const v = evaluateCiContract({ specText: text, workflows, readScripts: () => null, rootManifests: ["package.json"] });
    expect(v.findings.filter((f) => f.level === "fail")).toEqual([]);
    // O mesmo workflow com o rascunho de `npm run test` reprova: o comando declarado não roda em PR.
    const npm = evaluateCiContract({ specText: spec(renderCiBlock(scripts)), workflows, readScripts: () => null, rootManifests: ["package.json"] });
    expect(npm.findings.some((f) => f.level === "fail")).toBe(true);
  });
});

describe("renderDeployBlock — o deploy: do rascunho reprova até ser preenchido", () => {
  const text = spec(renderDeployBlock());

  it("declara o workflow deploy.yml e deixa o version_url para preencher", () => {
    expect(readDeployBlock(text)).toEqual({
      state: "ok",
      deploy: { workflow: "deploy.yml", version_url: null, reason: null },
    });
  });

  it("não é opt-out: nem workflow: none, nem um reason pronto", () => {
    const read = readDeployBlock(text);
    expect(read.state === "ok" && read.deploy.workflow).not.toBe("none");
    expect(read.state === "ok" && read.deploy.reason).toBeNull();
  });

  it("o contrato reprova pelo version_url mesmo sem olhar os workflows", () => {
    const v = evaluateDeployContract({ specText: text, workflows: null, readFile: () => null });
    expect(v.findings.filter((f) => f.level === "fail").map((f) => f.key)).toContain("version_url");
  });

  it("o contrato reprova também porque o deploy.yml não existe, apontando o modelo", () => {
    const v = evaluateDeployContract({ specText: text, workflows: [], readFile: () => null });
    const fails = v.findings.filter((f) => f.level === "fail");
    expect(fails.map((f) => f.key)).toEqual(expect.arrayContaining(["version_url", "workflow"]));
    expect(fails.some((f) => f.message.includes("deploy.yml.example"))).toBe(true);
  });

  it("nenhum achado é só aviso: o rascunho não passa nem com ressalva", () => {
    const v = evaluateDeployContract({ specText: text, workflows: [], readFile: () => null });
    expect(v.findings.some((f) => f.level === "fail")).toBe(true);
  });

  it("é YAML válido", () => {
    const doc = yaml.load(extractFrontmatter(text) ?? "") as { deploy: { workflow: string; version_url: unknown } };
    expect(doc.deploy.workflow).toBe("deploy.yml");
    expect(doc.deploy.version_url).toBeNull();
  });
});

describe("withContractBlocks — o que o LLM devolveu ganha os blocos de código", () => {
  const ci = renderCiBlock(pkg({ test: "vitest" }));
  const deploy = renderDeployBlock();

  it("acrescenta os dois blocos antes do last_updated e não toca no corpo", () => {
    const out = withContractBlocks(spec(), { ci, deploy });
    expect(readCiBlock(out).state).toBe("ok");
    expect(readDeployBlock(out).state).toBe("ok");
    const fm = extractFrontmatter(out) ?? "";
    expect(fm.indexOf("ci:")).toBeLessThan(fm.indexOf("last_updated:"));
    expect(fm.indexOf("deploy:")).toBeLessThan(fm.indexOf("last_updated:"));
    expect(out.endsWith("\n# Project Specification\n")).toBe(true);
    expect(() => yaml.load(fm)).not.toThrow();
  });

  it("troca os blocos que o LLM inventou (um test: none sem motivo seria um opt-out silencioso)", () => {
    const invented = spec(
      "ci:\n  test: none\n  reason: gerado",
      "deploy:\n  workflow: none\n  reason: gerado",
    );
    const out = withContractBlocks(invented, { ci, deploy });
    expect(out.match(/^ci:/gm)).toHaveLength(1);
    expect(out.match(/^deploy:/gm)).toHaveLength(1);
    expect(out).not.toMatch(/gerado/);
    const read = readCiBlock(out);
    expect(read.state === "ok" && read.ci.test).toBe("npm run test");
    const dep = readDeployBlock(out);
    expect(dep.state === "ok" && dep.deploy.workflow).toBe("deploy.yml");
  });

  // O leitor do contrato (readCiBlock/readDeployBlock) fecha o bloco na próxima chave de
  // coluna 0 que não seja comentário ou linha em branco: um comentário na coluna 0 NO MEIO
  // do bloco não o fecha. O dropBlocks fechava, e as linhas indentadas depois do comentário
  // ficavam órfãs, coladas ao bloco anterior.
  describe("o que o modelo escreveu com esses nomes sai inteiro, como o leitor do contrato o delimita", () => {
    const frontmatter = (...lines: string[]) => ["---", 'project: "x"', "infra_kb:", '  remote: ""', ...lines, 'last_updated: "2026-10-06"', "---", "", "# P", ""].join("\n");
    const fmOf = (out: string) => extractFrontmatter(out) ?? "";

    it("um comentário na coluna 0 dentro do bloco não o fecha: as linhas depois dele saem também", () => {
      const out = withContractBlocks(
        frontmatter("ci:", "  test: none", "# comentário na coluna 0, dentro do bloco", "  reason: gerado", "deploy:", "  workflow: none", "# outro", "  reason: gerado"),
        { ci, deploy },
      );
      expect(out).not.toMatch(/gerado/);
      expect(out.match(/^ci:/gm)).toHaveLength(1);
      expect(out.match(/^deploy:/gm)).toHaveLength(1);
      // Nada ficou órfão no bloco anterior: o infra_kb só tem a sua chave.
      const doc = yaml.load(fmOf(out)) as { infra_kb: Record<string, unknown>; ci: { test: string } };
      expect(Object.keys(doc.infra_kb)).toEqual(["remote"]);
      expect(doc.ci.test).toBe("npm run test");
      const read = readCiBlock(out);
      expect(read.state === "ok" && read.ci.reason).toBeNull();
    });

    it("o comentário que antecede a próxima chave de topo é dela e fica", () => {
      const out = withContractBlocks(frontmatter("ci:", "  test: none", "", "# quando foi a última revisão", ), { ci, deploy });
      expect(out).toContain("# quando foi a última revisão");
      expect(out).not.toMatch(/test: none/);
      expect(out.indexOf("# quando foi a última revisão")).toBeLessThan(out.indexOf("last_updated:"));
    });

    it("a chave entre aspas (\"deploy\": ou 'ci':) é a mesma chave para o YAML, e também sai", () => {
      const out = withContractBlocks(frontmatter('"deploy":', "  workflow: none", "  reason: gerado", "'ci':", "  test: none", "  reason: gerado"), { ci, deploy });
      expect(out).not.toMatch(/gerado/);
      expect(out).not.toMatch(/"deploy"|'ci'/);
      // Sem chave duplicada: o js-yaml recusaria.
      expect(() => yaml.load(fmOf(out))).not.toThrow();
    });

    it("chave com espaço antes dos dois-pontos, e comentário na linha da chave", () => {
      const out = withContractBlocks(frontmatter("ci :   # do modelo", "  test: none", "deploy:   # do modelo", "  workflow: none"), { ci, deploy });
      expect(out).not.toMatch(/do modelo|^\s*test: none|^\s*workflow: none/m);
      expect(() => yaml.load(fmOf(out))).not.toThrow();
    });

    it("bloco em estilo de fluxo na própria linha", () => {
      const out = withContractBlocks(frontmatter("ci: { test: none }", "deploy: { workflow: none }"), { ci, deploy });
      expect(out).not.toMatch(/\{ test: none \}|\{ workflow: none \}/);
      expect(() => yaml.load(fmOf(out))).not.toThrow();
    });

    it("linhas em branco no meio do bloco não o fecham", () => {
      const out = withContractBlocks(frontmatter("ci:", "  test: none", "", "  reason: gerado"), { ci, deploy });
      expect(out).not.toMatch(/gerado/);
      expect(() => yaml.load(fmOf(out))).not.toThrow();
    });

    it("uma chave que só COMEÇA com o nome (ci_extra:, deployment:) não é o bloco", () => {
      const out = withContractBlocks(frontmatter("ci_extra: 1", "deployment:", "  x: 1"), { ci, deploy });
      expect(out).toContain("ci_extra: 1");
      expect(out).toContain("deployment:");
      expect(out).toContain("  x: 1");
    });
  });

  it("é idempotente", () => {
    const once = withContractBlocks(spec(), { ci, deploy });
    expect(withContractBlocks(once, { ci, deploy })).toBe(once);
  });

  it("sem last_updated, os blocos vão ao fim do frontmatter", () => {
    const bare = ["---", 'project: "x"', "---", "", "# P", ""].join("\n");
    const out = withContractBlocks(bare, { ci, deploy });
    expect(readCiBlock(out).state).toBe("ok");
    expect(readDeployBlock(out).state).toBe("ok");
    expect(out.endsWith("\n# P\n")).toBe(true);
  });

  it("texto sem frontmatter volta como veio (quem chama avisa pelo reader)", () => {
    expect(withContractBlocks("# só corpo\n", { ci, deploy })).toBe("# só corpo\n");
  });
});

describe("buildPrompt", () => {
  const snap = { packageJson: null, readmeSnippet: null, srcTree: [], schemaFiles: [], envExample: null, recentCommits: null };
  const ci = renderCiBlock(pkg({ test: "vitest" }));
  const deploy = renderDeployBlock();

  it("leva os dois blocos no modelo, para copiar sem alterar", () => {
    const prompt = buildPrompt(snap, "meu-app", { ci, deploy }, "2026-10-06");
    expect(prompt).toContain(ci);
    expect(prompt).toContain(deploy);
    expect(prompt).toMatch(/ci:.*deploy:|deploy:.*ci:/s);
    expect(prompt).toContain('project: "meu-app"');
    expect(prompt).toContain('last_updated: "2026-10-06"');
  });
});
