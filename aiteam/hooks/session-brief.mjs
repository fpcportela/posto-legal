#!/usr/bin/env node
// SessionStart hook — Claude-specific accelerator for the session-start redesign.
//
// Thin I/O shell: regenerates the .beads views (aiteam/docs/beads-schema.md
// §7.3), reads .beads/active.yaml (live beads only, small by construction) plus
// .beads/index.yaml, and hands them to buildBrief() in
// ../src/session-brief-core.mjs together with what the view does not carry —
// the branch from git, project/budget from SPEC.md, the cost from the local
// .beads/session.local.json. The brief is emitted as additionalContext, so the
// live task state reaches the model with ZERO tool calls and without depending
// on the model choosing to read it. The portable path (Antigravity/others)
// still reads active.yaml per BOOT.md.
//
// Runs on plain node: the parser is the vendored js-yaml (aiteam/vendor/), so a
// fresh worktree without aiteam/node_modules still gets its brief.
//
// The brief LOGIC lives in the core module — this file owns the shebang and is
// never imported (same split as tier-guard.mjs/tier-core.mjs). That is load
// bearing: vite-node's shebang strip leaves a stray CR on a CRLF checkout, so a
// tested module carrying `#!` dies with "SyntaxError: Invalid or unexpected
// token". Keep this file un-imported and the core shebang-free.
//
// NEVER throws: a missing/invalid state file yields a helpful note, never a
// broken session.

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "node:child_process";
import { readPointer, extract, buildInfraKbLine } from "../src/infra-kb-core.mjs";

// Todo git aqui é best-effort: qualquer falha vira "não sincronizado" no brief,
// nunca uma exceção. O timeout existe porque um remote inacessível travaria o
// start da sessão inteira esperando o TCP desistir.
function git(repo, args, timeout = 5000) {
  try {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", timeout });
    if (r.status !== 0) return null;
    return String(r.stdout ?? "").trim();
  } catch {
    return null;
  }
}

function infraKbLine(repo, yamlLoad) {
  let specText = null;
  try {
    specText = fs.readFileSync(path.join(repo, "SPEC.md"), "utf8");
  } catch {
    return null;
  }

  const pointer = readPointer(specText, yamlLoad);
  if (!pointer) return null;

  const remotes = git(repo, ["remote"]) ?? "";
  const remoteExists = remotes.split(/\r?\n/).some((r) => r.trim() === pointer.remote);
  if (!remoteExists) {
    return buildInfraKbLine({ pointer, fetched: false, remoteExists: false, refDate: null, ageDays: null, extracted: null });
  }

  // Sem --depth: o repo da KB é pequeno, e um fetch raso converteria o
  // histórico daquele remote para shallow num clone que talvez não queira isso.
  const fetched = git(repo, ["fetch", pointer.remote, pointer.ref], 10_000) !== null;

  const iso = git(repo, ["log", "-1", "--format=%cI", `${pointer.remote}/${pointer.ref}`]);
  const refDate = iso ? iso.slice(0, 10) : null;
  const ageDays = iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000) : null;

  const readme = git(repo, ["show", `${pointer.remote}/${pointer.ref}:${pointer.entry}`], 10_000);
  const extracted = readme === null ? null : extract(readme);

  return buildInfraKbLine({ pointer, fetched, remoteExists: true, refDate, ageDays, extracted });
}

// O que a visão não traz e o brief precisa. Cada leitura é best-effort.
function beadsContext(repo, io) {
  const ctx = {};
  try {
    const cur = io.currentBranch(repo);
    ctx.branch = cur.branch;
    ctx.detachedSha = cur.sha;
  } catch {
    /* sem git: vale o que estiver no arquivo */
  }
  try {
    const spec = io.readSpecMeta(repo);
    ctx.project = spec.project;
    ctx.budgetUsd = spec.budgetUsd;
  } catch {
    /* sem SPEC.md */
  }
  try {
    if (fs.existsSync(path.join(repo, ".beads", "session.local.json"))) ctx.costUsd = io.readLocalSession(repo).costUsd;
  } catch {
    /* sem custo local */
  }
  // Só afirma o modo legado; o resto o núcleo decide pelo cabeçalho do
  // arquivo (visão gerada ou não) — fora de um repo git, isLegacy não sabe.
  try {
    if (io.isLegacy(repo)) ctx.legacy = true;
  } catch {
    /* decide pelo cabeçalho do arquivo */
  }
  return ctx;
}

// O que as outras branches e worktrees fizeram nos beads (ainda não mergeado),
// com prazo: o start da sessão não espera um git lento (estourado, o brief diz
// "agregação parcial"). Só heads locais e worktrees — nunca remotos. Falha vira
// "sem essa seção", nunca exceção. BEADS_BRIEF_DEADLINE_MS é a costura dos testes.
async function otherBranches(repo) {
  try {
    const { aggregate } = await import("../src/beads-aggregate.mjs");
    const { deadlineFromEnv } = await import("../src/session-brief-core.mjs");
    return aggregate(repo, { deadlineMs: deadlineFromEnv(process.env.BEADS_BRIEF_DEADLINE_MS), remotes: false });
  } catch {
    return null;
  }
}

