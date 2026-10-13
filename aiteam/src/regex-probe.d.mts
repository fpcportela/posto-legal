// Declaração de tipos para regex-probe.mjs, na convenção src/*.d.mts (ver
// tier-core.d.mts), para os .ts compilarem sob `tsc --noEmit` sem `allowJs`.

export interface ProbeOptions {
  /** Flags do RegExp; o tier-core compila com "i". */
  flags?: string;
  /** Tamanho do primeiro degrau da escada, em caracteres. */
  minSize?: number;
  /** Tamanho do último degrau. */
  maxSize?: number;
  /** Fator de crescimento entre degraus abaixo de `fineUntil` e logo depois de um degrau suspeito. */
  fineStep?: number;
  /** Até este tamanho a escada usa o passo fino. */
  fineUntil?: number;
  /** Fator de crescimento entre degraus acima de `fineUntil`. */
  step?: number;
  /** Uma medição acima disto reprova ("budget"). */
  budgetMs?: number;
  /** Abaixo disto o tempo é ruído e o crescimento entre degraus não vale. */
  floorMs?: number;
  /** Expoente local (log t / log n entre degraus) acima do qual um degrau conta como crescimento ruim. */
  maxDegree?: number;
  /** Quantos degraus seguidos acima de `maxDegree` reprovam ("growth"). */
  strikes?: number;
  /** O relógio: uma medição de `re.test(text)`, em ms. Só os testes o trocam. */
  timeOnce?: (re: RegExp, text: string) => number;
}

export interface AdversarialFamily {
  label: string;
  build: (size: number) => string;
}

export type ProbeResult =
  | { ok: true; skipped: string }
  | { ok: true; worstMs: number; worstSize: number; worstLabel: string }
  | { ok: false; reason: "budget" | "growth"; ms: number; size: number; label: string; previousMs: number };

export const PROBE_DEFAULTS: Readonly<Required<ProbeOptions>>;
/** As palavras literais do padrão, que as famílias adversárias usam. */
export function patternWords(source: string): string[];
/** As famílias de entradas adversárias de um padrão (prefixo + unidade repetida + sufixo). */
export function adversarialFamilies(source: string): AdversarialFamily[];
/** Mede o crescimento do tempo de um padrão numa escada de tamanhos; para no primeiro degrau que estoura. */
export function probePattern(source: string, options?: ProbeOptions): ProbeResult;
