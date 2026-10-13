// Tipos de beads-cmd.mjs, na convenção src/*.d.mts (ver tier-core.d.mts).

export interface RunContext {
  /** Diretório de onde o comando roda (padrão: process.cwd()). */
  cwd?: string;
  /** Ambiente (BEADS_NOW é a costura dos testes). Padrão: process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  /** 0 gravou ou mostrou · 1 recusou · 2 erro de uso. */
  code: 0 | 1 | 2;
  stdout: string[];
  stderr: string[];
}

/** Roda o comando `beads` (o CLI de aiteam/scripts/beads.mjs só imprime o resultado). */
export function run(argv: string[], ctx?: RunContext): RunResult;
