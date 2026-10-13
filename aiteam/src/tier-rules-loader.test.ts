import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TEMPLATE_PATH,
  frameworkRulesNote,
  noRulesNote,
  loadTierRulesWithFallback,
  readTierRulesFile,
  tierRulesShapeProblem,
} from "./tier-rules-loader.mjs";
import { classifyTier, isAskEligibleTier3 } from "./tier-core.mjs";

// O guard e o classificador leem o mapa de tiers do projeto
// (.claude/tier-rules.json). Quando o arquivo falta ou não serve, eles usam a
// cópia canônica do framework (aiteam/templates/tier-rules.json) em vez de
// liberar tudo: este módulo é a única carga, para os dois nunca divergirem.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_TEMPLATE = path.join(HERE, "..", "templates", "tier-rules.json");

const PROJECT_RULES = {
  tier3: { label: "projeto", patterns: ["\\bmeu-marcador\\b"], ask_patterns: [] },
  tier2: { label: "projeto", patterns: [] },
};

let root = "";
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "tier-rules-loader-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const rulesFile = (): string => path.join(root, ".claude", "tier-rules.json");
function writeRules(text: string): void {
  mkdirSync(path.join(root, ".claude"), { recursive: true });
  writeFileSync(rulesFile(), text);
}

describe("tierRulesShapeProblem — o que o guard precisa para proteger", () => {
  it("aceita um mapa com tier3.patterns", () => {
    expect(tierRulesShapeProblem(PROJECT_RULES)).toBeNull();
  });

  it("tier2 não é exigido: o guard só decide por tier3 (abaixo de 3 tudo passa)", () => {
    expect(tierRulesShapeProblem({ tier3: { patterns: ["x"] } })).toBeNull();
  });

  it.each([
    ["null", null],
    ["texto", "tier3"],
    ["lista", []],
    ["objeto vazio", {}],
    ["tier3 que não é objeto", { tier3: "x" }],
    ["tier3 sem patterns", { tier3: {} }],
    ["tier3.patterns que não é lista", { tier3: { patterns: "x" } }],
    ["tier3.patterns vazio (não protege nada)", { tier3: { patterns: [] } }],
  ])("rejeita %s", (_label, value) => {
    expect(tierRulesShapeProblem(value)).toEqual(expect.any(String));
  });

  // Uma lista não vazia que o guard não consegue aplicar não protege nada: o
  // tier-core PULA o que não é texto e o que não compila (`new RegExp(p, "i")`),
  // e com todas as entradas puladas só o piso fixo sobra. Conta como válida só a
  // string que compila — a mesma semântica do tier-core — e com contagem 0 o
  // mapa não serve (o chamador cai na cópia canônica).
  describe("só conta o padrão que compila, como o tier-core", () => {
    const NENHUM = "tier3.patterns não tem nenhum padrão que compile";

    it.each([
      ["só padrões que não compilam", ["(", "[a-"]],
      ["só entradas que não são texto", [123]],
      ["nada de texto: número, null, objeto", [5, null, {}]],
      ["mistos sem nenhum válido", ["(", 5, "[a-", null]],
      ["lista vazia", []],
      // `""` compila e casa com tudo; o tier-core o pula, então não é um padrão que o guard aplique.
      ["só texto vazio ou só espaço", ["", "   "]],
    ])("%s → %j não serve", (_label, patterns) => {
      expect(tierRulesShapeProblem({ tier3: { patterns } })).toBe(NENHUM);
    });

    it.each([
      ["um válido e um inválido", ["(", "\\bdrop\\b"]],
      ["um válido entre entradas que não são texto", [5, null, "\\bdrop\\b"]],
      ["todos válidos", ["\\bdrop\\b", "vercel\\s+.*--prod\\b"]],
    ])("%s → %j continua sendo do projeto", (_label, patterns) => {
      expect(tierRulesShapeProblem({ tier3: { patterns } })).toBeNull();
    });

    it("a lista que não é lista continua com o motivo próprio", () => {
      expect(tierRulesShapeProblem({ tier3: { patterns: "x" } })).toBe("tier3.patterns não é uma lista");
    });
  });
});

