// Os comandos de aiteam/scripts/upstream-marker.mjs (rb-ai-team#39): `write` grava o
// marcador aiteam/UPSTREAM e `changes` lista o que mudou nos arquivos de raiz desde ele.
// O script é uma casca fina; a lógica vive aqui, onde um teste a roda sobre um repo temporário.
//
// Só leitura de git e sem rede (a única escrita é o próprio marcador): nunca roda fetch.

import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { MARKER_PATH, UPSTREAM_BRANCHES, UPSTREAM_REMOTE, renderRootChanges, renderUpstreamMarker } from "./root-files-core.mjs";
import { gitRunner, measureRootChanges, readMarker, resolveUpstream } from "./root-files-io.mjs";

const USAGE = [
  "uso: node aiteam/scripts/upstream-marker.mjs <comando> [--ref <ref>]",
  "  write    grava aiteam/UPSTREAM com o commit do upstream de onde este aiteam/ veio (depois do sync)",
  "  changes  lista o que mudou nos arquivos de raiz do upstream desde o último sync gravado",
  "  --ref    a ref do upstream (padrão: o HEAD de upstream, senão upstream/main, senão upstream/master)",
].join("\n");

/** Por que não há ref do upstream, e o que fazer (o `alias` é um remote com outro nome que aponta para o rb-ai-team). */
function whyNoRef(up) {
  if (up.state === "no-remote" && up.alias) {
    return `não há o remote ${UPSTREAM_REMOTE}, mas o remote ${up.alias} aponta para o rb-ai-team: git remote rename ${up.alias} ${UPSTREAM_REMOTE}`;
  }
  if (up.state === "no-remote") return `não há o remote ${UPSTREAM_REMOTE} (git remote add ${UPSTREAM_REMOTE} <url do rb-ai-team>)`;
  if (up.state === "no-ref") {
    const refs = UPSTREAM_BRANCHES.map((b) => `${UPSTREAM_REMOTE}/${b}`).join(", ");
    return `o remote ${UPSTREAM_REMOTE} existe, mas nenhuma de ${refs} foi buscada (git fetch ${UPSTREAM_REMOTE})`;
  }
  return "o git não respondeu";
}

function soft(runGit, args) {
  try {
    return String(runGit(args));
  } catch {
    return null;
  }
}

/**
 * @param {string} root raiz do repo
 * @param {string[]} argv `write` ou `changes`, e `--ref <ref>`
 * @param {{runGit?: (args: string[]) => string}} [options]
 * @returns {{code: number, out: string, err: string}} o que o script imprime e o status de saída
 */
export function runMarkerCommand(root, argv, { runGit = gitRunner(root) } = {}) {
  const [command, ...rest] = argv;
  let explicit = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--ref" && rest[i + 1]) explicit = rest[++i];
    else return { code: 2, out: "", err: `argumento desconhecido: ${rest[i]}\n${USAGE}\n` };
  }
  if (command !== "write" && command !== "changes") return { code: 2, out: "", err: `${USAGE}\n` };

  let ref = explicit;
  if (!ref) {
    const up = resolveUpstream(runGit);
    if (up.state !== "ok") {
      return { code: 1, out: "", err: `não achei a ref do upstream: ${whyNoRef(up)}\n` };
    }
    ref = up.ref;
  }
  const sha = soft(runGit, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!sha || !sha.trim()) return { code: 1, out: "", err: `a ref ${ref} não existe neste clone (git fetch ${UPSTREAM_REMOTE}?)\n` };

  if (command === "changes") {
    const m = measureRootChanges(runGit, { marker: readMarker(root), ref });
    const next =
      "Reconcilie esses arquivos como diz aiteam/docs/consuming-as-upstream.md; " +
      "depois do sync, `node aiteam/scripts/upstream-marker.mjs write` grava o marcador.";
    return { code: 0, out: `${renderRootChanges(m, { next })}\n`, err: "" };
  }

  const date = soft(runGit, ["log", "-1", "--format=%cs", ref]);
  const file = path.join(root, ...MARKER_PATH.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, renderUpstreamMarker({ commit: sha.trim(), date: date ? date.trim() || null : null }));
  return { code: 0, out: `${MARKER_PATH}: ${sha.trim().slice(0, 7)} (${ref}). Commite-o junto do sync.\n`, err: "" };
}
