// Declaração de tipos para infra-kb-core.mjs, seguindo a convenção
// src/*.d.mts (ver tier-core.d.mts) para que os testes .ts compilem sob
// `tsc --noEmit` sem precisar de `allowJs`.

export interface InfraKbPointer {
  remote: string;
  url: string | null;
  ref: string;
  entry: string;
}

export function readPointer(
  specText: string | null,
  yamlLoad: (text: string) => unknown
): InfraKbPointer | null;

export type InfraKbDiagnosis =
  | { state: "absent" }
  | { state: "malformed"; reason: string }
  | { state: "ok"; pointer: InfraKbPointer };

/** Doctor-only diagnosis that (unlike readPointer) distinguishes "no slot" from "slot present but unusable". */
export function diagnosePointer(
  specText: string | null,
  yamlLoad: (text: string) => unknown
): InfraKbDiagnosis;

export interface InfraKbPortRow {
  port: number | null;
  raw: string;
  app: string;
  service: string;
  notes: string;
}

export interface InfraKbExtractOk {
  ok: true;
  ports: InfraKbPortRow[];
  freeRanges: number[];
  sections: { rules: string; limits: string };
}

export interface InfraKbExtractFail {
  ok: false;
  reason: string;
}

export function nextFreePort(claimed: number[], seed: number): number;
export function extract(readmeText: string | null): InfraKbExtractOk | InfraKbExtractFail;

export function matchesInfraPath(filePath: string | null): boolean;
export function formatExtract(
  result: InfraKbExtractOk,
  opts?: { maxNoteChars?: number }
): string;

export interface InfraKbLineInput {
  pointer: InfraKbPointer | null;
  fetched: boolean;
  remoteExists: boolean;
  refDate: string | null;
  ageDays: number | null;
  extracted: InfraKbExtractOk | InfraKbExtractFail | null;
}

export function buildInfraKbLine(input: InfraKbLineInput): string | null;

export function claimPort(
  readmeText: string,
  claim: { port: number; app: string; service: string; notes: string }
): { ok: true; text: string; changed: boolean } | { ok: false; reason: string };
