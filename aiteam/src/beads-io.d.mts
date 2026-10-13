// Tipos de beads-io.mjs, na convenção src/*.d.mts (ver tier-core.d.mts).

import type { BeadInput, BeadsState, ProjectInput } from "./beads-core.d.mts";

export const LOCAL_SESSION_PATH: ".beads/session.local.json";
export const LEGACY_HINT: string;

export interface GitResult<T = string> {
  status: number;
  stdout: T;
  stderr: string;
}

export function git(root: string, args: string[], opts?: { input?: string; buffer?: false; timeout?: number }): GitResult;
export function git(root: string, args: string[], opts: { input?: string; buffer: true; timeout?: number }): GitResult<Buffer>;
export function gitTopLevel(cwd: string): string | null;
export function currentBranch(root: string): { branch: string; sha: null } | { branch: null; sha: string | null };
export function isTracked(root: string, rel: string, opts?: { timeout?: number }): boolean;
export function isLegacy(root: string, opts?: { timeout?: number }): boolean;
export function catFiles(root: string, names: string[], opts?: { timeout?: number }): Map<string, string | null>;
/**
 * O tamanho de vários blobs sem lê-los (`cat-file --batch-check`): nome → bytes, ou
 * null se ausente, se não é blob ou se o nome tem caractere de controle. `diag` recebe
 * o stderr do git quando ele reclama de um objeto sem falhar (objeto corrompido).
 */
export function catSizes(root: string, names: string[], opts?: { timeout?: number; diag?: string[] }): Map<string, number | null>;
export function stagedChanges(root: string): { status: string; path: string }[];
export function indexPaths(root: string, specs: string[]): string[];

export type BeadsPathClass =
  | { kind: "task"; id: string; branchFile: string }
  | { kind: "project"; branchFile: string }
  | { kind: "outside" | "stray" | "view" | "backup" | "local" | "archive" | "mirror" | "free" | "other" };
export function classifyBeadsPath(rel: string): BeadsPathClass;
export function ownPathFor(c: BeadsPathClass, branchFile: string): string;

export function readTreeInputs(root: string): { beads: BeadInput[]; project: ProjectInput[]; strays: string[] };
/** Os ids (nomes de pasta) de `.beads/tasks/`, sem ler nenhum arquivo. */
export function listBeadIds(root: string): string[];
/** Os arquivos `<branch>.yaml` de um bead, lidos do disco. */
export function readBeadFiles(root: string, id: string): { branchFile: string; text: string }[];
export function readIndexInputs(root: string): { beads: BeadInput[]; project: ProjectInput[]; strays: string[] };
export function legacyResidue(root: string): string[];
export function leftoverHint(p: string): string;
export function nowFromEnv(env?: NodeJS.ProcessEnv): number;
export function readSpecMeta(root: string, env?: NodeJS.ProcessEnv): { project: string; budgetUsd: number };
export function readLocalSession(root: string): { costUsd: number; circuitOpen: boolean };
export function writeFileAtomic(target: string, content: string): void;

export interface ViewWrite {
  rel: string;
  action: "wrote" | "unchanged" | "failed";
  backup?: string | null;
  error?: string;
}
export interface RegenerationSummary {
  legacy?: boolean;
  removed?: string[];
  skipped?: string;
  state?: BeadsState;
  strays?: string[];
  results: ViewWrite[];
}
export function regenerateViews(root: string, opts?: { nowMs?: number; env?: NodeJS.ProcessEnv }): RegenerationSummary;
export function describeRegeneration(
  summary: RegenerationSummary,
  opts?: { quiet?: boolean; merge?: boolean }
): { loud: string[]; info: string[] };

export interface CheckResult {
  legacy?: boolean;
  state?: BeadsState;
  errors: string[];
  warnings: string[];
  checked?: number;
}
export function checkAll(root: string, opts?: { nowMs?: number; env?: NodeJS.ProcessEnv }): CheckResult;
export function checkStaged(
  root: string,
  branch: string,
  /** merge: commit de merge ou squash — só a regra de dono fica isenta. */
  opts?: { nowMs?: number; env?: NodeJS.ProcessEnv; merge?: boolean }
): CheckResult;
