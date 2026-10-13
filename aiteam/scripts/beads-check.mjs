#!/usr/bin/env node
// beads-check — valida o .beads no modelo por bead. Contrato:
// aiteam/docs/beads-schema.md §3 (formato), §4 (combinação) e §8 (validação).
//
//   node aiteam/scripts/beads-check.mjs --all                    a árvore inteira (CI, validate:beads, doctor)
//   node aiteam/scripts/beads-check.mjs --staged --branch <b>    o que está staged (pre-commit)
//
// Node puro, sem aiteam/node_modules. Sai com 1 se houver erro.

import { checkAll, checkStaged, gitTopLevel, LEGACY_HINT, nowFromEnv } from "../src/beads-io.mjs";
import { legacyMergeProblems, legacyPickProblems, legacyResidueProblems, legacyRewriteProblems } from "../src/beads-migrate.mjs";

const args = process.argv.slice(2);
const quiet = args.includes("--quiet");
const root = gitTopLevel(process.cwd()) ?? process.cwd();

// exitCode em vez de process.exit(): a saída por pipe não se perde no Windows.
function finish(errors, warnings, okLine) {
  if (!quiet) for (const w of warnings) console.log(`[beads] ⚠ ${w}`);
  for (const e of errors) console.error(`[beads] ✗ ${e}`);
  if (errors.length) {
    console.error(`[beads] ✗ ${errors.length} erro(s) — contrato: aiteam/docs/beads-schema.md`);
    process.exitCode = 1;
    return;
  }
  if (!quiet && okLine) console.log(okLine);
}

if (args.includes("--staged")) {
  const i = args.indexOf("--branch");
  const branch = i >= 0 ? (args[i + 1] ?? "") : "";
  // --merge: commit de merge ou squash (o pre-commit já conferiu o MERGE_HEAD).
  const merge = args.includes("--merge");
  const r = checkStaged(root, branch, { merge });
  // Merge de uma branch do modelo antigo: o bead dela tem de estar portado (§11). Num
  // commit comum, o mesmo vale para o resíduo do modelo antigo que ele apaga do índice.
  const old = merge ? legacyMergeProblems(root, { nowMs: nowFromEnv() }) : legacyResidueProblems(root, { nowMs: nowFromEnv() });
  // Rebase e cherry-pick não têm MERGE_HEAD: o lado "de lá" é o commit que eles aplicam.
  const pick = legacyPickProblems(root, { nowMs: nowFromEnv() });
  finish(
    [...r.errors, ...old.errors, ...pick.errors],
    [...r.warnings, ...old.warnings, ...pick.warnings],
    r.checked ? `[beads] ✓ ${r.checked} arquivo(s) de bead staged conferido(s)` : null
  );
} else if (args.includes("--rewrite")) {
  // post-rewrite de um rebase: o git não roda o pre-commit no `rebase --continue`, então
  // a conferência do modelo antigo que a branch tinha (ORIG_HEAD) vai aqui, no fim, e só avisa.
  const r = legacyRewriteProblems(root, { nowMs: nowFromEnv() });
  finish(r.errors, r.warnings, null);
} else if (args.includes("--all")) {
  const r = checkAll(root);
  if (r.legacy) {
    console.log(LEGACY_HINT);
    finish(r.errors, r.warnings, null);
  } else {
    const total = r.state.beads.length + r.state.invalid.length;
    const live = r.state.beads.filter((b) => b.status !== "completed").length;
    finish(
      r.errors,
      r.warnings,
      total === 0
        ? "[beads] ✓ nenhum bead ainda (.beads/tasks/ vazio)"
        : `[beads] ✓ ${r.state.beads.length} beads válidos (${live} vivos) — conformes a aiteam/docs/beads-schema.md`
    );
  }
} else {
  console.error("uso: beads-check.mjs --all | --staged --branch <branch> [--merge] | --rewrite");
  process.exitCode = 2;
}
