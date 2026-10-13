import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { readCiBlock } from "./ci-contract-core.mjs";
import { isUpstream, repoRoot } from "./repo-root.js";

const IS_UPSTREAM = isUpstream();

// Issue 51: o skill de TDD do superpowers (6.4.1) manda rodar o comando de teste
// do projeto, e a suíte completa pode não caber na máquina de quem a roda (no
// mesa-crm, a da api com 21 workers do jest, ~8 GB, trava o computador; o portão
// local é `test:changed`). O bloco ci: do SPEC.md ganha um campo opcional,
// `local_test`, que os agentes usam localmente quando ele existe e, senão, o
// `ci.test`. O CI segue rodando o `test` completo. Estes testes fixam o que os
// textos dos agentes e as docs do SPEC.md dizem sobre isso.
const read = (...p: string[]): string => fs.readFileSync(path.resolve(repoRoot(), ...p), "utf8");
const flat = (text: string): string => text.replace(/\s+/g, " ");

const agents = flat(read("aiteam", "AGENTS.md"));
const implement = flat(read("aiteam", "prompts", "implement.md"));
const orchestrator = flat(read("aiteam", "agents", "orchestrator.md"));
const readme = flat(read("aiteam", "README.md"));
const legacy = flat(read("aiteam", "docs", "legacy-onboarding.md"));
const ciExample = flat(read("aiteam", "templates", "ci.yml.example"));

describe("AGENTS.md — o portão local do TDD", () => {
  it("§Code Standards: o loop e o gate rodam ci.local_test quando declarado, senão ci.test", () => {
    expect(agents).toMatch(/Red-Green-Refactor\)\. Tests live in `src\/\*\*\/\*\.test\.ts`\./);
    expect(agents).toMatch(/`ci\.local_test` from the `ci:` block of `SPEC\.md` when declared, otherwise `ci\.test`, in `ci\.workdir`/);
    expect(agents).toMatch(/CI runs the full `ci\.test` on the PR either way/);
  });

  // A suíte do aiteam/ roda em todo consumidor; quem escreve teste novo precisa saber
  // disso onde o framework fala de testes (o guarda: host-reads-guard.test.ts).
  it("§Code Standards: teste que lê arquivo do hospedeiro fora de aiteam/ é restrito ao upstream ou vai na ALLOW do guarda", () => {
    expect(agents).toMatch(/A test that reads a host file outside `aiteam\/` is restricted to the upstream \(`skipIf\(!isUpstream\(\)\)`, from `src\/repo-root\.ts`\) or goes in the allowlist of `src\/host-reads-guard\.test\.ts`/);
  });

  it("§CI/CD Mandate: o exemplo do bloco ci: mostra o campo como opcional e só local", () => {
    expect(agents).toMatch(/local_test: npm run test:changed\s+# optional — the local TDD gate; CI still runs `test`/);
  });

  it("§CI/CD Mandate: o campo não substitui o test e o contrato o confere", () => {
    expect(agents).toMatch(/\*\*Local gate \(optional\):\*\*/);
    expect(agents).toMatch(/It is local only: no workflow has to run it, it never replaces `test`, and CI still runs the full `test` on the PR/);
    expect(agents).toMatch(/a non-empty command, never `none` \(omit the key instead\), consistent with `workdir`/);
    expect(agents).toMatch(/not a delegation to the vendored framework/);
    expect(agents).toMatch(/`generate-spec` declares it when it finds a `test:changed`/);
  });
});

