// Tipos de beads-aggregate.mjs, na convenção src/*.d.mts (ver tier-core.d.mts).

import type { TaskStatus } from "./beads-core.d.mts";
import type { readTreeInputs } from "./beads-io.d.mts";

export const DEFAULT_SINCE_DAYS: 30;
export const DEFAULT_MAX_REFS: 50;
export const MAX_FILE_BYTES: number;

export interface WorktreeRecord {
  dir: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  prunable: boolean;
}
export function parseWorktreeList(text: string, sep: string): WorktreeRecord[];

export interface RefRecord {
  name: string;
  kind: "head" | "remote";
  branch: string;
  display: string;
  sha: string;
  ts: number;
}
export function parseRefList(text: string): RefRecord[];

export interface AggregateOptions {
  /** Janela, em dias, dos refs lidos (padrão 30). A branch de uma worktree ativa entra sempre. */
  sinceDays?: number;
  /** Teto de refs distintos lidos (padrão 50), fora os das worktrees ativas. */
  maxRefs?: number;
  /** Inclui refs/remotes (padrão: não). */
  remotes?: boolean;
  /** Prazo em ms: estourado, a leitura para e `partial` vem true. */
  deadlineMs?: number | null;
  /** Lista também as colisões de nome de branch (feat/x × feat-x). */
  collisions?: boolean;
  /** Reaproveita a leitura da árvore. */
  tree?: ReturnType<typeof readTreeInputs>;
  maxFileBytes?: number;
  nowMs?: number;
}

export interface AggregateState {
  status: TaskStatus | "inválido";
  stage: string | null;
  blockers: string[];
  updated_at: string | null;
}

export interface AggregateSource {
  /** `.beads/tasks/<id>/<arquivo>.yaml` */
  arquivo: string;
  tipo: "worktree" | "local" | "remoto";
  ref: string;
  sha7: string | null;
  nao_commitado: boolean;
  /** `<ref> (local <sha7>)`, `<ref> (worktree, não commitado)`… */
  origem: string;
}

export interface ElsewhereBead {
  id: string;
  title: string;
  /** O estado nesta árvore; null quando o bead é novo. */
  aqui: AggregateState | null;
  /** O estado combinado com o que as outras fontes trazem. */
  la: AggregateState & { status: TaskStatus };
  fontes: AggregateSource[];
}

export interface AggregateResult {
  /** Preenchido em modo legado e em HEAD sem commit: nada foi agregado. */
  skipped: string | null;
  partial: boolean;
  elsewhere: ElsewhereBead[];
  warnings: string[];
  stats: {
    refsListed: number;
    refsRead: number;
    /** Refs que ficaram fora da janela de dias. */
    refsOutOfWindow: number;
    /** Refs que passaram do teto de --max-refs. */
    refsOverLimit: number;
    /** Blobs de refs de fato lidos (o orçamento de leitura). */
    blobsRead: number;
    /** Blobs de refs maiores que o limite, nunca lidos. */
    blobsOversize: number;
    worktrees: number;
    ms: number;
  };
}

/** O que cada ref mudou nos beads, a partir do grafo (`rev-list --parents`) e do `log --name-only`. */
export function pathsByRef(shas: string[], revList: string, logText: string): Map<string, Set<string>>;

export function aggregate(root: string, opts?: AggregateOptions): AggregateResult;
export function cleanText(value: unknown, max?: number): string;
export function originOf(entry: ElsewhereBead): string;
export function elsewhereLine(entry: ElsewhereBead, opts?: { titleMax?: number }): string;
