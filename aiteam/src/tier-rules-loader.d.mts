import type { TierRules } from "./tier-core.d.mts";

/** Por que o arquivo do projeto não serve: "missing" não existe, "unreadable" existe e não lê/não é JSON/estrutura inválida. */
export type TierRulesProblem = "missing" | "unreadable";

/** De onde vieram as regras: o projeto, a cópia canônica do framework, ou de lugar nenhum (framework quebrado). */
export type TierRulesSource = "project" | "framework" | "none";

export interface TierRulesFile {
  rules: TierRules | null;
  problem: TierRulesProblem | null;
  detail: string | null;
}

export interface LoadedTierRules {
  /** null só com source "none". */
  rules: TierRules | null;
  source: TierRulesSource;
  /** O problema do arquivo do projeto; null com source "project". */
  problem: TierRulesProblem | null;
  detail: string | null;
}

/** Caminho da cópia canônica do framework (aiteam/templates/tier-rules.json), resolvido a partir do módulo. */
export const TEMPLATE_PATH: string;

/** Por que o valor já parseado não serve como mapa de tiers (tier3.patterns lista não vazia); null quando serve. */
export function tierRulesShapeProblem(rules: unknown): string | null;

/** Lê um arquivo de regras, tolerando BOM; diz o motivo quando não serve. */
export function readTierRulesFile(file: string): TierRulesFile;

/** O mapa do projeto, ou a cópia canônica do framework quando ele falta ou não serve. */
export function loadTierRulesWithFallback(repoRoot: string, options?: { templatePath?: string }): LoadedTierRules;

/** O sufixo do motivo do deny/ask quando o guard usa a cópia canônica. */
export function frameworkRulesNote(problem: TierRulesProblem | null): string;

/** O sufixo do motivo quando nem a cópia canônica serve: o guard segue com regras vazias e só o piso fixo protege. */
export function noRulesNote(problem: TierRulesProblem | null): string;
