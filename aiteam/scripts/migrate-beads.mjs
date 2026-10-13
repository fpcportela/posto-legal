#!/usr/bin/env node
// migrate-beads — leva o .beads do modelo antigo (active.yaml + espelhos por
// branch + archive/) para o modelo por bead. Contrato:
// aiteam/docs/beads-schema.md §11.
//
//   node aiteam/scripts/migrate-beads.mjs [--dry-run] [--as <nome>] [--recover-mirrors] [--from-worktree]
//   node aiteam/scripts/migrate-beads.mjs --port <arquivo-antigo | rev:arquivo> [--dry-run] [--as <nome>]
//   node aiteam/scripts/migrate-beads.mjs --port-from <commit> [--recover-mirrors] [--dry-run] [--as <nome>]
//   node aiteam/scripts/migrate-beads.mjs --scan-history [--dry-run] [--as <nome>]
//
// Lê os blobs de HEAD (a árvore com --from-worktree), escreve uma pasta por
// bead e prepara o stage — sem commitar. --as é o nome do arquivo de branch
// (padrão: a branch atual, com / trocado por -). Node puro, sem node_modules.
//
// --port traz um arquivo do modelo antigo (active.yaml, espelho ou
// archive/completed.yaml) para o modelo novo depois da migração; --port-from
// traz todo o modelo antigo de um commit — num merge de uma branch aberta
// antes da migração, --port-from MERGE_HEAD; e, no sentido contrário, quando
// a sua branch é a antiga e recebe a default já migrada, --port-from HEAD
// (com --recover-mirrors, para o espelho dela). --scan-history varre o histórico
// de HEAD e traz de volta, como pasta nova, cada id do modelo antigo que não
// existe em .beads/tasks/ (na versão de updated_at maior), com o commit e o
// arquivo de origem no relatório.

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { isoText, sanitizeBranch } from "../src/beads-core.mjs";
import { catFiles, currentBranch, describeRegeneration, git, gitTopLevel, isLegacy, nowFromEnv } from "../src/beads-io.mjs";
import {
  applyMigration,
  applyPort,
  formatReport,
  hasLegacySources,
  migrationBlockers,
  planMigration,
  planPort,
  planPortFrom,
  planScanHistory,
  portContext,
  readLegacySources,
  scanHistory,
} from "../src/beads-migrate.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function printViews(summary) {
  const { loud, info } = describeRegeneration(summary, { quiet: false });
  for (const l of info) console.log(l);
  for (const l of loud) console.error(l);
}

// No meio de um merge (ou squash) a árvore ainda tem o active.yaml antigo da
// outra branch: as visões ficam para o post-commit do merge.
function mergeInProgress(root) {
  // Rebase e cherry-pick de uma branch antiga na default migrada: o mesmo — o active.yaml
  // antigo está na árvore, e regenerar agora o guardaria como edição à mão.
  for (const ref of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD"]) {
    if (git(root, ["rev-parse", "-q", "--verify", ref]).status === 0) return true;
  }
  const squash = git(root, ["rev-parse", "--git-path", "SQUASH_MSG"]);
  return squash.status === 0 && existsSync(path.resolve(root, squash.stdout.trim()));
}

function finishPort(root, label, as, plan, dryRun) {
  for (const e of plan.errors) console.error(`[beads] ✗ ${e}`);
  // Nó sem id ou sem data legível: ficou de fora, mas não impede os válidos (A4).
  for (const w of plan.warnings ?? []) console.error(`[beads] ⚠ ${w}`);
  console.log(
    `${label} → ${as}.yaml: ${plan.created.length} criado(s), ${plan.appended.length} com entrada nova, ${plan.skipped.length} já refletido(s)`
  );
  if (plan.errors.length) return 1;
  if (dryRun) {
    for (const f of plan.files) console.log(`  [dry-run] ${f.path}`);
    return 0;
  }
  const merging = mergeInProgress(root);
  const views = applyPort(root, plan, { regenerate: !merging });
  if (views) printViews(views);
  console.log(
    merging
      ? "Pronto — tire do merge (ou rebase, ou cherry-pick) o que é do modelo antigo (git rm --cached), revise com `git status` e commite (ou --continue)."
      : "Pronto — revise com `git status` e commite."
  );
  return 0;
}

// --port <arquivo>, ou --port <rev>:<arquivo> (ex.: HEAD:.beads/velha.yaml): lê o arquivo do
// commit, e por isso vale com ele já apagado do disco — é o que a recusa do pre-commit manda.
function readPortSource(root, spec) {
  const m = /^([^:]+):(\.beads\/.+)$/.exec(spec);
  if (m && !existsSync(spec)) {
    const [, rev, rel] = m;
    if (git(root, ["rev-parse", "-q", "--verify", `${rev}^{commit}`]).status !== 0) return { error: `${rev} não é um commit deste repo` };
    const text = catFiles(root, [`${rev}:${rel}`]).get(`${rev}:${rel}`);
    return typeof text === "string" ? { text } : { error: `${rel} não existe em ${rev}` };
  }
  try {
    return { text: readFileSync(spec, "utf8") };
  } catch (err) {
    return { error: `não consegui ler ${spec}: ${err?.message ?? err}` };
  }
}

function port(root, as, nowMs, dryRun) {
  const file = value("--port");
  const src = readPortSource(root, file ?? "");
  if (src.error !== undefined) {
    console.error(`[beads] --port: ${src.error}`);
    return 1;
  }
  const oldText = src.text;
  const plan = planPort(oldText, portContext(root, as, nowMs), { as, nowMs });
  return finishPort(root, `--port ${file}`, as, plan, dryRun);
}

