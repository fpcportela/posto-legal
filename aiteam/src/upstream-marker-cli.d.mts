// Declaração de tipos para upstream-marker-cli.mjs, na convenção src/*.d.mts (ver tier-core.d.mts).

/**
 * Os comandos de aiteam/scripts/upstream-marker.mjs: `write` grava aiteam/UPSTREAM com o commit da ref do upstream;
 * `changes` lista o que mudou nos arquivos de raiz desde o último sync gravado. Devolve o que o script imprime e o status.
 */
export function runMarkerCommand(
  root: string,
  argv: string[],
  options?: { runGit?: (args: string[]) => string },
): { code: number; out: string; err: string };