describe("readTierRulesFile — um arquivo de regras, com o motivo quando não serve", () => {
  it("válido → as regras, sem problema", () => {
    writeRules(JSON.stringify(PROJECT_RULES));
    expect(readTierRulesFile(rulesFile())).toEqual({ rules: PROJECT_RULES, problem: null, detail: null });
  });

  it("arquivo ausente → missing", () => {
    const r = readTierRulesFile(rulesFile());
    expect(r.rules).toBeNull();
    expect(r.problem).toBe("missing");
  });

  it("pasta .claude ausente → missing também", () => {
    expect(readTierRulesFile(path.join(root, "nada", "aqui", "tier-rules.json")).problem).toBe("missing");
  });

  it("JSON inválido → unreadable, com o motivo", () => {
    writeRules("{ isso não é json");
    const r = readTierRulesFile(rulesFile());
    expect(r.rules).toBeNull();
    expect(r.problem).toBe("unreadable");
    expect(r.detail).toMatch(/JSON/);
  });

  it("arquivo vazio → unreadable", () => {
    writeRules("");
    expect(readTierRulesFile(rulesFile()).problem).toBe("unreadable");
  });

  it("estrutura inválida → unreadable, com o motivo", () => {
    writeRules(JSON.stringify({ tier3: { patterns: "x" } }));
    const r = readTierRulesFile(rulesFile());
    expect(r.problem).toBe("unreadable");
    expect(r.detail).toMatch(/tier3\.patterns/);
  });

  it("tier3.patterns sem nenhum padrão que compile → unreadable, com o motivo", () => {
    writeRules(JSON.stringify({ tier3: { patterns: ["(", "[a-"] }, tier2: { patterns: ["\\bgit\\b"] } }));
    const r = readTierRulesFile(rulesFile());
    expect(r.rules).toBeNull();
    expect(r.problem).toBe("unreadable");
    expect(r.detail).toContain("tier3.patterns não tem nenhum padrão que compile");
  });

  it("tier3.patterns com ao menos um padrão que compila → o arquivo é lido", () => {
    const rules = { tier3: { patterns: ["(", "\\bmeu\\b"] }, tier2: { patterns: [] } };
    writeRules(JSON.stringify(rules));
    expect(readTierRulesFile(rulesFile())).toEqual({ rules, problem: null, detail: null });
  });

  it("o caminho é uma pasta → unreadable (não é ausente: existe e não lê)", () => {
    mkdirSync(rulesFile(), { recursive: true });
    expect(readTierRulesFile(rulesFile()).problem).toBe("unreadable");
  });

  // Windows: o Set-Content -Encoding UTF8 do PowerShell 5 grava BOM, e o
  // JSON.parse recusa o BOM. Ler como válido é o certo: o projeto escreveu um
  // mapa legítimo, e cair na cópia canônica ignoraria os padrões dele.
  it("BOM no começo é tolerado", () => {
    writeRules("\uFEFF" + JSON.stringify(PROJECT_RULES));
    expect(readTierRulesFile(rulesFile()).rules).toEqual(PROJECT_RULES);
  });
});

