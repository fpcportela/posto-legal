#!/usr/bin/env node
// PreToolUse (Write|Edit) — acelerador opcional do .beads no Claude Code.
//
// Nega, antes de acontecer, o Write/Edit que o pre-commit recusaria depois:
// visão gerada (.beads/active.yaml, .beads/index.yaml), backup de visão
// editada, .beads/archive/, espelho do modelo antigo e o arquivo de bead de
// outra branch — e a mensagem já traz o caminho certo. Contrato:
// aiteam/docs/beads-schema.md §8 e §9.
//
// A decisão mora em ../src/beads-guard-core.mjs; este arquivo tem o shebang e
// o I/O e nunca é importado (mesma separação do tier-guard). Roda em node puro,
// sem aiteam/node_modules. Falha aberto: qualquer erro deixa a ferramenta
// seguir, porque o gate de verdade é o pre-commit, que vale para toda engine.

import * as fs from "node:fs";

function allow() {
  process.stdout.write("{}");
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `[beads] ${reason}`,
      },
    })
  );
  process.exit(0);
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return allow();
  }
  const tool = payload?.tool_name;
  if (tool !== "Write" && tool !== "Edit") return allow();
  const filePath = payload?.tool_input?.file_path;
  if (typeof filePath !== "string" || filePath === "") return allow();

  const io = await import("../src/beads-io.mjs");
  const core = await import("../src/beads-guard-core.mjs");
  const cwd = typeof payload?.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  // A raiz, a branch e o modo legado vêm do repo do ALVO (outra worktree, um
  // repo aninhado), com o caminho resolvido como o disco o vê: \\?\, /c/...,
  // stream, ponto no fim, symlink, junção e caixa (aiteam/docs/beads-schema.md §9).
  const loc = core.locateTarget(filePath, cwd, { topLevel: io.gitTopLevel });
  if (!loc) return allow();
  const decision = core.beadsGuardDecision({
    rel: loc.rel,
    branch: io.currentBranch(loc.root).branch,
    legacy: io.isLegacy(loc.root),
    caseInsensitive: core.CASE_INSENSITIVE,
  });
  return decision.deny ? deny(decision.reason) : allow();
}

main().catch(() => allow());
