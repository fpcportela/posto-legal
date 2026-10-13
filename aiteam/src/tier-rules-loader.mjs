// Carga do mapa de tiers — a ÚNICA, para o tier-guard (aiteam/hooks/tier-guard.mjs)
// e para o classificador tipado (aiteam/src/tier-classifier.ts) nunca divergirem.
//
// O mapa do projeto é .claude/tier-rules.json, fora de aiteam/: não viaja com o
// vendor. Antes, sem ele (adotante novo, arquivo apagado) ou com JSON inválido, o
// guard liberava TUDO — `rm -rf`, `drop` e deploy passavam sem pergunta. Agora:
//
//   1. o arquivo do projeto, se existe e é estruturalmente válido;
//   2. senão, a cópia canônica do framework (aiteam/templates/tier-rules.json),
//      resolvida a partir DESTE módulo e não do cwd — o guard roda com o cwd do
//      Claude Code, e o vendor mora onde o módulo mora;
//   3. senão (framework quebrado), nenhuma regra: `rules` é null e o chamador
//      decide. O tier-guard segue o fluxo normal com regras vazias ({}): só vale
//      o piso fixo do tier-core (`rm -rf` e `git push --force` negados). Nem nega
//      tudo (travaria o conserto: git checkout, node aiteam/install.mjs) nem
//      libera tudo — decisão do PO.
//
// Sem dependências (só node:* e o tier-core.mjs, ele mesmo sem dependências) e
// sem shebang: o hook roda em node puro, sem node_modules, e importa este módulo
// (mesma separação de tier-core.mjs/tier-guard.mjs).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { countCompilablePatterns } from "./tier-core.mjs";

/** A cópia canônica do framework: aiteam/templates/tier-rules.json. */
export const TEMPLATE_PATH = fileURLToPath(new URL("../templates/tier-rules.json", import.meta.url));

/**
 * Por que um valor já parseado não serve como mapa de tiers; null quando serve.
 * Só pede o que o guard precisa para PROTEGER: `tier3.patterns` como lista com ao
 * menos um padrão que ele consiga aplicar. Conta como padrão só a string não vazia
 * (nem só espaço) que compila com `new RegExp(p, "i")` — a mesma semântica do
 * tier-core, que PULA o resto (countCompilablePatterns). Com contagem 0 (lista vazia, só texto que não
 * compila, só entradas que não são texto) o guard teria só o piso fixo, então o
 * mapa não serve e o chamador cai na cópia canônica. Um padrão inválido ao lado de
 * um válido é problema de uma entrada, que o guard pula e o doctor nomeia
 * (checkTierRules). O tier2 não entra: abaixo do Tier 3 o guard libera de qualquer jeito.
 */
export function tierRulesShapeProblem(rules) {
  if (rules === null || typeof rules !== "object" || Array.isArray(rules)) return "a raiz não é um objeto";
  const tier3 = rules.tier3;
  if (tier3 === null || typeof tier3 !== "object" || Array.isArray(tier3)) return "tier3 ausente ou não é um objeto";
  if (!Array.isArray(tier3.patterns)) return "tier3.patterns não é uma lista";
  if (countCompilablePatterns(tier3.patterns) === 0) return "tier3.patterns não tem nenhum padrão que compile";
  return null;
}

/**
 * Lê um arquivo de regras. `problem` é "missing" quando o arquivo não existe e
 * "unreadable" quando existe e não serve (não lê, não é JSON ou a estrutura é
 * inválida); `detail` diz o motivo. Um BOM no começo é tolerado: o
 * Set-Content -Encoding UTF8 do PowerShell 5 o grava, e cair na cópia canônica
 * por isso ignoraria os padrões do projeto.
 *
 * @param {string} file
 * @returns {{rules: object|null, problem: "missing"|"unreadable"|null, detail: string|null}}
 */
export function readTierRulesFile(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") {
      return { rules: null, problem: "missing", detail: `${file} não existe` };
    }
    return { rules: null, problem: "unreadable", detail: `${file} não lê: ${e?.message ?? e}` };
  }
  let rules;
  try {
    rules = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (e) {
    return { rules: null, problem: "unreadable", detail: `${file} não é JSON válido: ${e?.message ?? e}` };
  }
  const shape = tierRulesShapeProblem(rules);
  if (shape) return { rules: null, problem: "unreadable", detail: `${file} tem estrutura inválida: ${shape}` };
  return { rules, problem: null, detail: null };
}

/**
 * O mapa que o guard e o classificador usam: `{rules, source, problem, detail}`.
 *
 *  - source "project": o arquivo do projeto serviu (problem e detail são null).
 *  - source "framework": o arquivo do projeto falta ou não serve (`problem`:
 *    "missing" | "unreadable", `detail` com o motivo) e `rules` é a cópia canônica.
 *  - source "none": nem a cópia canônica serve — `rules` é null, `problem` é o
 *    do arquivo do projeto e `detail` diz os dois motivos.
 *
 * @param {string} repoRoot raiz do projeto (onde fica .claude/)
 * @param {{templatePath?: string}} [options] só os testes trocam o template
 */
export function loadTierRulesWithFallback(repoRoot, { templatePath = TEMPLATE_PATH } = {}) {
  const project = readTierRulesFile(path.resolve(repoRoot, ".claude", "tier-rules.json"));
  if (project.rules) return { rules: project.rules, source: "project", problem: null, detail: null };

  const framework = readTierRulesFile(templatePath);
  if (framework.rules) {
    return { rules: framework.rules, source: "framework", problem: project.problem, detail: project.detail };
  }
  return {
    rules: null,
    source: "none",
    problem: project.problem,
    detail: `${project.detail}; e a cópia canônica do framework também não serve (${framework.detail})`,
  };
}

/**
 * O sufixo que o guard acrescenta ao motivo do deny/ask quando usa a cópia
 * canônica. Para o arquivo ilegível ele manda corrigir ou apagar antes do
 * install: o install nunca sobrescreve o arquivo do projeto, então "rode o
 * install" sozinho não conserta um arquivo que existe.
 *
 * @param {"missing"|"unreadable"|null} problem
 */
export function frameworkRulesNote(problem) {
  const fix = problem === "unreadable" ? "corrija-o ou apague-o e rode node aiteam/install.mjs" : "rode node aiteam/install.mjs";
  const state = problem === "unreadable" ? "ilegível" : "ausente";
  return ` (regras do framework: .claude/tier-rules.json ${state} — ${fix})`;
}

/**
 * O sufixo do motivo quando nem a cópia canônica serve (source "none"): o guard
 * segue com regras vazias e só o piso fixo do tier-core protege.
 *
 * @param {"missing"|"unreadable"|null} problem o problema do arquivo do projeto
 */
export function noRulesNote(problem) {
  const state = problem === "unreadable" ? "ilegível" : "ausente";
  return (
    ` (sem regras: .claude/tier-rules.json ${state} e a cópia canônica do framework também não serve — ` +
    `só vale o piso fixo (rm -rf e force-push); restaure o aiteam/ e rode node aiteam/install.mjs)`
  );
}