function portFrom(root, as, nowMs, dryRun) {
  const rev = value("--port-from");
  if (!rev || git(root, ["rev-parse", "-q", "--verify", `${rev}^{commit}`]).status !== 0) {
    console.error(`[beads] --port-from: ${rev ?? "(vazio)"} não é um commit deste repo`);
    return 1;
  }
  const sources = readLegacySources(root, { rev });
  if (!hasLegacySources(sources)) {
    console.log(`[beads] nada a portar: ${rev} não tem .beads/active.yaml antigo, archive/ nem espelhos.`);
    return 0;
  }
  const plan = planPortFrom(sources, portContext(root, as, nowMs), { as, nowMs, recoverMirrors: flag("--recover-mirrors"), label: `--port-from ${rev}` });
  const s = plan.report.sources;
  console.log(`--port-from ${rev}: active ${s.active} · completed ${s.completed} · espelhos ${s.mirrors}${flag("--recover-mirrors") ? "" : " (só com --recover-mirrors)"}`);
  return finishPort(root, `--port-from ${rev}`, as, plan, dryRun);
}

function scanHistoryCli(root, as, nowMs, dryRun) {
  if (isLegacy(root)) {
    console.error("[beads] --scan-history: o repo ainda está no modelo antigo — migre antes (node aiteam/scripts/migrate-beads.mjs --dry-run).");
    return 1;
  }
  const scan = scanHistory(root);
  const { plan, missing, ignored, newer } = planScanHistory(scan, portContext(root, as, nowMs), { as, nowMs });
  const done = missing.filter((c) => c.node.status === "completed").length;
  const where = (c) => `${c.commit.slice(0, 7)} ${c.file}`;
  const status = (c) => (typeof c.node.status === "string" ? c.node.status : "?");
  console.log(`--scan-history: ${scan.commits} commit(s) com .beads no histórico de HEAD, ${scan.versions} versão(ões) do modelo antigo, ${scan.best.size} id(s) vistos`);
  console.log(`faltam em .beads/tasks/: ${missing.length}${missing.length ? ` (${missing.length - done} não concluído(s), ${done} concluído(s))` : ""}`);
  for (const c of missing) console.log(`  ${c.id} · ${status(c)} · ${where(c)} · ${isoText(c.updatedMs)}`);
  for (const c of ignored) console.log(`  ignorado: ${c.id} (${where(c)}) — ${c.reason}`);
  for (const u of scan.unreadable) console.log(`  versão ilegível, fora da conta: ${u}`);
  if (newer.length) {
    console.log(`já existem, mas o histórico tem versão mais nova (não portada; se quiser: --port-from <commit>):`);
    for (const c of newer) console.log(`  ${c.id} · ${status(c)} · ${where(c)} · ${isoText(c.updatedMs)}`);
  }
  return finishPort(root, "--scan-history", as, plan, dryRun);
}

function migrate(root, as, nowMs, dryRun) {
  const fromWorktree = flag("--from-worktree");
  const blockers = migrationBlockers(root, { fromWorktree });
  if (blockers.length) {
    for (const b of blockers) console.error(`[beads] migrate recusado: ${b}`);
    return 1;
  }
  const where = fromWorktree ? "a árvore" : "HEAD";
  const sources = readLegacySources(root, { fromWorktree });
  if (sources.active === null && sources.completed === null && sources.mirrors.length === 0) {
    console.log(`[beads] nada a migrar: ${where} não tem .beads/active.yaml, archive/ nem espelhos.`);
    return 0;
  }

  const plan = planMigration(sources, { as, recoverMirrors: flag("--recover-mirrors"), nowMs });
  console.log(`migração do .beads → .beads/tasks/<id>/${as}.yaml (lendo ${where})`);
  for (const line of formatReport(plan.report)) console.log(line);
  if (plan.errors.length) {
    for (const e of plan.errors) console.error(`[beads] ✗ ${e}`);
    console.error("[beads] migração abortada antes de escrever qualquer arquivo.");
    return 1;
  }
  if (dryRun) {
    console.log(`[dry-run] escreveria ${plan.files.length} arquivo(s); nada foi tocado.`);
    return 0;
  }

  printViews(applyMigration(root, plan, { nowMs }));
  console.log(
    [
      "Pronto, sem commit. Falta, à mão:",
      "  - trocar .beads/SCHEMA.md pelo apontador para aiteam/docs/beads-schema.md (convenções locais no apêndice);",
      "  - tirar do .gitattributes o bloco inteiro do driver beads-yaml, comentário incluído (o sync já manda; o contract test reprova qualquer beads-yaml no arquivo);",
      "  - revisar `git status` e commitar.",
    ].join("\n")
  );
  return 0;
}

function main() {
  const root = gitTopLevel(process.cwd());
  if (!root) {
    console.error("[beads] migrate: rode dentro de um repo git.");
    return 2;
  }
  const asRaw = value("--as");
  let as;
  if (asRaw !== undefined) {
    as = sanitizeBranch(asRaw);
  } else {
    const cur = currentBranch(root);
    as = cur.branch ? sanitizeBranch(cur.branch) : { file: null, reason: "HEAD destacado — passe --as <nome> ou crie uma branch" };
  }
  if (!as.file) {
    console.error(`[beads] migrate: ${as.reason}`);
    return 2;
  }
  const nowMs = nowFromEnv();
  const dryRun = flag("--dry-run");
  if (args.includes("--scan-history")) return scanHistoryCli(root, as.file, nowMs, dryRun);
  if (args.includes("--port-from")) return portFrom(root, as.file, nowMs, dryRun);
  return value("--port") !== undefined ? port(root, as.file, nowMs, dryRun) : migrate(root, as.file, nowMs, dryRun);
}

// exitCode em vez de process.exit(): a saída por pipe não se perde no Windows.
process.exitCode = main();
