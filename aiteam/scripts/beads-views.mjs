#!/usr/bin/env node
// beads-views — regenera as visões geradas do .beads: .beads/active.yaml (beads
// vivos) e .beads/index.yaml (um bead por linha). Contrato:
// aiteam/docs/beads-schema.md §7.
//
//   node aiteam/scripts/beads-views.mjs            (ou: npm --prefix aiteam run beads:views)
//   node aiteam/scripts/beads-views.mjs --quiet    só o que pede atenção (o modo dos hooks)
//   node aiteam/scripts/beads-views.mjs --merge    + os avisos da combinação de branches e do
//                                                  resto do modelo antigo que o merge trouxe (post-merge)
//
// Node puro, sem aiteam/node_modules: roda nos hooks git de qualquer worktree.
// Sai com 1 só quando uma visão não pôde ser escrita — a anterior fica.

import { classifyBeadsPath, describeRegeneration, gitTopLevel, legacyResidue, regenerateViews } from "../src/beads-io.mjs";

const quiet = process.argv.includes("--quiet");
const merge = process.argv.includes("--merge");
const root = gitTopLevel(process.cwd()) ?? process.cwd();

let summary = null;
try {
  summary = regenerateViews(root);
} catch (err) {
  console.error(`[beads] ⚠⚠ visões não regeneradas: ${err?.message ?? err}`);
  process.exitCode = 1;
}

if (summary) {
  const { loud, info } = describeRegeneration(summary, { quiet, merge });
  for (const line of info) console.log(line);
  for (const line of loud) console.error(line);
  // exitCode em vez de process.exit(): a saída por pipe não se perde no Windows.
  if (summary.results.some((r) => r.action === "failed")) process.exitCode = 1;
}

// Merge limpo de uma branch aberta antes da migração: o espelho (ou o
// archive/) dela entra sem conflito e sem pre-commit. Avisa alto — o que ele
// traz ainda não está em .beads/tasks/ (§11).
if (merge) {
  const residue = legacyResidue(root);
  if (residue.length) {
    const loud = (l) => console.error(`[beads] ⚠⚠ ${l}`);
    loud("resíduo do modelo antigo rastreado num repo já migrado — veio de uma branch aberta antes da migração (a que você mergeou, ou a sua, que recebeu a default já migrada):");
    for (const p of residue) loud(`  ${p}`);
    loud("Ele pode trazer bead que .beads/tasks/ não tem. Porte antes de tirá-lo do git:");
    // O espelho de uma branch pode ter bead que o active.yaml não tem: só o
    // --recover-mirrors o traz no --port-from.
    const mirror = residue.some((p) => classifyBeadsPath(p).kind === "mirror");
    loud(`  node aiteam/scripts/migrate-beads.mjs --port-from HEAD${mirror ? " --recover-mirrors" : ""}   (ou --port <arquivo>)`);
    loud("  git rm --cached <arquivo>, e commite. O validate:beads falha até lá, e o pre-commit recusa o git rm --cached enquanto o bead dele não estiver portado.");
  }
}
