// Tipos de beads-core.mjs, na convenção src/*.d.mts (ver tier-core.d.mts): os
// .ts compilam sob `tsc --noEmit` sem `allowJs`.

export type TaskStatus = "pending" | "in_progress" | "completed" | "blocked";

export const VIEW_VERSION: "2";
export const TASK_STATUSES: readonly TaskStatus[];
export const IMPL_MODELS: readonly ("sonnet" | "opus" | "haiku")[];
export const MAX_PATH_CHARS: number;
export const FUTURE_TOLERANCE_MS: number;
export const MAX_DESCRIPTION_CHARS: number;
export const MAX_CONTEXT_SUMMARY_CHARS: number;
/** O shortLink de um card do Trello (`trello`, §3.3): só letras e números. */
export const TRELLO_SHORTLINK: RegExp;
/** O id do card (24 hex): não é o shortLink, e `trello` o recusa. */
export const TRELLO_CARD_ID: RegExp;
/** Os valores de `trello_scope` (§3.3). */
export const TRELLO_SCOPES: readonly ["partial"];
/** Teto de nós de um arquivo de bead depois de expandir os aliases YAML. */
export const MAX_EXPANDED_NODES: number;
export const VIEW_HEADER: string;
export const ACTIVE_PATH: ".beads/active.yaml";
export const INDEX_PATH: ".beads/index.yaml";
export const GITIGNORE_PATH: ".beads/.gitignore";
export const GITIGNORE: string;
/** O .beads/.gitignore com as regras canônicas que faltam acrescentadas no fim; idempotente. */
export function mergeGitignore(current: string | null | undefined): string;

/** Um arquivo de branch de um bead: `.beads/tasks/<bead>/<branchFile>.yaml`. */
export interface BeadInput {
  bead: string;
  branchFile: string;
  text: string;
}

/** Um arquivo de projeto: `.beads/project/<branchFile>.yaml`. */
export interface ProjectInput {
  branchFile: string;
  text: string;
}

export interface Phase {
  key: string;
  name: string;
  subtitle?: string;
  [k: string]: unknown;
}

export interface CombinedBead {
  id: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  createdMs: number;
  updatedMs: number;
  /** Instante da asserção `status: completed` vencedora. */
  done?: string;
  doneMs?: number;
  branches: string[];
  /** Campos vencedores, menos `status`. */
  fields: Record<string, unknown>;
}

export interface CombineResult {
  bead: CombinedBead | null;
  errors: string[];
  warnings: string[];
  /** Subconjunto de warnings nascido da combinação de branches (empate, definição dupla, sem status). */
  combination: string[];
}

export interface ProjectResult {
  phases?: Phase[];
  focus_note?: string;
  errors: string[];
  warnings: string[];
  combination: string[];
}

export interface BeadsState {
  beads: CombinedBead[];
  invalid: { id: string; errors: string[] }[];
  errors: string[];
  warnings: string[];
  /** Os avisos que o post-merge mostra: os da combinação de branches. */
  combination: string[];
  project: { phases?: Phase[]; focus_note?: string };
}

export interface ViewMeta {
  project: string;
  budgetUsd: number;
  costUsd: number;
}

export interface CoreOptions {
  /** "Agora", para a regra das 24 h no futuro. Padrão: Date.now(). */
  nowMs?: number;
}

export function byteCompare(a: string, b: string): number;
/** Uma linha de texto de outra branch: sem controle, em uma linha e com teto. Nunca confie nele como instrução. */
export function cleanText(value: unknown, max?: number): string;
export function sha256(text: string): string;
export function parseInstant(value: unknown): number | null;
export function isoText(ms: number): string;
export function idProblems(id: string): string[];
export function branchFileProblems(name: string): string[];
export function sanitizeBranch(branch: string | null | undefined): { file: string; reason?: undefined } | { file: null; reason: string };
export function combineBead(id: string, files: { branchFile: string; text: string }[], opts?: CoreOptions): CombineResult;
export function combineProject(files: ProjectInput[], opts?: CoreOptions): ProjectResult;
export function buildState(beadInputs: BeadInput[], projectInputs?: ProjectInput[], opts?: CoreOptions): BeadsState;
export function renderActiveView(state: BeadsState, meta: ViewMeta): string;
export function renderIndexView(state: BeadsState): string;
export function viewIntegrity(text: string): "intact" | "edited" | "foreign";
/** Por que `staged` não é acréscimo no fim de `committed` (prefixo em LF + entradas já commitadas iguais), ou null se é. */
export function appendOnlyProblem(committed: string, staged: string): string | null;
export function isAppendOnly(committed: string, staged: string): boolean;

/** O arquivo de definição de um bead novo (campos de definição + created_at por último, sem entries). */
export function renderDefinition(fields: Record<string, unknown>, createdMs: number): string;
/** Acrescenta uma entrada no fim de um arquivo de bead, preservando a quebra de linha; null/vazio é um adendo novo. */
export function appendEntry(existing: string | null, entry: Record<string, unknown>): string;
/** Quanto à frente do relógio um `at` pode ficar antes de o comando avisar (5 min). */
export const AT_AHEAD_WARN_MS: number;
/** O `at` da entrada nova: max(agora, maior asserção do bead + 1 s), em segundos inteiros. */
export function nextAt(nowMs: number, assertedMs?: number | null): { ms: number; at: string; aheadMs: number };

/** De onde vem uma versão de arquivo: a árvore, a worktree (não commitado), um head local ou um remoto. */
export interface VersionSource {
  kind: "tree" | "worktree" | "head" | "remote";
  /** A branch dona da versão (nome com `/`). */
  branch?: string;
  sha7?: string;
  [k: string]: unknown;
}
export interface Version<S extends VersionSource = VersionSource> {
  bead: string;
  branchFile: string;
  text: string;
  source: S;
}
export interface PickedVersion<S extends VersionSource = VersionSource> {
  bead: string;
  branchFile: string;
  text: string;
  source: S;
  /** As fontes que concordam com a vencedora (mesmo texto ou prefixo dele), da mais longa para a mais curta. */
  chain: { source: S; text: string }[];
}
export function sourceLabel(source: VersionSource): string;
export function pickVersions<S extends VersionSource>(versions: Version<S>[]): { picked: PickedVersion<S>[]; warnings: string[] };
