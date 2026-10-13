#!/usr/bin/env node
// worktree-link — o aiteam/node_modules compartilhado das worktrees vinculadas
// (rb-ai-team#38). A lógica e o porquê vivem em src/worktree-link.mjs.
//
//   node aiteam/scripts/worktree-link.mjs link               (o post-checkout chama; nunca falha)
//   node aiteam/scripts/worktree-link.mjs unlink [<worktree>]  desfaz só o link, sem tocar no alvo
//   node aiteam/scripts/worktree-link.mjs remove <worktree> [--force]
//                                                            desfaz o link e roda git worktree remove
//
// Use `remove` (ou `unlink` antes do git worktree remove): no Windows o
// `git worktree remove` segue a junction e apaga o node_modules do principal.
//
// Node puro, sem aiteam/node_modules.

import { linkSharedModules, removeWorktree, unlinkSharedModules } from "../src/worktree-link.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const positional = rest.filter((a) => !a.startsWith("--"));
const force = rest.includes("--force");

function usage() {
  console.error("uso: node aiteam/scripts/worktree-link.mjs link | unlink [<worktree>] | remove <worktree> [--force]");
  process.exit(2);
}

switch (cmd) {
  case "link": {
    // Hook de checkout: o que der errado vira aviso, nunca falha o git.
    const r = linkSharedModules(process.cwd());
    if (r.status === "linked") console.error(r.message);
    else if (r.status === "error") console.error(`[aiteam] ⚠ ${r.message}`);
    break;
  }
  case "unlink": {
    const r = unlinkSharedModules(positional[0] ?? process.cwd());
    if (r.status === "unlinked") console.log(`[aiteam] link desfeito: ${r.link} (o alvo não foi tocado)`);
    else if (r.status === "absent") console.log("[aiteam] nada a desfazer: não há aiteam/node_modules aqui.");
    else {
      if (r.status === "main-checkout") {
        console.error(`[aiteam] ✗ ${r.link} é do checkout principal: é o alvo dos links das worktrees, não se desfaz. Rode na worktree.`);
      } else if (r.status === "error") {
        console.error(`[aiteam] ✗ não consegui desfazer ${r.link}: ${r.message}`);
      } else {
        console.error(`[aiteam] ✗ ${r.link} não é um link (é um diretório de verdade): nada foi apagado.`);
      }
      process.exitCode = 1;
    }
    break;
  }
  case "remove": {
    if (positional.length !== 1) usage();
    const r = removeWorktree(positional[0], { force });
    if (r.status === "removed") console.log(`[aiteam] worktree removida: ${r.path}`);
    else {
      console.error(`[aiteam] ✗ ${r.message}`);
      process.exitCode = 1;
    }
    break;
  }
  default:
    usage();
}
