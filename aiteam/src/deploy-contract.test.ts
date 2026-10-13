import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { contractBlockers, evaluateDeployContract } from "./deploy-contract-core.mjs";
import { repoRoot } from "./repo-root.js";

// AGENTS.md §CI/CD Mandate: o contrato do deploy — gate humano, health check
// que confere a versão, rollback-by-rerun — era declarado "fixo" e nada o
// verificava. O consumidor que servia de dogfood violava dois itens sem que
// teste, hook ou gate percebesse: o passo remoto fazia `git pull` (re-rodar
// com a tag anterior subia main de novo) e o health check olhava só o status
// (rb-ai-team#32). Agora o projeto declara no SPEC.md, no bloco deploy:, o
// workflow e o endpoint de versão, e o núcleo confere as três peças
// (aiteam/src/deploy-contract-core.mjs, o mesmo do doctor). Num consumidor sem
// o bloco este teste falha de propósito, com a mensagem do que declarar.
const root = repoRoot();
const dir = path.resolve(root, ".github", "workflows");

const workflows = fs.existsSync(dir)
  ? fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .map((file) => {
        try {
          return { file, doc: yaml.load(fs.readFileSync(path.join(dir, file), "utf8")) };
        } catch (e) {
          const err = e as { reason?: string; message?: string };
          return { file, error: String(err.reason ?? err.message ?? e) };
        }
      })
  : [];

const specText = (() => {
  try {
    return fs.readFileSync(path.join(root, "SPEC.md"), "utf8");
  } catch {
    return null;
  }
})();

// Os scripts do repo que um passo chama (o smoke.sh que consulta a versão).
// O núcleo só pede caminho relativo dentro do repo; a guarda é redundante.
const readFile = (rel: string): string | null => {
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(path.resolve(root) + path.sep)) return null;
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
};

describe("deploy — o contrato fixo do CI/CD Mandate vale no workflow que o SPEC.md declara", () => {
  // Reprova toda falha e também os avisos que deixam o rollback quebrado sem o
  // run perceber (permissions não declarado, tag no mesmo passo da consulta) —
  // ver contractBlockers. O doctor mostra esses dois como WARN.
  it("o workflow de deploy: aceita a ref, confere a versão servida e cria a tag deploy/ (ou o opt-out tem reason:)", () => {
    const r = evaluateDeployContract({ specText, workflows, readFile });
    expect(contractBlockers(r), "contrato de deploy — aiteam/AGENTS.md §CI/CD Mandate").toEqual([]);
  });
});
