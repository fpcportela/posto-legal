import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { evaluateCiContract, readCiBlock } from "./ci-contract-core.mjs";
import { extractFrontmatter } from "./frontmatter.mjs";
import { renderCiBlock } from "./spec-draft.js";

// Issue 51: o rascunho do generate-spec declara o portão local do TDD
// (ci.local_test) quando o package.json tem um script que roda só o que a
// mudança toca. É um palpite de código, como o resto do bloco: opcional, só
// local, e o CI segue rodando o `test` completo.
const spec = (block: string) =>
  ["---", 'project: "x"', block, 'last_updated: "2026-10-06"', "---", "", "# Project Specification", ""].join("\n");
const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: "x", scripts });

describe("renderCiBlock — o portão local detectado do package.json", () => {
  it("test:changed vira ci.local_test, ao lado do test completo", () => {
    const block = renderCiBlock(pkg({ test: "jest", "test:changed": "jest --changedSince=origin/main" }));
    expect(readCiBlock(spec(block))).toMatchObject({
      state: "ok",
      ci: { test: "npm run test", local_test: "npm run test:changed" },
    });
  });

  it.each(["test:changed", "test:affected", "test:related", "test:local"])("reconhece %s", (name) => {
    const read = readCiBlock(spec(renderCiBlock(pkg({ test: "jest", [name]: "jest -o" }))));
    expect(read).toMatchObject({ state: "ok", ci: { local_test: `npm run ${name}` } });
  });

  it("havendo mais de um, vale a ordem changed, affected, related, local", () => {
    const read = readCiBlock(
      spec(renderCiBlock(pkg({ test: "jest", "test:local": "a", "test:related": "b", "test:affected": "c", "test:changed": "d" }))),
    );
    expect(read).toMatchObject({ ci: { local_test: "npm run test:changed" } });
    const semChanged = readCiBlock(spec(renderCiBlock(pkg({ test: "jest", "test:local": "a", "test:related": "b" }))));
    expect(semChanged).toMatchObject({ ci: { local_test: "npm run test:related" } });
  });

  it("usa o gerenciador do repo, como o resto do bloco", () => {
    const read = readCiBlock(spec(renderCiBlock(pkg({ test: "vitest run", "test:changed": "vitest run --changed" }), "pnpm")));
    expect(read).toMatchObject({ ci: { test: "pnpm run test", local_test: "pnpm run test:changed" } });
  });

  it("sem um script assim, a chave nem aparece: o portão local é opcional", () => {
    const block = renderCiBlock(pkg({ test: "jest", "test:unit": "jest unit", "test:e2e": "playwright test" }));
    expect(block).not.toMatch(/local_test/);
    expect(readCiBlock(spec(block))).toMatchObject({ ci: { local_test: null } });
  });

  it("script vazio não conta", () => {
    expect(renderCiBlock(pkg({ test: "jest", "test:changed": "  " }))).not.toMatch(/local_test/);
  });

  it("o portão local não faz as vezes do test: sem script test, o test continua vazio e o contrato o cobra", () => {
    const text = spec(renderCiBlock(pkg({ "test:changed": "jest -o" })));
    expect(readCiBlock(text)).toMatchObject({ ci: { test: null, local_test: "npm run test:changed" } });
    const v = evaluateCiContract({ specText: text, workflows: [], readScripts: () => ({ "test:changed": "jest -o" }), rootManifests: [] });
    expect(v.findings.some((f) => f.level === "fail" && f.key === "test")).toBe(true);
  });

  it("o contrato aceita o que o rascunho declara: o script existe no package.json do workdir", () => {
    const scripts = { test: "jest", "test:changed": "jest -o" };
    const v = evaluateCiContract({
      specText: spec(renderCiBlock(pkg(scripts))),
      workflows: [{ file: "ci.yml", doc: { on: { pull_request: null }, jobs: { app: { steps: [{ run: "npm run test" }] } } } }],
      readScripts: () => scripts,
      rootManifests: ["package.json"],
    });
    expect(v.findings).toEqual([]);
  });

  it("é YAML válido, e o comentário explica que o CI segue rodando o test", () => {
    const block = renderCiBlock(pkg({ test: "jest", "test:changed": "jest -o" }));
    const doc = yaml.load(extractFrontmatter(spec(block)) ?? "") as { ci: { local_test: string } };
    expect(doc.ci.local_test).toBe("npm run test:changed");
    expect(block).toMatch(/o CI segue rodando o test completo/);
  });
});
