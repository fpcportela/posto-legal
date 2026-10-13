export interface CheckResult {
  name: string;
  pass: boolean;
  /** Passed, but with a non-fatal hazard worth surfacing (e.g. absolute core.hooksPath). */
  warn?: boolean;
  detail?: string;
}

export interface Summary {
  pass: boolean;
  total: number;
  passed: number;
  failed: number;
}

export function checkSettings(settings: unknown): CheckResult;
export function checkInfraKbGuardSettings(settings: unknown): CheckResult;
/** F13: aiteam/hooks/gate-edit-guard.mjs is a PreToolUse hook for Write, Edit, MultiEdit and NotebookEdit. */
export function checkGateEditGuardSettings(settings: unknown): CheckResult;
/** F13: the live sample — the hook answers "ask" to a Write to .claude/tier-rules.json (null = it did not answer). */
export function checkGateEditSample(input: { decision: "ask" | "allow" | "deny" | null }): CheckResult;
/**
 * AITEAM_UPSTREAM=1 in the `env` of .claude/settings.json or settings.local.json switches off the ask on edits of the
 * gate's own code and belongs only to the rb-ai-team repo. null when it is off; a PASS when on with an rb-ai-team
 * origin; a WARN (non-fatal) when on with another origin or none.
 */
export function checkUpstreamFlag(input: { settings: unknown; local: unknown; origin: string | null }): CheckResult | null;
export function checkMcp(mcp: unknown): CheckResult;
/** AGENTS.md §CI/CD Mandate item 1: the PR pipeline runs what SPEC.md declares in `ci:` (ci-contract-core.mjs). */
export function checkCiContract(input: {
  specText: string | null | undefined;
  /** Parsed .github/workflows files; null when they could not be parsed. */
  workflows: readonly { file: string; doc?: unknown; error?: string }[] | null;
  /** The `scripts` of <dir>/package.json (relative to the repo root), or null when there is none. */
  readScripts?: (dir: string) => Record<string, unknown> | null | undefined;
  /** Why the workflows could not be parsed (e.g. no js-yaml); the workflow lookup degrades to WARN. */
  workflowsUnavailable?: string | null;
  /** App manifests found at the repo root (isAppManifest); with one, a ci.workdir inside aiteam/ fails. */
  rootManifests?: readonly string[];
}): CheckResult;
/** AGENTS.md §CI/CD Mandate: the workflow SPEC.md declares in `deploy:` takes a ref, checks the version, tags deploy/ (deploy-contract-core.mjs). */
export function checkDeployContract(input: {
  specText: string | null | undefined;
  /** Parsed .github/workflows files; null when they could not be parsed. */
  workflows: readonly { file: string; doc?: unknown; error?: string }[] | null;
  /** The text of a repo file (path relative to the repo root), or null when there is none. */
  readFile?: (rel: string) => string | null | undefined;
  /** Why the workflows could not be parsed (e.g. no js-yaml); the workflow check degrades to WARN. */
  workflowsUnavailable?: string | null;
}): CheckResult;
/**
 * The map is well-formed the way the guard reads it: both bands carry patterns, every entry compiles and is not blank,
 * and tier3.ask_patterns ⊆ tier3.patterns (an ask pattern outside patterns never fires). A present ask_patterns with
 * nothing the guard can apply fails (no deploy can ask); an absent one is the legacy fail-closed mode, not flagged here.
 */
export function checkTierRules(rules: unknown): CheckResult;

/** A leitura de um arquivo de regras (readTierRulesFacts em doctor-io.mjs). */
export interface TierRulesFileFacts {
  rules: unknown;
  /** "missing" não existe; "unreadable" existe e não lê, não é JSON ou tem estrutura inválida; null serve. */
  problem: "missing" | "unreadable" | null;
  detail: string | null;
}
/**
 * .claude/tier-rules.json do projeto: ausente ou ilegível → FAIL dizendo que o guard usa a cópia canônica do
 * framework (aiteam/templates/tier-rules.json); sem nem ela → FAIL dizendo que o guard está só com o piso fixo
 * (rm -rf e force-push negados; drop table e deploy passam).
 * Legível → o check de sempre (checkTierRules).
 */
export function checkTierRulesFile(facts: { project: TierRulesFileFacts; canonical: TierRulesFileFacts }): CheckResult;
/**
 * WARN com a lista dos tier3.patterns e tier3.ask_patterns da cópia canônica que faltam no arquivo do projeto
 * (string exata); null quando não há o que comparar (o arquivo do projeto não serve).
 */