describe("os prompts e personas mandam rodar o portão certo", () => {
  it("implement.md: o comando local é o ci.local_test, senão o ci.test, no ci.workdir", () => {
    expect(implement).toMatch(/\*\*Local test gate\*\*/);
    expect(implement).toMatch(/`ci\.local_test` when it is there, otherwise `ci\.test`, in `ci\.workdir`/);
    expect(implement).toMatch(/CI runs the full `ci\.test` on the PR regardless/);
    expect(implement).toMatch(/name every failure/);
  });

  it("implement.md: o report diz qual comando rodou os testes", () => {
    expect(implement).toMatch(/which tests pass \(and the command that ran them: `ci\.local_test` or `ci\.test`\)/);
  });

  it("o Orchestrator manda o brief pedir os testes rodados com o portão local do projeto", () => {
    expect(orchestrator).toMatch(/run with the project's local gate: `ci\.local_test` from the `ci:` block of `SPEC\.md` when declared, else `ci\.test`/);
  });
});

describe("docs do SPEC.md — o campo local_test", () => {
  // Só no upstream (rb-ai-team#60): o SPEC.md da raiz é o do framework, que documenta
  // o campo em comentário. Num consumidor é o do projeto: o comentário é doc do
  // template (a raiz não viaja no sync) e o consumidor pode, com razão, declarar o
  // `local_test` de verdade — o que este teste reprovaria. Lá ele é pulado.
  it.skipIf(!IS_UPSTREAM)("o SPEC.md do framework documenta o campo como comentário no bloco ci:, sem declará-lo", () => {
    const spec = read("SPEC.md");
    expect(spec).toMatch(/^ {2}# local_test: npm run test:changed/m);
    const block = readCiBlock(spec);
    expect(block.state).toBe("ok");
    expect(block.state === "ok" && block.ci.local_test).toBeNull();
  });

  it("README EN e PT: o generate-spec declara o local_test quando acha o script", () => {
    expect(readme).toMatch(/also becomes `local_test:`, the optional local gate the agents run while they work, in place of `test` \(CI still runs the full `test`\)/);
    expect(readme).toMatch(/vira também `local_test:`, o portão local opcional que os agentes rodam enquanto trabalham, no lugar do `test` \(o CI segue rodando o `test` completo\)/);
  });

  it("legacy-onboarding.md: o rascunho do ci: lista o local_test que achar", () => {
    expect(legacy).toMatch(/plus `local_test` when it finds a `test:changed`-style script/);
  });

  it("ci.yml.example: o local_test não vira passo do workflow", () => {
    expect(ciExample).toMatch(/O `local_test` do ci: .* não vira passo aqui: é só local/);
  });
});

// Revisão do QA da #51 (R4): o backend-architect fechava a tarefa com "full suite
// green", o que contradiz a decisão 3 (os agentes rodam o portão local, e a suíte
// completa pode travar a máquina). Nenhuma persona pode mandar rodar a suíte
// completa como critério de pronto.
describe("as personas fecham a tarefa com o portão local, não com a suíte completa", () => {
  const GATE = "the project's local gate green (`ci.local_test`, else `ci.test`)";
  const persona = (name: string): string => flat(read("aiteam", "agents", `${name}.md`));
  const binding = (name: string): string => flat(read(".claude", "agents", `${name}.md`));

  it("backend-architect: o Done means pede o portão local verde", () => {
    for (const texto of [persona("backend-architect"), binding("backend-architect")]) {
      expect(texto).toContain(`**Done means:** ${GATE}`);
      expect(texto).not.toMatch(/full suite green/i);
    }
  });

  it("frontend-expert: o Done means pede o portão local verde, não todos os testes", () => {
    for (const texto of [persona("frontend-expert"), binding("frontend-expert")]) {
      expect(texto).toContain(`**Done means:** ${GATE}`);
      expect(texto).not.toMatch(/all tests green/i);
    }
  });

  it("release-engineer: a precondição é o portão local e o CI verde", () => {
    for (const texto of [persona("release-engineer"), binding("release-engineer")]) {
      expect(texto).toContain("the project's local gate (`ci.local_test`, else `ci.test`) AND CI green");
      expect(texto).not.toMatch(/local suite AND CI green/);
    }
  });

  it("nenhum persona-file nem o implement.md manda rodar a suíte completa", () => {
    const dir = path.resolve(repoRoot(), "aiteam", "agents");
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const texto = flat(fs.readFileSync(path.join(dir, f), "utf8"));
      expect(texto, f).not.toMatch(/full (?:test )?suite (?:green|passes|pass)|run the full (?:test )?suite|all tests green|local suite/i);
    }
    expect(implement).not.toMatch(/full suite green|run the full suite/i);
  });
});
