#!/usr/bin/env node
// Write-back da KB de infra: reserva uma porta no registro do host.
//
// Clone raso temporário em vez de working tree local: o repo consumidor tem o
// remote da KB mas não um checkout dela, e depender do clone do operador
// funcionaria só na máquina dele — nunca em CI nem para outro agente.
//
// Push direto (decisão do operador, spec D3). As salvaguardas que substituem a
// revisão: claimPort() nunca altera, perde nem duplica o conteúdo de uma linha
// alheia — mas a tabela é mantida ordenada por porta, então o diff PODE
// reposicionar linhas de outros projetos; e o pull --rebase abaixo impede
// atropelar uma reserva concorrente.
//
// Uso:
//   node aiteam/scripts/infra-kb-claim.mjs --port 3214 --app meu-app \
//     --service '`web` (Next.js)' --notes 'host-gateway; reservado 2026-08-05' [--dry-run]

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readPointer, claimPort } from "../src/infra-kb-core.mjs";

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// `git config <key>` sem --local/--global já resolve local→global→system —
// não precisamos escolher a camada, só pedir o valor efetivo. Sem --stdio
// override: exit != 0 (chave ausente em toda a cadeia) é esperado, não um
// erro a propagar — retorna "" e quem chama decide o que fazer.
function gitConfigValue(cwd, key) {
  const r = spawnSync("git", ["config", key], { cwd, encoding: "utf8" });
  return r.status === 0 ? String(r.stdout ?? "").trim() : "";
}

const dryRun = process.argv.includes("--dry-run");
const port = Number(arg("port"));
const app = arg("app");
const service = arg("service");
const notes = arg("notes");

if (!Number.isInteger(port)) die("--port <número> é obrigatório");
if (!app) die("--app <nome> é obrigatório");
if (!service) die("--service <texto> é obrigatório");
if (!notes) die("--notes <texto> é obrigatório");

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

const { load } = await import("js-yaml");
let pointer;
try {
  pointer = readPointer(readFileSync(path.join(root, "SPEC.md"), "utf8"), load);
} catch {
  pointer = null;
}
if (!pointer) die("este repo não declara infra_kb no frontmatter do SPEC.md — nada a reservar");
if (!pointer.url) die("infra_kb.url é obrigatória para o write-back (o clone precisa da url)");

const tmp = mkdtempSync(path.join(os.tmpdir(), "aiteam-infra-kb-"));

// process.exit() não desenrola a pilha como uma exceção — um `finally` que só
// depende dele NUNCA roda nos caminhos que chamam process.exit() diretamente
// (die() e os `process.exit(0)` de no-op/--dry-run abaixo). Sem esta limpeza
// explícita antes de cada saída antecipada, toda reserva recusada, todo
// --dry-run e todo "nada a fazer" vazaria o clone temporário em os.tmpdir() —
// confirmado na prática rodando os testes: seis diretórios `aiteam-infra-kb-*`
// órfãos após uma bateria de recusas/dry-runs, um por saída antecipada. O
// `finally` continua existindo como rede de segurança para exceções de
// verdade (ex.: o `execFileSync` do clone lançando) — essas SIM desenrolam a
// pilha normalmente e disparam o finally.
function cleanupTmp() {
  rmSync(tmp, { recursive: true, force: true });
}

try {
  execFileSync("git", ["clone", "--depth", "1", "--branch", pointer.ref, pointer.url, tmp], { stdio: "inherit" });

  const entry = path.join(tmp, pointer.entry);
  const result = claimPort(readFileSync(entry, "utf8"), { port, app, service, notes });
  if (!result.ok) {
    cleanupTmp();
    die(result.reason);
  }
  if (!result.changed) {
    console.log(`· porta ${port} já está reservada para "${app}" — nada a fazer`);
    cleanupTmp();
    process.exit(0);
  }

  writeFileSync(entry, result.text);
  const diff = spawnSync("git", ["diff", "--stat"], { cwd: tmp, encoding: "utf8" });
  console.log(String(diff.stdout ?? ""));

  if (dryRun) {
    console.log("--dry-run: nada foi commitado nem enviado");
    cleanupTmp();
    process.exit(0);
  }

  // O clone temporário não herda identidade nenhuma (nem local, nem global —
  // é um checkout novo). Resolver em `root` (o repo consumidor) pega a mesma
  // cadeia local→global→system que `git config` sempre resolveria ali, e o
  // commit no registro compartilhado carrega a autoria de verdade do
  // operador em vez de uma identidade anônima inventada — inventar uma
  // seria pior que recusar: uma reserva sem autoria rastreável num repo que
  // várias equipes compartilham.
  const authorName = gitConfigValue(root, "user.name");
  const authorEmail = gitConfigValue(root, "user.email");
  if (!authorName || !authorEmail) {
    cleanupTmp();
    die(
      "identidade git ausente — configure `git config user.name` e `git config user.email` (local ou global) antes de reservar; o write-back não usa identidade inventada."
    );
  }

  execFileSync("git", ["add", pointer.entry], { cwd: tmp });
  execFileSync(
    "git",
    ["-c", `user.name=${authorName}`, "-c", `user.email=${authorEmail}`, "commit", "-m", `chore(registry): claim ${port} for ${app}`],
    { cwd: tmp, stdio: "inherit" }
  );

  // O clone é raso, então o rebase precisa de histórico: aprofunda antes.
  execFileSync("git", ["fetch", "--unshallow", "origin", pointer.ref], { cwd: tmp, stdio: "inherit" });
  const rebase = spawnSync("git", ["pull", "--rebase", "origin", pointer.ref], { cwd: tmp, stdio: "inherit" });
  if (rebase.status !== 0) {
    cleanupTmp();
    die("rebase falhou — outra reserva chegou primeiro; refaça a partir do estado atual da KB");
  }

  const push = spawnSync("git", ["push", "origin", `HEAD:${pointer.ref}`], { cwd: tmp, stdio: "inherit" });
  if (push.status !== 0) {
    cleanupTmp();
    die("push rejeitado — NÃO force; rode de novo para rebasear sobre o estado novo");
  }

  console.log(`✓ porta ${port} reservada para "${app}" em ${pointer.url}`);
} finally {
  cleanupTmp();
}