// Só contagens e caminhos locais — nunca o texto de um bead (LLM01).
function regenerationNotes(summary) {
  const notes = [];
  const skipped = summary?.state?.invalid?.length ?? 0;
  if (skipped) notes.push(`⚠ ${skipped} bead(s) inválido(s) fora da visão — rode: npm --prefix aiteam run validate:beads`);
  for (const r of summary?.results ?? []) {
    if (r.backup) notes.push(`⚠ ${r.rel} tinha edição à mão, guardada em ${r.backup} — o pre-commit bloqueia até ela virar entrada em .beads/tasks/ e o backup sair`);
    if (r.action === "failed") notes.push(`⚠ não consegui regenerar ${r.rel} — a visão pode estar velha`);
  }
  return notes;
}

// O tier-guard avisa quando as regras não vêm do arquivo do projeto (cópia
// canônica do framework, ou só o piso fixo). Mesmo carregador do guard, e try
// próprio: o brief nunca quebra por isso — se o carregador lançar ou faltar, a
// linha some e o resto fica. Só texto fixo, nada do arquivo (LLM01).
async function tierRulesNote(repo) {
  try {
    const { loadTierRulesWithFallback } = await import("../src/tier-rules-loader.mjs");
    const { tierRulesLine } = await import("../src/session-brief-core.mjs");
    return tierRulesLine(loadTierRulesWithFallback(repo));
  } catch {
    return null;
  }
}

async function main() {
  // Whole function must be crash-proof: as a SessionStart hook, any exception escaping
  // main() becomes an unhandled rejection that kills the session — the .catch(() => {})
  // on the invocation below is a last-resort net, not the primary defense (that's this try).
  try {
    let repo = process.cwd();

    let context;
    try {
      // Dynamic imports inside the try: if a framework module fails to load,
      // the session still starts with the fallback note below.
      const { load, CORE_SCHEMA } = await import("../vendor/js-yaml.mjs");
      const yamlLoad = (text) => load(text, { schema: CORE_SCHEMA });
      const { buildBrief } = await import("../src/session-brief-core.mjs");
      const io = await import("../src/beads-io.mjs");
      repo = io.gitTopLevel(repo) ?? repo;

      let notes = [];
      try {
        notes = regenerationNotes(io.regenerateViews(repo));
      } catch {
        notes = ["⚠ não consegui regenerar as visões do .beads — rode: npm --prefix aiteam run beads:views"];
      }

      // File reads live inside this try too: an existsSync check can't
      // guarantee the follow-up readFileSync succeeds (permissions, a race,
      // or a directory sitting where active.yaml should be raises EISDIR).
      // Any of those must degrade gracefully, never crash.
      const read = (...parts) => {
        const p = path.join(repo, ...parts);
        return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
      };
      const activeText = read(".beads", "active.yaml");
      const indexText = read(".beads", "index.yaml") ?? read(".beads", "archive", "index.yaml");
      const briefCtx = beadsContext(repo, io);
      if (!briefCtx.legacy) briefCtx.elsewhere = await otherBranches(repo);
      context = buildBrief(activeText, indexText, yamlLoad, briefCtx);
      if (notes.length) context = [context, ...notes].join("\n");

      // Try/catch próprio: infraKbLine já blinda suas chamadas de git contra
      // exceção (best-effort — falha vira "⚠️ ... falhou" no texto, nunca
      // lança), mas readPointer/extract não têm essa garantia formal. Sem
      // este try, uma falha confinada ao slot opcional infra_kb cairia no
      // catch de fora e descartaria o brief de beads que JÁ foi construído
      // com sucesso, trocando-o pelo fallback genérico — perdendo conteúdo
      // válido por causa de uma feature que nem todo consumidor usa.
      try {
        const kbLine = infraKbLine(repo, yamlLoad);
        if (kbLine) context = `${context}\n${kbLine}`;
      } catch (kbErr) {
        context = `${context}\ninfra KB: indisponível (${kbErr?.message ?? "erro"}).`;
      }
    } catch (err) {
      // Covers a broken brief, an unreadable/missing state file, or a
      // framework module that failed to load — never let any of these crash
      // the session start.
      context = `beads: brief indisponível (${err?.message ?? "erro"}) — se for a primeira vez, rode 'cd aiteam && npm install'.`;
    }

    // FORA do try do brief de beads, de propósito: quando ele cai no catch acima
    // (um módulo ausente, o YAML vendorizado corrompido, uma exceção do
    // buildBrief), o contexto vira só "brief indisponível" — e o aviso do
    // tier-guard, que importa justamente quando o framework está quebrado, sumia
    // junto.
    const tierLine = await tierRulesNote(repo);
    if (tierLine) context = `${context}\n${tierLine}`;

    writeHookResponse(context);
  } catch (err) {
    // Outer net: catches process.cwd()/path.join throwing (e.g. a deleted cwd) or anything
    // else unexpected outside the inner try — still emit a valid response instead of dying.
    writeHookResponse(`beads: brief indisponível (${err?.message ?? "erro"}).`);
  }
}

function writeHookResponse(context) {
  try {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
      })
    );
  } catch {
    // stdout is broken (e.g. EPIPE from a closed reader) — nothing meaningful left to do.
  }
}

main().catch(() => {});
