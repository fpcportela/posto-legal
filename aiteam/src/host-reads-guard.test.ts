import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A suíte do aiteam/ roda em todo consumidor (`npm --prefix aiteam test` no CI) e a raiz do
// repo é do projeto dele: teste que afirma um arquivo do HOSPEDEIRO fora de aiteam/ passa aqui
// e deixa o CI do consumidor vermelho (#27, #36, #60, #62). Este guarda reprova teste que lê
// tal arquivo sem (a) restrição ao upstream (skipIf(!IS_UPSTREAM) ou skipIf(!isUpstream()), de
// repo-root.ts) ou (b) entrada em ALLOW: teste, 1º segmento do que lê e por que o consumidor o tem.
// Heurística de texto, sem AST. Limites: só vê caminho em literal (`path.join(root, ".claude")`,
// `read(".claude")`, nunca variável), só pela raiz que o arquivo nomeia (`repoRoot()`, `= repoRoot()`,
// `= path.resolve(AITEAM, "..")`), e o skipIf vale para o arquivo inteiro, não para a leitura.
const ALLOW: Array<[teste: string, lê: string[], porque: string]> = [
  ["ci-contract.test.ts", [".github", "SPEC.md"], "contrato por desenho: o CI do hospedeiro cumpre o ci: do SPEC.md dele; sem o bloco, falha de propósito (#31)"],
  ["deploy-contract.test.ts", [".github", "SPEC.md"], "contrato por desenho: o deploy do hospedeiro cumpre o deploy: do SPEC.md dele; sem o bloco, falha de propósito (#32)"],
  ["ci-aiteam-sync.test.ts", ["tools", ".github"], "describe.skipIf(!hasSyncTool): só roda onde existe tools/aiteam-sync, que não viaja"],
  ["ci-aiteam-sync-consumer.test.ts", ["tools"], "controle que retorna sem asserir quando não há tools/aiteam-sync/sync.mjs"],
  ["githooks-contract.test.ts", [".gitattributes"], "o consumidor depende de propósito: o .gitattributes não mapeia o merge driver beads-yaml (#37)"],
  ["install-core.test.ts", [".claude", ".gitignore"], "dogfood: o install grava o baseRef no settings.json e a regra no .gitignore de todo hospedeiro"],
  ["install-gitignore-superpowers.test.ts", [".gitignore"], "dogfood: o install grava as três regras no .gitignore de todo hospedeiro"],
  ["sync-agents.test.ts", [".claude"], "o .claude/agents/ é gerado pelo sync-agents em todo hospedeiro, e o teste o confere"],
  ["persona-contract.test.ts", [".claude"], "idem: lê os bindings .claude/agents/ gerados"],
  ["superpowers-rules-contract.test.ts", [".claude"], "idem: lê o binding .claude/agents/qa-security-reviewer.md"],
  ["local-test-docs-contract.test.ts", [".claude"], "idem: lê os bindings .claude/agents/ (o skipIf do SPEC.md é só do upstream)"],
];

const hostReads = (src: string): string[] => {
  const raiz = ["repoRoot\\(\\)"];
  for (const m of src.matchAll(/\b(\w+)\s*=\s*(?:repoRoot\(\)|path\.resolve\((?:AITEAM|aiteam),\s*"\.\."\))/g)) raiz.push(`\\b${m[1]}\\b`);
  for (const m of src.matchAll(/\bconst\s+(\w+)\s*=\s*\(\.\.\.[^;]*repoRoot\(\)/g)) raiz.push(`\\b${m[1]}\\b`); // const read = (...p) => … repoRoot() …
  const lit = new RegExp(`(?:${raiz.join("|")})\\s*[,(]\\s*["'\`]([^"'\`]+)["'\`]`, "g");
  return [...new Set([...src.matchAll(lit)].map((m) => m[1]!.split(/[\\/]/)[0]!))].filter((s) => s !== "aiteam");
};
const soUpstream = (src: string): boolean => /\b(?:skipIf|runIf)\(\s*!?\s*(?:IS_UPSTREAM|isUpstream\b)/.test(src);
// As leituras do hospedeiro que o teste `f` (com este texto) faz sem restrição ao upstream nem ALLOW.
const soltos = (f: string, src: string): string[] =>
  soUpstream(src) ? [] : hostReads(src).filter((s) => !ALLOW.some(([t, lê]) => t === f && lê.includes(s))).map((s) => `${f}:${s}`);

const SRC = path.dirname(fileURLToPath(import.meta.url));
const lerTeste = (f: string): string => fs.readFileSync(path.join(SRC, f), "utf8");
const testes = fs.readdirSync(SRC).filter((f) => f.endsWith(".test.ts") && f !== "host-reads-guard.test.ts");

describe("testes do framework não afirmam o repo hospedeiro (#27, #36, #60, #62)", () => {
  it("todo teste que lê arquivo do hospedeiro fora de aiteam/ é restrito ao upstream ou está em ALLOW", () => {
    expect(testes.flatMap((f) => soltos(f, lerTeste(f))), "restrinja ao upstream (isUpstream) ou acrescente a ALLOW com o porquê").toEqual([]);
  });

  it("toda entrada de ALLOW tem justificativa e aponta para uma leitura que o teste ainda faz", () => {
    for (const [f, lê, porque] of ALLOW) {
      expect(porque.length, f).toBeGreaterThan(20);
      expect(testes.includes(f) ? hostReads(lerTeste(f)) : [], `${f}: entrada velha em ALLOW`).toEqual(expect.arrayContaining(lê));
    }
  });

  it("reprova o padrão da #60 (teste novo lendo o SPEC.md do hospedeiro) e aceita o restrito ou o da ALLOW (sintético)", () => {
    const leitor = 'const read = (...p: string[]) => fs.readFileSync(path.resolve(repoRoot(), ...p), "utf8");\n';
    const bug60 = `${leitor}it("documenta o campo", () => { expect(read("SPEC.md")).toMatch(/local_test/); });`;
    expect(soltos("novo.test.ts", bug60)).toEqual(["novo.test.ts:SPEC.md"]);
    expect(soltos("novo.test.ts", bug60.replace("it(", "it.skipIf(!isUpstream())("))).toEqual([]);
    expect(soltos("novo.test.ts", bug60.replace("it(", "it.skipIf(!IS_UPSTREAM)("))).toEqual([]);
    expect(soltos("ci-contract.test.ts", bug60)).toEqual([]); // entrada de ALLOW
    expect(soltos("ci-contract.test.ts", `${leitor}read("Dockerfile");`)).toEqual(["ci-contract.test.ts:Dockerfile"]); // só o que a entrada lista
  });

  it("o detector lê as formas de raiz do hospedeiro e ignora o que é de aiteam/ ou de sandbox (sintético)", () => {
    expect(hostReads('const root = repoRoot();\nfs.readdirSync(path.join(root, ".github", "workflows"));')).toEqual([".github"]);
    expect(hostReads('const REPO = path.resolve(AITEAM, "..");\nreadFileSync(path.join(REPO, ".claude", "x.json"));')).toEqual([".claude"]);
    expect(hostReads('fs.readFileSync(path.resolve(repoRoot(), ".claude/settings.json"));')).toEqual([".claude"]);
    expect(hostReads('path.resolve(repoRoot(), "aiteam", "x"); path.join(sandbox, "SPEC.md"); path.join(aiteam, "hooks")')).toEqual([]);
  });
});
