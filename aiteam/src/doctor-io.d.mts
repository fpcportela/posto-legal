/** Os fatos do merge driver antigo que o doctor lê do repo (registro, .gitattributes, caminhos). */
export function readMergeDriverFacts(root: string): {
  driver: string | null;
  /** Caminhos do comando do driver registrado que não existem na raiz. */
  missing: string[];
  /** O .gitattributes tem uma linha de verdade `merge=beads-yaml`. */
  mapped: boolean;
  /** O .gitattributes cita `beads-yaml` fora do mapeamento (comentário). */
  cited: boolean;
};

/**
 * Os fatos que o checkUpstreamFlag pede ao I/O: os dois settings do .claude (null quando ausentes ou ilegíveis) e a URL
 * do `origin` (null quando não há). Nunca lança.
 */
export function readUpstreamFacts(root: string): { settings: object | null; local: object | null; origin: string | null };

/**
 * O que o tier-guard decide para um comando, rodado de verdade num processo filho com o payload de PreToolUse da
 * ferramenta dada: "deny" | "ask" | "allow", ou null quando o hook não respondeu (não existe, sem JSON, estourou o tempo).
 */
export function readTierGuardDecision(
  root: string,
  options: { hook: string; tool: string; command: string; timeoutMs?: number }
): "deny" | "ask" | "allow" | null;

/**
 * O que o gate-edit-guard decide para um Write no .claude/tier-rules.json da raiz, rodado de verdade num processo filho:
 * "ask" | "allow" | "deny", ou null quando o hook não respondeu. O hook só decide, não escreve. Nunca lança.
 */
export function readGateEditDecision(root: string, options: { hook: string; timeoutMs?: number }): "deny" | "ask" | "allow" | null;

/**
 * Sonda o crescimento do tempo de cada padrão do mapa num processo filho (scripts/regex-probe.mjs): o filho que
 * trava é morto no timeout e o padrão em andamento é nomeado em `hung`; a sondagem segue com os outros. Nunca lança.
 */
export function readTierRulesProbe(
  rules: unknown,
  options?: {
    /** Só os testes trocam o filho. */
    script?: string;
    /** Tempo de cada filho antes de ser morto. */
    timeoutMs?: number;
    /** Orçamento de toda a sondagem; o que sobra fica em `unprobed`. */
    totalMs?: number;
    probeOptions?: import("./regex-probe.d.mts").ProbeOptions;
  }
): import("./doctor-core.d.mts").TierRulesProbeFacts;

/**
 * O mapa de tiers do projeto (.claude/tier-rules.json) e a cópia canônica do framework
 * (aiteam/templates/tier-rules.json), lidos como o tier-guard os lê.
 */
export function readTierRulesFacts(
  root: string,
  options?: { templatePath?: string }
): {
  project: import("./tier-rules-loader.d.mts").TierRulesFile;
  canonical: import("./tier-rules-loader.d.mts").TierRulesFile;
};
