import * as yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { checkCiContract } from "./doctor-core.mjs";

// Issue 51: o doctor mostra o portão local declarado em ci.local_test, e deixa
// claro que ele é só local — o que o CI roda em PR é o `test` completo.
const spec = (frontmatter: string) => `---\n${frontmatter}\n---\n\n# Spec\n`;
const PR = [{ file: "ci.yml", doc: yaml.load("on: pull_request\njobs:\n  app:\n    steps:\n      - run: npm run test\n") }];
const scripts = (dir: string): Record<string, string> | null =>
  dir === "" ? { test: "jest", "test:changed": "jest --changedSince=origin/main" } : null;

describe("doctor — checkCiContract e o portão local", () => {
  it("declarado e válido: passa, mostrando o comando e que o CI roda o test completo", () => {
    const r = checkCiContract({
      specText: spec("ci:\n  test: npm run test\n  local_test: npm run test:changed"),
      workflows: PR,
      readScripts: scripts,
    });
    expect(r.pass).toBe(true);
    expect(r.warn).toBeUndefined();
    expect(r.detail).toMatch(/local_test `npm run test:changed` → só local/);
    expect(r.detail).toMatch(/o CI roda o test completo/);
  });

  it("sem local_test, o detalhe não o menciona", () => {
    const r = checkCiContract({ specText: spec("ci:\n  test: npm run test"), workflows: PR, readScripts: scripts });
    expect(r.pass).toBe(true);
    expect(r.detail).not.toMatch(/local_test/);
  });

  it("local_test inválido reprova o check com o motivo", () => {
    const r = checkCiContract({
      specText: spec("ci:\n  test: npm run test\n  local_test: none"),
      workflows: PR,
      readScripts: scripts,
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/ci\.local_test: none não é opt-out/);
  });

  it("local_test não conta como o test: sem o test o check reprova, e o detalhe cobra o test", () => {
    const r = checkCiContract({
      specText: spec("ci:\n  local_test: npm run test:changed"),
      workflows: PR,
      readScripts: scripts,
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/ci\.test é obrigatório/);
  });
});