describe("loadTierRulesWithFallback — projeto primeiro, cópia canônica do framework depois", () => {
  const canonical = (): any => JSON.parse(readFileSync(REAL_TEMPLATE, "utf8"));

  it("o TEMPLATE_PATH é o aiteam/templates/tier-rules.json, resolvido a partir do módulo", () => {
    expect(path.resolve(TEMPLATE_PATH)).toBe(path.resolve(REAL_TEMPLATE));
  });

  it("arquivo do projeto válido → usa o do projeto", () => {
    writeRules(JSON.stringify(PROJECT_RULES));
    expect(loadTierRulesWithFallback(root)).toEqual({ rules: PROJECT_RULES, source: "project", problem: null, detail: null });
  });

  it("arquivo ausente → a cópia canônica, problem missing", () => {
    const r = loadTierRulesWithFallback(root);
    expect(r.source).toBe("framework");
    expect(r.problem).toBe("missing");
    expect(r.rules).toEqual(canonical());
  });

  it("JSON inválido → a cópia canônica, problem unreadable", () => {
    writeRules("{ quebrado");
    const r = loadTierRulesWithFallback(root);
    expect(r.source).toBe("framework");
    expect(r.problem).toBe("unreadable");
    expect(r.rules).toEqual(canonical());
  });

  it("estrutura inválida → a cópia canônica, problem unreadable", () => {
    writeRules(JSON.stringify({ tier3: { patterns: [] } }));
    const r = loadTierRulesWithFallback(root);
    expect(r.source).toBe("framework");
    expect(r.problem).toBe("unreadable");
  });

  it.each([
    ["só padrões que não compilam", ["(", "[a-"]],
    ["só entradas que não são texto", [123]],
  ])("tier3.patterns %s → a cópia canônica, problem unreadable", (_label, patterns) => {
    writeRules(JSON.stringify({ tier3: { patterns }, tier2: { patterns: [] } }));
    const r = loadTierRulesWithFallback(root);
    expect(r.source).toBe("framework");
    expect(r.problem).toBe("unreadable");
    expect(r.rules).toEqual(canonical());
    expect(r.detail).toContain("tier3.patterns não tem nenhum padrão que compile");
  });

  it("um padrão que compila basta: o mapa continua sendo do projeto", () => {
    const own = { tier3: { patterns: ["(", "\\bmeu-marcador\\b"] }, tier2: { patterns: [] } };
    writeRules(JSON.stringify(own));
    expect(loadTierRulesWithFallback(root)).toEqual({ rules: own, source: "project", problem: null, detail: null });
  });

  it("template só com padrões que não compilam também vira source none", () => {
    const bad = path.join(root, "template-invalido.json");
    writeFileSync(bad, JSON.stringify({ tier3: { patterns: ["(", "[a-"] } }));
    const r = loadTierRulesWithFallback(root, { templatePath: bad });
    expect(r.rules).toBeNull();
    expect(r.source).toBe("none");
  });

  it("o fallback protege de verdade: nega o destrutivo e pede ASK no deploy", () => {
    const rules = loadTierRulesWithFallback(root).rules!;
    expect(classifyTier("rm -rf /", rules)).toBe(3);
    expect(isAskEligibleTier3("rm -rf /", rules)).toBe(false);
    expect(isAskEligibleTier3("npx prisma migrate deploy", rules)).toBe(true);
  });

  it("sem arquivo do projeto e sem template (framework quebrado) → source none, sem regras, com os dois motivos", () => {
    const r = loadTierRulesWithFallback(root, { templatePath: path.join(root, "nao-existe.json") });
    expect(r.rules).toBeNull();
    expect(r.source).toBe("none");
    expect(r.problem).toBe("missing");
    expect(r.detail).toMatch(/template|framework/i);
  });

  it("template ilegível também vira source none", () => {
    const bad = path.join(root, "template-quebrado.json");
    writeFileSync(bad, "{ nope");
    const r = loadTierRulesWithFallback(root, { templatePath: bad });
    expect(r.rules).toBeNull();
    expect(r.source).toBe("none");
  });

  it("com o arquivo do projeto válido o template nem é lido", () => {
    writeRules(JSON.stringify(PROJECT_RULES));
    const r = loadTierRulesWithFallback(root, { templatePath: path.join(root, "nao-existe.json") });
    expect(r.source).toBe("project");
  });
});

describe("frameworkRulesNote — o sufixo do motivo quando o guard usa a cópia canônica", () => {
  it("arquivo ausente", () => {
    expect(frameworkRulesNote("missing")).toBe(
      " (regras do framework: .claude/tier-rules.json ausente — rode node aiteam/install.mjs)"
    );
  });

  // O último recurso (nem a cópia canônica serve): o guard segue com regras
  // vazias e só o piso fixo do tier-core (rm -rf, force-push) protege.
  it("noRulesNote: o sufixo do último recurso diz que só vale o piso fixo e como consertar", () => {
    expect(noRulesNote("missing")).toBe(
      " (sem regras: .claude/tier-rules.json ausente e a cópia canônica do framework também não serve — só vale o piso fixo (rm -rf e force-push); restaure o aiteam/ e rode node aiteam/install.mjs)"
    );
    expect(noRulesNote("unreadable")).toBe(
      " (sem regras: .claude/tier-rules.json ilegível e a cópia canônica do framework também não serve — só vale o piso fixo (rm -rf e force-push); restaure o aiteam/ e rode node aiteam/install.mjs)"
    );
  });

  // O install nunca sobrescreve o arquivo do projeto: para o ilegível, "rode o
  // install" sozinho não conserta nada. Quem lê o motivo precisa saber que é
  // corrigir ou apagar o arquivo primeiro.
  it("arquivo ilegível: mandar rodar o install só vale depois de corrigir ou apagar o arquivo", () => {
    expect(frameworkRulesNote("unreadable")).toBe(
      " (regras do framework: .claude/tier-rules.json ilegível — corrija-o ou apague-o e rode node aiteam/install.mjs)"
    );
  });
});
