#!/usr/bin/env node
/**
 * sync-agents — generate the Claude Code binding (`.claude/agents/`) from the
 * canonical personas (`aiteam/agents/`). ADR 0001, migration sketch step 2.
 *
 *   npm --prefix aiteam run sync:agents      write the bindings
 *   npm --prefix aiteam run validate:agents  fail if they drifted (pre-commit)
 *
 * The canonical prose stays engine-neutral; this only produces the Claude-Code
 * binding of the same intent. Never edit `.claude/agents/*.md` by hand — the
 * drift check will overwrite the edit on the next sync.
 */

import * as fs from "fs";
import * as path from "path";
import { repoRoot } from "../src/repo-root.js";
import { isDrift, parsePersona, planSync, type Persona } from "../src/sync-agents.js";

const CHECK = process.argv.includes("--check");
const RED = "[31m";
const GREEN = "[32m";
const YELLOW = "[33m";
const DIM = "[2m";
const RESET = "[0m";

const root = repoRoot();
const sourceDir = path.resolve(root, "aiteam", "agents");
const targetDir = path.resolve(root, ".claude", "agents");

const personas: Persona[] = fs
  .readdirSync(sourceDir)
  .filter((f) => f.endsWith(".md"))
  .map((f) => parsePersona(fs.readFileSync(path.join(sourceDir, f), "utf8"), f));

const existing = new Map<string, string>();
if (fs.existsSync(targetDir)) {
  for (const f of fs.readdirSync(targetDir).filter((f) => f.endsWith(".md"))) {
    existing.set(f.replace(/\.md$/, ""), fs.readFileSync(path.join(targetDir, f), "utf8"));
  }
}

const plan = planSync(personas, existing);
const drifted = plan.filter((e) => isDrift(e.action));
const hostOwned = plan.filter((e) => e.action === "host-owned");

if (CHECK) {
  for (const e of drifted) {
    console.error(`${RED}✗${RESET} ${e.slug} — ${e.action}`);
  }
  for (const e of hostOwned) {
    console.log(`${YELLOW}!${RESET} ${e.slug} — escrito pelo host, preservado (sem binding do framework)`);
  }
  if (drifted.length > 0) {
    console.error(
      `\n${RED}✗ ${drifted.length} binding(s) fora de sincronia com aiteam/agents/${RESET}\n` +
        `  Rode: npm --prefix aiteam run sync:agents`,
    );
    process.exit(1);
  }
  console.log(`${GREEN}✓${RESET} ${plan.length - hostOwned.length} binding(s) em dia com as personas canônicas`);
  process.exit(0);
}

fs.mkdirSync(targetDir, { recursive: true });
let escritos = 0;

for (const e of plan) {
  const file = path.join(targetDir, `${e.slug}.md`);
  if ((e.action === "create" || e.action === "update") && e.content) {
    fs.writeFileSync(file, e.content, "utf8");
    escritos++;
    console.log(`${GREEN}${e.action === "create" ? "+" : "~"}${RESET} ${e.slug}`);
  } else if (e.action === "orphan") {
    // Gerado por nós, fonte canônica não existe mais: sem isso o harness segue
    // despachando um subagente sem persona por trás. Recuperável via git.
    fs.unlinkSync(file);
    console.log(`${YELLOW}-${RESET} ${e.slug} ${DIM}(persona removida)${RESET}`);
  } else if (e.action === "host-owned") {
    console.log(`${YELLOW}!${RESET} ${e.slug} ${DIM}(escrito pelo host — preservado)${RESET}`);
  }
}

const emDia = plan.filter((e) => e.action === "up-to-date").length;
console.log(
  `\n${GREEN}✓${RESET} ${escritos} escrito(s), ${emDia} já em dia` +
    (hostOwned.length > 0 ? `, ${hostOwned.length} do host preservado(s)` : ""),
);
