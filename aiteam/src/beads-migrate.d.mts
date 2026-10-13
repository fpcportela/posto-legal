// Tipos de beads-migrate.mjs, na convenção src/*.d.mts (ver tier-core.d.mts).

import type { BeadsState } from "./beads-core.d.mts";
import type { RegenerationSummary } from "./beads-io.d.mts";

export const GITIGNORE_PATH: ".beads/.gitignore";
export const GITIGNORE: string;

export interface LegacySources {
  active: string | null;
  completed: string | null;
  index: string | null;
  mirrors: { name: string; text: string }[];
}

export interface MigrationReport {
  sources: { active: number; completed: number; mirrors: number; unreadableMirrors: { name: string; error: string }[] };
  duplicates: { id: string; kept: string; keptAt: string; dropped: string; droppedAt: string }[];
  outsideIndex: string[];
  indexOrphans: string[];
  mirrorOnly: { id: string; origin: string; status: string; date: string; alsoIn: string[] }[];
  recoverMirrors: boolean;
  unique: number;
  folders: number;
  withMirrors: number;
}

export interface MigrationPlan {
  errors: string[];
  report: MigrationReport;
  files: { path: string; text: string }[];
}

export function legacyInstant(value: unknown): number | null;
export function beadFileFromLegacy(node: Record<string, unknown>, createdMs: number, updatedMs: number): string;
export function planMigration(
  sources: LegacySources,
  opts: { as: string; recoverMirrors?: boolean; nowMs?: number }
): MigrationPlan;
export function formatReport(report: MigrationReport): string[];
export function readLegacySources(root: string, opts?: { fromWorktree?: boolean; rev?: string }): LegacySources;
export function hasLegacySources(sources: LegacySources): boolean;
export function migrationBlockers(root: string, opts?: { fromWorktree?: boolean }): string[];
export function applyMigration(root: string, plan: MigrationPlan, opts?: { nowMs?: number; env?: NodeJS.ProcessEnv }): RegenerationSummary;

export interface PortContext {
  state: BeadsState;
  ownFiles: Map<string, string>;
  filesOf(id: string): { branchFile: string; text: string }[];
}
export interface PortPlan {
  errors: string[];
  files: { path: string; text: string }[];
  created: string[];
  appended: string[];
  skipped: string[];
}
export function planPort(oldText: string, current: PortContext, opts: { as: string; nowMs?: number; label?: string }): PortPlan;
export function planPortFrom(
  sources: LegacySources,
  current: PortContext,
  opts: { as: string; nowMs?: number; label?: string; recoverMirrors?: boolean }
): PortPlan & { report: MigrationReport };
export function portContext(root: string, as: string, nowMs: number, opts?: { fromIndex?: boolean }): PortContext;
export function applyPort(root: string, portPlan: PortPlan, opts?: { regenerate?: boolean }): RegenerationSummary | null;
export function legacyMergeProblems(root: string, opts?: { nowMs?: number }): { errors: string[]; warnings: string[] };
export function legacyResidueProblems(root: string, opts?: { nowMs?: number }): { errors: string[]; warnings: string[] };
export function legacyPickProblems(root: string, opts?: { nowMs?: number }): { errors: string[]; warnings: string[] };
export function legacyRewriteProblems(root: string, opts?: { nowMs?: number }): { errors: string[]; warnings: string[] };

export interface HistoryCandidate {
  id: string;
  node: Record<string, unknown>;
  createdMs: number;
  updatedMs: number;
  commit: string;
  file: string;
  commitMs: number;
}
export interface HistoryScan {
  commits: number;
  versions: number;
  unreadable: string[];
  best: Map<string, HistoryCandidate>;
}
export function scanHistory(root: string, opts?: { rev?: string }): HistoryScan;
export function planScanHistory(
  scan: HistoryScan,
  current: PortContext,
  opts: { as: string; nowMs?: number }
): {
  plan: PortPlan;
  missing: HistoryCandidate[];
  ignored: (HistoryCandidate & { reason: string })[];
  newer: HistoryCandidate[];
};
