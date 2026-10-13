// Thin type declaration for session-brief-core.mjs, mirroring the src/*.d.mts
// convention (e.g. tier-core.d.mts) so aiteam/src/session-brief.test.ts can
// import the pure buildBrief() function with types under `tsc --noEmit`,
// without requiring `allowJs`.

/** O que o hook sabe e a visão não traz (aiteam/docs/beads-schema.md §7.1). */
export interface BriefContext {
  /** Branch atual, do git; null em HEAD destacado. */
  branch?: string | null;
  /** SHA curto, em HEAD destacado. */
  detachedSha?: string | null;
  /** Do frontmatter do SPEC.md. */
  project?: string;
  budgetUsd?: number;
  /** De .beads/session.local.json. */
  costUsd?: number;
  /** .beads/active.yaml do modelo antigo ainda rastreado. */
  legacy?: boolean;
  /** O que o agregador achou nas outras branches e worktrees (beads-aggregate.mjs); null se falhou. */
  elsewhere?: BriefElsewhere | null | undefined;
}

/** Um bead de outra branch, como o agregador o entrega (só estes campos entram no brief). */
export interface BriefElsewhereItem {
  id: string;
  title?: string;
  /** O estado nesta árvore; null quando o bead é novo. */
  aqui?: { status: string } | null;
  la?: { status: string };
  fontes: { origem: string; tipo: string }[];
}

export interface BriefElsewhere {
  elsewhere: BriefElsewhereItem[];
  /** O prazo estourou: o brief manda rodar `beads status`. */
  partial?: boolean;
  /** Modo legado ou HEAD sem commit: nada agregado. */
  skipped?: string | null;
}

/**
 * A linha do brief sobre a fonte das regras do tier-guard (resultado de loadTierRulesWithFallback): o aviso quando
 * vale a cópia canônica ou nenhuma regra, null quando vale o arquivo do projeto. Só texto fixo (LLM01).
 */
export function tierRulesLine(loaded: { source?: string; problem?: string | null } | null | undefined): string | null;

/** O prazo (ms) do agregador no brief; vazio, não numérico ou negativo vale o padrão (1500). */
export function deadlineFromEnv(raw: string | undefined | null, fallback?: number): number;

export function buildBrief(
  activeText: string | null,
  indexText: string | null,
  yamlLoad: (text: string) => unknown,
  ctx?: BriefContext
): string;
