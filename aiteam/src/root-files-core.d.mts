// Declaração de tipos para root-files-core.mjs, na convenção src/*.d.mts (ver
// tier-core.d.mts), para os .ts compilarem sob `tsc --noEmit` sem `allowJs`.

import type { CheckResult } from "./doctor-core.d.mts";

export const UPSTREAM_REMOTE: string;
export const UPSTREAM_BRANCHES: readonly string[];
export const MARKER_PATH: string;
export const STALE_DAYS: number;

/** Um arquivo de raiz que o framework distribui: o caminho no consumidor e a fonte no upstream. */
export interface RootFile {
  path: string;
  upstream: readonly string[];
}
export const ROOT_FILES: readonly RootFile[];
/** Os caminhos, no upstream, que o `git log` de "o que mudou na raiz" examina. */
export const ROOT_SOURCES: readonly string[];

export type UpstreamMarker = { state: "absent" } | { state: "malformed" } | { state: "ok"; commit: string; date: string | null };
/** O apontador do .beads/SCHEMA.md tem de estar nestas primeiras linhas. */
export const SCHEMA_POINTER_LINES: number;
/** Com tantos títulos numerados (## 1., ### 2.1) o arquivo é a cópia do contrato, não o apontador. */
export const SCHEMA_COPY_SECTIONS: number;
/**
 * O texto é o apontador do .beads/SCHEMA.md: um blockquote nas primeiras linhas que cita aiteam/docs/beads-schema.md
 * (não uma menção ao caminho), num arquivo que não é a cópia do contrato (menos de SCHEMA_COPY_SECTIONS títulos numerados).
 */
export function hasSchemaPointer(text: string | null | undefined): boolean;
export function parseUpstreamMarker(text: string | null | undefined): UpstreamMarker;
export function renderUpstreamMarker(marker: { commit: string; date?: string | null }): string;

export interface RootChangeEntry {
  hash: string;
  date: string;
  subject: string;
  files: string[];
}
export interface RootChanges {
  status: "no-marker" | "malformed" | "unknown-commit" | "same" | "changes";
  previous?: { commit: string; date?: string | null } | null;
  current?: { commit: string; date?: string | null } | null;
  entries?: RootChangeEntry[];
}
/** `fetched`: o fetch do upstream acabou de rodar (o sync); um marcador que o upstream não conhece não é então um fetch pendente. */
export function renderRootChanges(changes: RootChanges, options?: { next?: string; fetched?: boolean }): string;

export interface Shim {
  file: string;
  line: string;
  fix: string | null;
}
export const SHIMS: readonly Shim[];
export const GITATTRIBUTES_EOL_PATTERNS: readonly string[];

/** `legacy`: o repo ainda está no modelo antigo de .beads; ali a cópia local do SCHEMA.md é o contrato em vigor até migrar. */
export function checkSchemaPointer(facts: { ref: string; local: string | null; remote: string | null; legacy?: boolean }): CheckResult;
export function checkShimImports(facts: {
  ref: string;
  local: Record<string, string | null>;
  remote: Record<string, string | null>;
}): CheckResult;
export function checkGitattributesEol(facts: { ref: string; local: string | null; remote: string | null }): CheckResult;
export function checkCiTemplateSteps(facts: {
  ref: string;
  /** O ci.yml.example do upstream, já parseado; null quando o upstream não o tem. */
  template: { error?: string; doc?: unknown } | null;
  /** Os workflows do consumidor, já parseados; null quando não deram para ler. */
  workflows: ReadonlyArray<{ file: string; doc?: unknown; error?: string }> | null;
  /** Por que os workflows não foram parseados (sem js-yaml); a comparação não se faz. */
  workflowsUnavailable?: string | null;
}): CheckResult;

/** O URL de um remote aponta para o repo rb-ai-team (o último componente do caminho)? */
export function pointsAtFramework(url: string | null | undefined): boolean;

export type UpstreamState =
  | { state: "no-git" }
  /** `alias`: não há o remote `upstream`, mas este (que não é o origin) aponta para o rb-ai-team. */
  | { state: "no-remote"; alias?: string }
  | { state: "no-ref" }
  | { state: "ok"; ref: string; sha: string; ageDays: number | null };

/** A linha do remote/ref do upstream, da idade da ref e do marcador do último sync. */
export function checkUpstreamRef(facts: {
  upstream: UpstreamState;
  marker?: UpstreamMarker;
  since?: { status: string; entries?: readonly unknown[] } | null;
}): CheckResult;

/** O que readRootFilesFacts (root-files-io.mjs) devolve e checkRootFilesUpstream julga. */
export interface RootFilesFacts {
  upstream: UpstreamState;
  marker: UpstreamMarker;
  since: RootChanges | null;
  /** O repo ainda está no modelo antigo de .beads (o active.yaml rastreado). */
  legacy?: boolean;
  local: Record<string, string | null>;
  remote: Record<string, string | null>;
  template: { error?: string; doc?: unknown } | null;
  workflows: Array<{ file: string; doc?: unknown; error?: string }> | null;
  workflowsUnavailable: string | null;
}
export function checkRootFilesUpstream(facts: RootFilesFacts): CheckResult[];
