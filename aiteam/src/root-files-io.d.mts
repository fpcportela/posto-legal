// Declaração de tipos para root-files-io.mjs, na convenção src/*.d.mts (ver tier-core.d.mts).

import type { RootChanges, RootFilesFacts, UpstreamMarker, UpstreamState } from "./root-files-core.d.mts";

/** O git de um diretório: `runGit(args)` devolve o stdout e lança em status != 0. */
export function gitRunner(cwd: string): (args: string[]) => string;

/** A ref do upstream que este clone tem (HEAD simbólico, senão main, senão master) e a idade da ponta. Só refs locais. */
export function resolveUpstream(runGit: (args: string[]) => string, options?: { now?: number }): UpstreamState;

/** O conteúdo de um arquivo numa ref, ou null se a ref não o tem. */
export function showAt(runGit: (args: string[]) => string, ref: string, file: string): string | null;

/** Quais commits do upstream, entre o último sync (o marcador) e a ref, tocaram os arquivos de raiz. */
export function measureRootChanges(
  runGit: (args: string[]) => string,
  input: { marker: UpstreamMarker; ref: string; paths?: readonly string[] },
): RootChanges & { previous: { commit: string; date: string | null } | null; current: { commit: string; date: string | null } | null; entries: NonNullable<RootChanges["entries"]> };

/** O marcador aiteam/UPSTREAM gravado no repo. */
export function readMarker(root: string): UpstreamMarker;

/** Os fatos que checkRootFilesUpstream julga. Nunca lança; sem rede. */
export function readRootFilesFacts(
  root: string,
  options?: { yamlLoad?: ((text: string) => unknown) | null; runGit?: (args: string[]) => string; now?: number },
): RootFilesFacts;
