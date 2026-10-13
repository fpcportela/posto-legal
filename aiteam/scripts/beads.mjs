#!/usr/bin/env node
// beads — o comando do .beads: escreve o arquivo da sua branch e mostra o
// estado, inclusive o das outras branches e worktrees (ainda não mergeado).
// Contrato: aiteam/docs/beads-schema.md §12 e §13.
//
//   node aiteam/scripts/beads.mjs new <id> --title "…" [--start]
//   node aiteam/scripts/beads.mjs start|stage|block|unblock|done|note|set <id> …
//   node aiteam/scripts/beads.mjs status | list | show <id> | path <id>
//
// Node puro, sem aiteam/node_modules: roda em qualquer worktree. Sai com 0
// quando grava ou mostra, 1 quando recusa (nada é escrito) e 2 em erro de uso.

import { run } from "../src/beads-cmd.mjs";

const result = run(process.argv.slice(2), { cwd: process.cwd(), env: process.env });
for (const line of result.stdout) console.log(line);
for (const line of result.stderr) console.error(line);
// exitCode em vez de process.exit(): a saída por pipe não se perde no Windows.
process.exitCode = result.code;
