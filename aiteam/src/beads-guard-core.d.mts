// Tipos de beads-guard-core.mjs, na convenção src/*.d.mts (ver tier-core.d.mts).

/** Disco que ignora maiúsculas por padrão: Windows e macOS. */
export const CASE_INSENSITIVE: boolean;

/** O caminho como o disco do Windows o entende; fora do Windows, intacto. */
export function normalizeInputPath(p: string, platform?: NodeJS.Platform): string;

/** O alvo depois do realpath do ancestral existente mais próximo; null se nada existe. */
export function realTarget(abs: string): { real: string; dir: string } | null;

/** Caminho relativo à raiz, com `/`; null quando o arquivo fica fora do repo. */
export function relativeToRoot(
  root: string,
  filePath: unknown,
  cwd?: string,
  opts?: { caseInsensitive?: boolean }
): string | null;

/** A raiz do repo do alvo e o caminho relativo a ela; null fora de um repo ou do .beads. */
export function locateTarget(
  filePath: unknown,
  cwd: string,
  opts: { topLevel: (dir: string) => string | null; platform?: NodeJS.Platform; caseInsensitive?: boolean }
): { root: string; rel: string } | null;

export function beadsGuardDecision(input: {
  rel: string | null;
  branch: string | null;
  legacy: boolean;
  caseInsensitive?: boolean;
}): { deny: boolean; reason?: string };
