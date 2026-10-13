#!/usr/bin/env node
// aiteam install — wire the vendored framework into a host project, idempotently
// and WITHOUT clobbering the host's own config or git hooks (the non-interference
// invariants in docs/vendoring-phase2-runbook.md §7a). Plain Node, zero deps, so
// it runs before `npm install`.
//
//   node aiteam/install.mjs             apply
//   node aiteam/install.mjs --dry-run   show what would change, touch nothing
//
// Then verify with: node aiteam/scripts/doctor.mjs

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, chmodSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  mergeSettings,
  mergeMcpServers,
  mcpAddedLabel,
  ensureImportLine,
  planHookChaining,
  ensureChainLine,
  ensurePointerFile,
  ADAPTER_POINTER_BLOCK,
  LEGACY_ADAPTER_POINTER_BLOCKS,
  CURSOR_RULE_CONTENT,
  resolveHookPath,
  CHAINED_HOOKS,
  planInfraRemote,
  FRAMEWORK_SETTINGS,
  ensureGitignoreEntries,
  planTierRulesSeed,
  readOptionalFile,
} from "./src/install-core.mjs";
import { readPointer } from "./src/infra-kb-core.mjs";
import { isLegacy, regenerateViews } from "./src/beads-io.mjs";
import { GITIGNORE_PATH, mergeGitignore } from "./src/beads-core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url)); // aiteam
const FRAMEWORK_HOOKS_DIR = "aiteam/githooks";

// FRAMEWORK_SETTINGS (the .claude/settings.json wiring: tier-guard,
// infra-kb-guard, SessionStart brief) lives in ./src/install-core.mjs — see
// the comment there for why. Also mirrored by hand in this repo's own root
// .claude/settings.json; keep the two in sync.

const FRAMEWORK_MCP = {
  mcpServers: {
    "rb-ai-team-tools": {
      command: "npx",
      args: ["tsx", "aiteam/mcp/server.ts"],
      description:
        "Project-local MCP server exposing the rb-ai-team tools (run_tests, git_commit, deploy_preview, db_migrate, deploy_production) with permission-tier enforcement. Tier-3 tools require SPEC.md tier_defaults.allow_tier3=true.",
    },
    // The Trello MCP (rb-ai-team#28/#50). A project without a Trello board gets it too: the server
    // starts without credentials and only a call fails, with a message that says what to set. A
    // `trello-tools` the host already registers — typically the local copy it had before the
    // framework shipped one — is never replaced (mergeMcpServers); that swap is the host's, via the
    // aiteam-sync checklist.
    "trello-tools": {
      command: "npx",
      args: ["tsx", "aiteam/mcp/trello-server.ts"],
      description:
        "Trello MCP: list boards/lists/cards, sync a list's cards + download the uploaded prints to .trello-cache/ (git-ignored), read card comments (read, Tier 1), and comment/move/create cards and add labels by name (write-back, Tier 2). Never Tier 3. Reads TRELLO_API_KEY/TRELLO_TOKEN from the gitignored root .env; without them the server starts and each call says what is missing.",
    },
  },
};

const IMPORT_LINES = [
  ["CLAUDE.md", "@aiteam/CLAUDE.md"],
  ["AGENTS.md", "@aiteam/AGENTS.md"],
];

const dry = process.argv.includes("--dry-run");

function repoRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: here, encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}
// Avisos do install, impressos todos JUNTOS depois do resumo (e não no meio dos
// passos, antes do banner): quem lê a saída vê primeiro o que foi feito.
const warnings = [];
const warn = (message) => warnings.push(message);

const nodeFs = { statSync, readFileSync };
const display = (p) => path.relative(root, p).split(path.sep).join("/");

// Lê um arquivo do host que o install vai mesclar ou acrescentar, SEM lançar:
// "" se ele falta, o texto se lê, e null se existe mas não dá para ler (uma pasta
// com esse nome, EACCES) — o install avisa e quem chama pula o arquivo, em vez de
// morrer com a stack do Node no meio ou de escrever por cima do que é do dono.
function readHostText(p) {
  const r = readOptionalFile(p, nodeFs);
  if (r.state === "ok") return r.text;
  if (r.state === "missing") return "";
  warn(`${display(p)} existe mas não pôde ser lido (${r.reason}): o install não o toca. Conserte e rode o install de novo.`);
  return null;
}

