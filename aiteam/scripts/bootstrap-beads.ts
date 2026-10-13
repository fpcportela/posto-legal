#!/usr/bin/env node
/**
 * bootstrap-beads.ts
 *
 * Inicializa o .beads de um projeto existente a partir do git log, no modelo
 * por bead (aiteam/docs/beads-schema.md): um bead concluído por escopo de
 * commit, cada um em .beads/tasks/<id>/<branch>.yaml. Roda uma vez, ao adotar
 * o framework num repo legado (docs/legacy-onboarding.md). Não sobrescreve
 * nada: recusa se o .beads já tem beads ou ainda está no modelo antigo.
 *
 * Uso:
 *   npm --prefix aiteam run bootstrap-beads [-- diretório-alvo]
 *   (sem o diretório, vale a raiz do repo: o INIT_CWD do npm, ou o toplevel do git)
 *
 * O que faz:
 *   1. Lê os últimos 30 commits.
 *   2. Agrupa por escopo (feat(auth): … → auth) e vira um bead concluído por grupo.
 *   3. Escreve .beads/tasks/<id>/<branch>.yaml, .beads/.gitignore e as visões.
 */

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { sanitizeBranch } from "../src/beads-core.mjs";
import { defaultTargetDir } from "../src/repo-root.js";
import { regenerateViews, describeRegeneration } from "../src/beads-io.mjs";
import { beadFileFromLegacy, GITIGNORE, GITIGNORE_PATH } from "../src/beads-migrate.mjs";

function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

interface CommitEntry {
  hash: string;
  scope: string;
  subject: string;
  date: string;
  files: string[];
}

function inferScope(subject: string): string {
  const lower = subject.toLowerCase();
  if (lower.includes("auth") || lower.includes("login") || lower.includes("jwt")) return "auth";
  if (lower.includes("db") || lower.includes("schema") || lower.includes("migrat")) return "database";
  if (lower.includes("api") || lower.includes("endpoint") || lower.includes("route")) return "api";
  if (lower.includes("ui") || lower.includes("component") || lower.includes("page")) return "frontend";
  if (lower.includes("test") || lower.includes("spec") || lower.includes("vitest")) return "tests";
  if (lower.includes("config") || lower.includes("env") || lower.includes("docker")) return "infra";
  return "general";
}

function readCommits(cwd: string): CommitEntry[] {
  const log = git(["log", "-30", "--format=%H%x09%cI%x09%s"], cwd);
  return log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash = "", date = "", ...rest] = line.split("\t");
      const subject = rest.join("\t");
      const scopeMatch = /^(?:feat|fix|chore|docs|refactor|test|perf|ci|build)(?:\((.+?)\))?:/.exec(subject);
      const files = git(["diff-tree", "--no-commit-id", "-r", "--name-only", hash], cwd).split("\n").filter(Boolean).slice(0, 5);
      return { hash, scope: scopeMatch?.[1] ?? inferScope(subject), subject, date, files };
    });
}

// Prefixos de roteamento de mesa (aiteam/docs/beads-schema.md §5): o bead
// inicial cai na mesa certa em vez de tudo ir para o Orchestrator.
const ROUTING_PREFIX: Record<string, string> = {
  auth: "api",
  database: "database",
  api: "api",
  frontend: "ui",
  tests: "spec",
  infra: "infra",
};

function main(): void {
  const targetDir = defaultTargetDir(process.argv[2]);
  if (!fs.existsSync(targetDir)) {
    console.error(`Diretório não encontrado: ${targetDir}`);
    process.exit(1);
  }
  const beadsDir = path.join(targetDir, ".beads");
  const tasksDir = path.join(beadsDir, "tasks");
  if (fs.existsSync(tasksDir) && fs.readdirSync(tasksDir).length > 0) {
    console.error("⚠️  .beads/tasks/ já tem beads — o bootstrap não sobrescreve nada.");
    process.exit(1);
  }
  if (fs.existsSync(path.join(beadsDir, "active.yaml")) && git(["ls-files", "--", ".beads/active.yaml"], targetDir)) {
    console.error("⚠️  .beads/active.yaml do modelo antigo está rastreado — migre com: node aiteam/scripts/migrate-beads.mjs --dry-run");
    process.exit(1);
  }

  const branch = sanitizeBranch(git(["symbolic-ref", "--short", "-q", "HEAD"], targetDir) || "main");
  if (!branch.file) {
    console.error(`Branch inválida para escrever beads: ${branch.reason}`);
    process.exit(1);
  }
  const projectName = path.basename(targetDir);
  console.log(`Bootstrap do .beads para ${projectName} (arquivo de branch: ${branch.file}.yaml)`);

  const groups = new Map<string, CommitEntry[]>();
  for (const c of readCommits(targetDir)) groups.set(c.scope, [...(groups.get(c.scope) ?? []), c]);

  const now = new Date().toISOString();
  const written: string[] = [];
  let idx = 1;
  for (const [scope, commits] of groups) {
    const id = `${ROUTING_PREFIX[scope] ?? "orch"}-history-${String(idx++).padStart(3, "0")}`;
    const node = {
      title: `[${scope}] Recent work in ${projectName}`,
      description: (commits[0]?.subject ?? `Recent ${scope} work`).slice(0, 140),
      status: "completed",
      context_summary: `Bootstrapped from git history. Recent commits: ${commits
        .slice(0, 3)
        .map((c) => c.subject)
        .join("; ")}`,
      related_files: [...new Set(commits.flatMap((c) => c.files))].slice(0, 8),
    };
    const createdMs = Date.parse(commits.at(-1)?.date ?? now);
    const updatedMs = Date.parse(commits[0]?.date ?? now);
    const rel = path.join(".beads", "tasks", id, `${branch.file}.yaml`);
    fs.mkdirSync(path.dirname(path.join(targetDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(targetDir, rel), beadFileFromLegacy(node, createdMs, updatedMs), "utf8");
    written.push(`${id}: ${node.title}`);
  }

  const gitignore = path.join(targetDir, ...GITIGNORE_PATH.split("/"));
  if (!fs.existsSync(gitignore)) {
    fs.mkdirSync(path.dirname(gitignore), { recursive: true });
    fs.writeFileSync(gitignore, GITIGNORE, "utf8");
  }

  const { loud, info } = describeRegeneration(regenerateViews(targetDir), { quiet: true });
  for (const l of [...info, ...loud]) console.log(l);

  console.log(`✅ ${written.length} bead(s) em .beads/tasks/<id>/${branch.file}.yaml`);
  for (const w of written) console.log(`  • ${w}`);
  console.log("\nPróximo: node aiteam/install.mjs (liga os hooks) e commite o .beads/.");
}

main();
