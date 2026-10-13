#!/usr/bin/env node
// beads-trello-reconcile — confere o beads com o quadro do Trello, nas DUAS direções
// (bead viva com card pronto, bead concluída com card na fila, card na fila sem bead,
// e as duas formas de dívida de vínculo). Somente leitura: nunca move card nem comenta.
// Contrato do vínculo: aiteam/docs/beads-schema.md §3.5 (`trello`, `trello_scope`).
//
//   node aiteam/scripts/beads-trello-reconcile.mjs --board <id> --queue <listId>
//   node aiteam/scripts/beads-trello-reconcile.mjs --board <id> --label MESA --ignore 'certid|CND'
//   node aiteam/scripts/beads-trello-reconcile.mjs --help
//
// Credenciais: TRELLO_API_KEY e TRELLO_TOKEN, do ambiente ou do .env da raiz.
// Node puro, sem aiteam/node_modules. Sai com 0 quando conferiu, 1 quando a rede/API
// falhou e 2 em uso errado, credencial ausente ou repo ainda no modelo antigo.

import { main } from "../src/trello-reconcile.mjs";

// exitCode em vez de process.exit(): a saída por pipe não se perde no Windows.
process.exitCode = await main(process.argv.slice(2), { cwd: process.cwd(), env: process.env });