// O JSON do host: {} se falta ou está vazio, o objeto se lê, e null se não dá para
// ler ou não é JSON (avisa, e quem chama pula). Antes um JSON inválido virava {} e
// o arquivo do dono era trocado pelo resultado da mescla.
function readHostJson(p) {
  const text = readHostText(p);
  if (text === null) return null;
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) ?? {};
  } catch (err) {
    warn(`${display(p)} não é JSON válido (${err instanceof Error ? err.message : err}): o install não o toca. Conserte e rode o install de novo.`);
    return null;
  }
}
function gitConfigGet(root, key) {
  try {
    return execFileSync("git", ["config", "--get", key], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
function applyFile(p, next, prev) {
  if (prev === next) return false;
  if (!dry) {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, next);
  }
  return true;
}

const root = repoRoot();
const actions = [];

// KB de infra: cria o git remote declarado em SPEC.md (idempotente, como todo
// o resto do installer). É o passo que resolve os consumidores que hoje não
// têm o remote — sem ele, o slot fica declarado e inerte.
try {
  const { load } = await import("js-yaml");
  const pointer = readPointer(readFileSync(path.join(root, "SPEC.md"), "utf8"), load);
  const existing = execFileSync("git", ["remote"], { cwd: root, encoding: "utf8" }).split(/\r?\n/);
  const plan = planInfraRemote(pointer, existing);
  if (plan.action === "add") {
    if (!dry) {
      execFileSync("git", ["remote", "add", plan.remote, plan.url], { cwd: root });
    }
    actions.push(`git remote "${plan.remote}" — criado (KB de infra)`);
  } else if (plan.action === "noop") {
    // Remote already exists; idempotent no-op, no action to report.
  } else if (plan.reason && pointer) {
    warn(`KB de infra: ${plan.reason}`);
  }
} catch {
  // Repo sem SPEC.md, sem git, ou sem js-yaml ainda: o installer segue.
}

// JSON config: only (re)write when the MERGED CONTENT actually differs from the
// host's — comparing parsed objects, not serialized bytes, so we never reformat
// a host file just because their whitespace differs from ours.
function applyJson(p, merged, hostObj, label) {
  if (JSON.stringify(merged) === JSON.stringify(hostObj)) return;
  if (!dry) {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(merged, null, 2) + "\n");
  }
  actions.push(label);
}

// 1. .claude/settings.json — merge deny rules + PreToolUse tier-guard + SessionStart brief hook
// + worktree.baseRef (only when the host hasn't chosen one).
{
  const p = path.join(root, ".claude", "settings.json");
  const hostObj = readHostJson(p);
  if (hostObj !== null) {
    applyJson(p, mergeSettings(hostObj, FRAMEWORK_SETTINGS), hostObj, ".claude/settings.json — merged tier deny rules + PreToolUse tier-guard + infra-kb-guard + beads-guard + SessionStart brief hook + worktree.baseRef");
  }
}

// 2. .mcp.json — add the rb-ai-team-tools server entry.
{
  const p = path.join(root, ".mcp.json");
  const hostObj = readHostJson(p);
  if (hostObj !== null) applyJson(p, mergeMcpServers(hostObj, FRAMEWORK_MCP), hostObj, mcpAddedLabel(".mcp.json", hostObj, FRAMEWORK_MCP));
}

// 3. CLAUDE.md / AGENTS.md — inject the @aiteam import line (append-only).
for (const [file, line] of IMPORT_LINES) {
  const p = path.join(root, file);
  const prev = readHostText(p);
  if (prev === null) continue;
  const next = ensureImportLine(prev, line);
  if (applyFile(p, next, prev)) actions.push(`${file} — injected '${line}'`);
}

// 4. Per-tool adapters — thin pointers to AGENTS.md for non-Claude clients.
{
  const p = path.join(root, ".cursor", "rules", "aiteam.mdc");
  const prev = readHostText(p);
  if (prev !== null && applyFile(p, CURSOR_RULE_CONTENT, prev)) actions.push(".cursor/rules/aiteam.mdc — wrote the aiteam pointer rule");
}
for (const file of [".windsurfrules", ".github/copilot-instructions.md"]) {
  const p = path.join(root, ...file.split("/"));
  const prev = readHostText(p);
  if (prev === null) continue;
  // A file that has the block in an older wording gets it swapped in place, not a second one appended.
  const next = ensurePointerFile(prev, ADAPTER_POINTER_BLOCK, LEGACY_ADAPTER_POINTER_BLOCKS);
  if (applyFile(p, next, prev)) actions.push(`${file} — wrote the aiteam pointer block (appended, or swapped for its older wording)`);
}
{
  const p = path.join(root, ".cursor", "mcp.json");
  const hostObj = readHostJson(p);
  if (hostObj !== null) applyJson(p, mergeMcpServers(hostObj, FRAMEWORK_MCP), hostObj, mcpAddedLabel(".cursor/mcp.json", hostObj, FRAMEWORK_MCP));
}

// 5. git hooks — set if the host has none (or has a non-canonical ABSOLUTE path
// to our own hooks, which we normalize), chain (never clobber) a real host dir.
{
  const current = gitConfigGet(root, "core.hooksPath");
  const plan = planHookChaining(current, FRAMEWORK_HOOKS_DIR);
  if (plan.action === "set") {
    if (!dry) execFileSync("git", ["config", "core.hooksPath", plan.hooksPath], { cwd: root });
    actions.push(
      `core.hooksPath — set to ${plan.hooksPath} (${current ? `normalized from the non-canonical "${current}"` : "host had none"})`
    );
  } else if (plan.action === "router") {
    for (const hook of CHAINED_HOOKS) {
      // NOT path.join(root, hostHooksPath, ...): git accepts core.hooksPath as
      // relative OR absolute, and joining an absolute value onto the root glued
      // two roots together ("C:\repo\C:\repo\.githooks") → ENOENT.
      const p = resolveHookPath(root, plan.hostHooksPath, hook);
      const prev = readHostText(p);
      if (prev === null) continue;
      const next = ensureChainLine(prev, FRAMEWORK_HOOKS_DIR, hook);
      if (applyFile(p, next, prev)) {
        if (!dry) {
          try {
            chmodSync(p, 0o755);
          } catch {
            /* windows / no-op */
          }
        }
        actions.push(`${plan.hostHooksPath}/${hook} — chained the framework hook (host core.hooksPath preserved)`);
      }
    }
  }
  // plan.action === "noop": already pointing at the framework hooks.
}

// 6. .beads — o .gitignore canônico (aiteam/docs/beads-schema.md §2), também
// em modo legado: o circuit breaker já escreve .beads/session.local.json, e
// sem ele o custo local entraria no próximo `git add -A`. Só acrescenta as
// regras que faltam; um active.yaml rastreado continua rastreado.
{
  const p = path.join(root, ".beads", ".gitignore");
  const prev = readHostText(p) ?? undefined;
  if (prev !== undefined && applyFile(p, mergeGitignore(prev), prev)) {
    actions.push(`${GITIGNORE_PATH} — ${prev ? "acrescentadas as regras que faltavam" : "criado"} (visões e estado local fora do git)`);
  }
}

// 7. .gitignore da raiz — GITIGNORE_ENTRIES, numa leitura só (readHostText). Três regras:
// .claude/worktrees/ (issue 38): as worktrees que o Claude Code cria para os subagentes
// (isolation: "worktree") ficam ali dentro. .trello-cache/ (rb-ai-team#28): o MCP do Trello
// baixa os prints dos cards ali — telas internas do produto e dados de cliente do time.
// .superpowers/ (issue 51): o workspace de rascunho dos skills do superpowers, que nunca é
// fonte de estado. Sem as regras o checkout principal os vê como árvore não rastreada, e um
// `git add -A` os empacotaria. Só acrescenta no fim e só o que o arquivo ainda não ignora.
// Como a leitura é uma só, um .gitignore que é pasta ou não se lê avisa uma vez só e nenhuma
// das regras é escrita.
{
  const p = path.join(root, ".gitignore");
  const prev = readHostText(p) ?? undefined;
  if (prev !== undefined) {
    const { text, added } = ensureGitignoreEntries(prev);
    if (applyFile(p, text, prev)) {
      added.forEach((entry, i) => {
        actions.push(`.gitignore — ${i === 0 && !prev ? "criada com" : "acrescentada"} a regra ${entry.line} (${entry.why})`);
      });
    }
  }
}

// 8. .claude/tier-rules.json — o mapa de tiers do projeto. Fica fora de aiteam/,
// então não viaja com o vendor: semeia a partir de aiteam/templates/tier-rules.json
// quando o arquivo FALTA. Nunca sobrescreve (é do projeto: customizado ou, mesmo
// quebrado, de quem o conserta). Sem o arquivo o guard cai na cópia canônica do
// framework e o doctor reprova; semear dá ao projeto o arquivo para editar.
{
  const p = path.join(root, ".claude", "tier-rules.json");
  const templatePath = path.join(here, "templates", "tier-rules.json");
  // readOptionalFile nunca lança: uma pasta com esse nome ou um arquivo sem
  // permissão de leitura viram aviso, não a stack do Node no meio do install.
  const mine = readOptionalFile(p, nodeFs);
  const template = readOptionalFile(templatePath, nodeFs);
  if (mine.state === "unreadable") {
    warn(
      `.claude/tier-rules.json existe mas não pôde ser lido (${mine.reason}): o install não o semeia nem o toca. ` +
        "Ele tem de ser um arquivo JSON legível; conserte e rode o install de novo (até lá o tier-guard protege pela cópia canônica).",
    );
  } else {
    const plan = planTierRulesSeed(mine.state === "ok" ? mine.text : null, template.state === "ok" ? template.text : null);
    if (plan.action === "seed") {
      if (applyFile(p, plan.content, "")) {
        actions.push(".claude/tier-rules.json — semeado a partir de aiteam/templates/tier-rules.json (o mapa de tiers do projeto: é seu, edite e versione)");
      }
    } else if (plan.action === "skip") {
      warn(`.claude/tier-rules.json não semeado: ${plan.reason}`);
    }
  }
  // Um consumidor que ignora o .claude/ (o rb-content-team ignora a pasta e rastreia só este arquivo) nunca
  // versiona o mapa sem `git add -f`. `git check-ignore` não lista arquivo já rastreado, então só avisa
  // quem ainda não o versionou.
  try {
    execFileSync("git", ["check-ignore", "-q", "--", ".claude/tier-rules.json"], { cwd: root, stdio: "ignore" });
    warn(
      ".claude/tier-rules.json está ignorado pelo .gitignore deste repo e ainda não é rastreado: ele não chega ao git, " +
        "nem aos outros clones e ao CI (lá o tier-guard cai na cópia canônica). Versione-o com: git add -f .claude/tier-rules.json",
    );
  } catch {
    // Não ignorado (exit 1), já rastreado ou fora de um repo git: nada a avisar.
  }
}

// Depois, gera as visões uma vez (§7.3); daí em diante os hooks git cuidam
// disso. Em modo legado (o active.yaml do modelo antigo ainda rastreado) nada
// é gerado: só o aviso para migrar.
try {
  if (isLegacy(root)) {
    actions.push(".beads — modo legado: os hooks não mexem no backlog até migrar (node aiteam/scripts/migrate-beads.mjs --dry-run)");
  } else if (!dry) {
    const summary = regenerateViews(root);
    if ((summary.results ?? []).some((r) => r.action === "wrote")) actions.push(".beads — visões active.yaml e index.yaml geradas");
  }
} catch {
  // Sem git ou sem .beads: o installer segue.
}

console.log(`aiteam install${dry ? " (dry-run)" : ""} — repo root: ${root}\n`);
if (actions.length === 0) {
  console.log("✓ already installed — nothing to change (idempotent).");
} else {
  for (const a of actions) console.log(`  ${dry ? "would:" : "✓"} ${a}`);
  console.log(
    `\n${dry ? "Dry run — no files written." : "✓ install complete."} Verify with: node aiteam/scripts/doctor.mjs`
  );
}
// Os avisos, todos juntos, depois do que foi feito.
if (warnings.length > 0) {
  console.log("");
  for (const w of warnings) console.log(`  ⚠ ${w}`);
}

// The persona→subagent binding needs the toolchain (tsx), which may not be
// installed yet — this script runs before `npm install` by design. So we point
// at it instead of running it. An existing host-authored .claude/agents/<name>.md
// is never overwritten by that sync (same non-interference invariant as above).
console.log(
  `\nNext: cd aiteam && npm install && npm run sync:agents` +
    `\n  (generates .claude/agents/ from the canonical personas in aiteam/agents/)`
);