export function checkTierRulesCoverage(facts: { project: TierRulesFileFacts; canonical: TierRulesFileFacts }): CheckResult | null;
/** Um padrão do mapa de tiers e os lugares do arquivo onde ele mora (`tier3.patterns[3]`, `tier3.deny_hints[0].match`...). */
export interface TierRulesPatternEntry {
  source: string;
  where: string[];
}
/** O resultado da sondagem de ReDoS dos padrões (readTierRulesProbe em doctor-io.mjs). */
export interface TierRulesProbeFacts {
  /** Quantos padrões a sondagem terminou. */
  probed: number;
  findings: Array<TierRulesPatternEntry & { reason: "budget" | "growth"; ms: number; size: number; label: string; previousMs?: number }>;
  /** Padrões que travaram o filho da sondagem até o timeout. */
  hung: TierRulesPatternEntry[];
  /** Padrões que ficaram sem sondar por falta de tempo. */
  unprobed: TierRulesPatternEntry[];
  /** Por que a sondagem nem rodou; null quando rodou. */
  error: string | null;
}
/** As ferramentas de comando com que o doctor amostra o tier-guard de verdade (o hook despacha pelo nome da ferramenta). */
export const TIER_GUARD_SAMPLE_TOOLS: readonly ["Bash", "PowerShell"];
/**
 * Uma amostra do hook vivo: o mesmo comando, rodado em cada ferramenta de TIER_GUARD_SAMPLE_TOOLS, tem de receber a
 * decisão esperada. `decisions` mapeia a ferramenta ao que o hook respondeu (null = não respondeu). FAIL nomeia a ferramenta.
 */
export function checkTierGuardSample(input: {
  expected: "deny" | "ask";
  command: string;
  decisions: Record<string, string | null>;
}): CheckResult;
/** Padrões antigos da cópia canônica, trocados por serem catastróficos → o padrão que a canônica tem no lugar. */
export const LEGACY_PATTERN_REPLACEMENTS: Readonly<Record<string, string>>;
/** Todo padrão que o guard roda, uma vez cada, com onde ele mora no arquivo. */
export function tierRulesPatternEntries(rules: unknown): TierRulesPatternEntry[];
/**
 * WARN (nunca FAIL) com o padrão catastrófico NOMEADO e o que pôr no lugar dele; null quando não há arquivo do
 * projeto para sondar. A sondagem não rodar, ou não chegar a todos os padrões, também é WARN — nunca verde.
 */
export function checkTierRulesRegexSafety(facts: { project: TierRulesFileFacts; probe: TierRulesProbeFacts }): CheckResult | null;
/**
 * SPEC.md spells `allow_tier3: true` in its frontmatter but the guard's line reader reads false (a quoted string across
 * lines, a value that continues on the next line, a tab, a duplicated block...): the break-glass is silently OFF. WARN
 * with the reason; null when the text does not say true, or the guard agrees with it.
 */
export function checkAllowTier3Reading(input: { specText: string | null | undefined }): CheckResult | null;
export function checkHooksPath(
  hooksPath: string,
  /** Host hooks found carrying the chain line (router topology). Caller does the I/O. */
  chainedHooks?: readonly string[],
  /** The full roster expected to be chained — lets a partial chain warn. */
  expectedHooks?: readonly string[]
): CheckResult;
export function checkBeadsValidation(r: {
  toolchainPresent: boolean;
  status: number | null;
  output: string;
}): CheckResult;
/** Modo legado do .beads (active.yaml do modelo antigo ainda rastreado) vira WARN. */
export function checkBeadsModel(input: { legacy: boolean }): CheckResult;
/**
 * Resíduo merge.beads-yaml no .git/config compartilhado vira WARN. Só reprova o
 * legado que ainda mapeia .beads/*.yaml para o driver (`mapped`) e perdeu o
 * script; migrado + mapeia + script ausente é WARN.
 */
export function checkMergeDriverResidue(input: {
  driver: string | null;
  legacy: boolean;
  missing?: string[];
  /** O .gitattributes ainda mapeia .beads/*.yaml para o driver — ver gitattributesMapsDriver. */
  mapped?: boolean;
  /** O .gitattributes ainda cita `beads-yaml` fora do mapeamento (comentário) — ver gitattributesCitesDriver. */
  cited?: boolean;
}): CheckResult;
/** O .gitattributes tem uma linha de verdade (não comentário) com merge=beads-yaml? */
export function gitattributesMapsDriver(text: string | null | undefined): boolean;
/** O .gitattributes cita `beads-yaml` em linha que não é o mapeamento? O contract test reprova esse texto. */
export function gitattributesCitesDriver(text: string | null | undefined): boolean;
export function driverPaths(driver: string | null | undefined): string[];
/** beads-guard ausente do PreToolUse Write|Edit vira WARN (acelerador opcional). */
export function checkBeadsGuardSettings(settings: unknown): CheckResult;
export function checkInfraKb(input: {
  pointer: { remote: string; url: string | null; ref: string; entry: string } | null;
  remoteExists: boolean | null;
  ageDays: number | null;
  /** Set when infra_kb is DECLARED but unusable (not absent) — see diagnosePointer in infra-kb-core.mjs. */
  malformedReason?: string | null;
}): CheckResult;
export function summarize(results: { name?: string; pass: boolean }[]): Summary;
