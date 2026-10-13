import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { checkTierRules } from "./doctor-core.mjs";
import { isUpstream } from "./repo-root.js";
import { classifyTier, isAskEligibleTier3 } from "./tier-classifier.js";

// A cópia canônica do mapa de tiers que viaja com o vendor (aiteam/templates/).
// O .claude/tier-rules.json fica fora de aiteam/, então um adotante novo não o
// recebe junto: o install o semeia a partir deste template e o guard cai nele
// quando o arquivo do projeto falta ou não lê.

const HERE = path.dirname(fileURLToPath(import.meta.url)); // aiteam/src
const AITEAM = path.resolve(HERE, "..");
const REPO = path.resolve(AITEAM, "..");
const TEMPLATE = path.join(AITEAM, "templates", "tier-rules.json");
const ROOT_COPY = path.join(REPO, ".claude", "tier-rules.json");

// O upstream (rb-ai-team) é o único repo onde a raiz deve ser igual ao template.
// Num consumidor o .claude/tier-rules.json é DO PROJETO — customizado, com
// padrões locais — e a suíte do aiteam/ roda lá também; a igualdade falharia por
// uma propriedade do repo dele. O marcador do upstream (o manifesto do
// aiteam-sync) e o porquê estão em isUpstream, em repo-root.ts.
const IS_UPSTREAM = isUpstream(REPO);

// O índice do git guarda LF, mas um checkout no Windows (core.autocrlf=true) pode
// gravar CRLF na cópia de trabalho. O que se compara é o conteúdo.
const lf = (text: string): string => text.replace(/\r\n/g, "\n");

const template = (): Record<string, any> => JSON.parse(readFileSync(TEMPLATE, "utf8"));

describe("aiteam/templates/tier-rules.json — a cópia canônica do framework", () => {
  it("existe e é JSON legível", () => {
    expect(existsSync(TEMPLATE)).toBe(true);
    expect(() => template()).not.toThrow();
  });

  it("passa no mesmo check do doctor (bandas com padrões, todo padrão compila)", () => {
    const r = checkTierRules(template());
    expect(r.detail).toMatch(/compile/);
    expect(r.pass).toBe(true);
  });

  it("ask_patterns é subconjunto de tier3.patterns", () => {
    const rules = template();
    const union = new Set<string>(rules.tier3.patterns);
    for (const p of rules.tier3.ask_patterns ?? []) {
      expect(union.has(p), `ask_pattern fora da união: ${p}`).toBe(true);
    }
  });

  it("protege de verdade: nega o destrutivo e pede ASK no deploy", () => {
    const rules = template() as any;
    expect(classifyTier("prisma migrate reset", rules)).toBe(3);
    expect(isAskEligibleTier3("prisma migrate reset", rules)).toBe(false);
    expect(classifyTier("rm -rf /", rules)).toBe(3);
    expect(isAskEligibleTier3("rm -rf /", rules)).toBe(false);
    expect(isAskEligibleTier3("gh workflow run deploy.yml -f ref=v1", rules)).toBe(true);
  });

  // O padrão do push forçado vale por si, sem o piso fixo do tier-core (que também nega): `-f` sozinho ou agrupado e o
  // refspec com `+`, e não `--force-with-lease` nem `--force-if-includes`.
  describe("o padrão do push forçado (o piso do tier-core nega as mesmas formas, e mais)", () => {
    const pattern = (): RegExp => new RegExp(template().tier3.patterns.find((p: string) => p.includes("git\\s+push")), "i");

    it.each([
      "git push --force origin main",
      "git push origin main --force",
      "git push --force-with-lease --force origin x",
      "git push --mirror origin",
      "git push origin --mirror",
      "git push -f origin main",
      "git push origin main -f",
      "git push -uf origin x",
      "git push -fu origin x",
      "git push -vf origin x",
      "git push -u -f origin x",
      "git push origin +main",
      "git push origin +HEAD:main",
      'git push origin "+main"',
      "git push +main",
      "git push --force-with-lease origin +main",
    ])("%s → casa", (command) => {
      expect(pattern().test(command), command).toBe(true);
    });

    it.each([
      "git push",
      "git push origin main",
      "git push -u origin feat/x",
      "git push --force-with-lease",
      "git push --force-with-lease origin x",
      "git push --force-with-lease=main:abc origin x",
      "git push --force-if-includes",
      "git push --force-with-lease --force-if-includes origin x",
      "git push -o ci.skip origin x",
      "git push -ofix origin x",
      "git push origin feature/a+b",
      "git push origin feat/fix-it",
      "git push --follow-tags origin main",
      "git push --push-option=+x origin main",
      "git fetch -f origin",
      "git checkout -f main",
    ])("%s → não casa", (command) => {
      expect(pattern().test(command), command).toBe(false);
    });

    it("não está em ask_patterns: push forçado é deny, nunca ask", () => {
      const rules = template();
      expect(rules.tier3.ask_patterns.some((p: string) => p.includes("git\\s+push"))).toBe(false);
    });
  });

  it("o _comment diz qual dos dois arquivos é a fonte", () => {
    expect(template()._comment).toMatch(/which file is the source: aiteam\/templates\/tier-rules\.json/i);
  });

  // Só no upstream — ver IS_UPSTREAM. Num consumidor este teste é pulado, nunca falha.
  it.skipIf(!IS_UPSTREAM)("upstream: o .claude/tier-rules.json da raiz é igual ao template (edite o template e copie)", () => {
    expect(lf(readFileSync(ROOT_COPY, "utf8"))).toBe(lf(readFileSync(TEMPLATE, "utf8")));
  });
});
