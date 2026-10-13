#!/usr/bin/env node
/**
 * generate-spec.ts
 *
 * One-shot LLM call that analyzes an existing project directory and outputs
 * a populated SPEC.md draft. Designed for legacy onboarding — run once,
 * then refine the output by hand. Safe on a populated repo: warns and exits
 * without overwriting if SPEC.md exists. See docs/legacy-onboarding.md.
 *
 * The ci: and deploy: frontmatter blocks are NOT written by the model: the ci:
 * block comes from the package.json scripts, and the deploy: block is a
 * placeholder the contract and the doctor fail until it is filled in (see
 * src/spec-draft.ts).
 *
 * Usage:
 *   npm --prefix aiteam run generate-spec [-- target-dir]
 *   Without target-dir it is the repo root (npm's INIT_CWD, else the git toplevel),
 *   never the aiteam/ that npm makes the cwd of the script.
 *
 * Outputs SPEC.md to <target-dir>/SPEC.md (warns if file already exists).
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { createClient } from "../src/circuit-breaker.js";
import { defaultTargetDir } from "../src/repo-root.js";
import { readCiBlock } from "../src/ci-contract-core.mjs";
import { readDeployBlock } from "../src/deploy-contract-core.mjs";
import {
  buildPrompt,
  detectPackageManager,
  renderCiBlock,
  renderDeployBlock,
  withContractBlocks,
  type ProjectSnapshot,
} from "../src/spec-draft.js";

const MODEL = "claude-haiku-4-5-20251001"; // Use Haiku — this is a one-shot analysis, no need for Sonnet

// ── Codebase scanner ─────────────────────────────────────────────────────────

function collectFile(filePath: string, maxChars = 2000): string | null {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return content.length > maxChars ? content.substring(0, maxChars) + "\n…(truncated)" : content;
  } catch {
    return null;
  }
}

function walkDir(dir: string, ext: string[], maxDepth = 3, depth = 0): string[] {
  if (depth > maxDepth) return [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const results: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...walkDir(full, ext, maxDepth, depth + 1));
      } else if (ext.some((e) => entry.name.endsWith(e))) {
        results.push(full.replace(dir + path.sep, ""));
      }
    }
    return results;
  } catch {
    return [];
  }
}

function snapshot(targetDir: string): ProjectSnapshot {
  const read = (f: string, max?: number) => collectFile(path.join(targetDir, f), max);

  const srcTree = walkDir(path.join(targetDir, "src"), [".ts", ".tsx", ".js", ".py", ".go"]);
  const schemaFiles = walkDir(targetDir, [".prisma", "schema.sql", "schema.graphql"]);

  let recentCommits: string | null = null;
  try {
    recentCommits = execSync("git log --oneline -15", {
      cwd: targetDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch { /* not a git repo or git not available */ }

  return {
    packageJson: read("package.json"),
    readmeSnippet: read("README.md", 1500),
    srcTree: srcTree.slice(0, 60),
    schemaFiles,
    envExample: read(".env.example") ?? read(".env.sample"),
    recentCommits,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const targetDir = defaultTargetDir(process.argv[2]);
  const outputPath = path.join(targetDir, "SPEC.md");

  if (!fs.existsSync(targetDir)) {
    console.error(`Directory not found: ${targetDir}`);
    process.exit(1);
  }

  if (fs.existsSync(outputPath)) {
    console.warn(`⚠️  SPEC.md already exists at ${outputPath}`);
    console.warn("   Delete it first or review/merge the output manually.");
    process.exit(1);
  }

  console.log(`Scanning project: ${targetDir}`);
  const snap = snapshot(targetDir);
  const projectName = path.basename(targetDir);
  // O snapshot trunca o package.json em 2000 caracteres, o que o torna JSON
  // inválido: o ci: lê o arquivo inteiro.
  const packageJson = collectFile(path.join(targetDir, "package.json"), Number.MAX_SAFE_INTEGER);
  let rootFiles: string[] = [];
  try {
    rootFiles = fs.readdirSync(targetDir);
  } catch { /* sem a listagem, vale o npm */ }
  const blocks = {
    ci: renderCiBlock(packageJson, detectPackageManager(packageJson, rootFiles)),
    deploy: renderDeployBlock(),
  };
  const today = new Date().toISOString().split("T")[0] ?? "";
  const prompt = buildPrompt(snap, projectName, blocks, today);

  console.log("Calling AI to generate SPEC.md draft…");
  const client = createClient();

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  // Strip fenced code block wrapper if Claude added one
  const cleaned = text.replace(/^```markdown\n/, "").replace(/\n```$/, "").trim();
  // Os blocos ci: e deploy: são de código, não do modelo: valem os do prompt, mesmo que ele os tenha mexido.
  const spec = withContractBlocks(cleaned, blocks);

  fs.writeFileSync(outputPath, spec + "\n", "utf8");
  console.log(`✅ SPEC.md written to ${outputPath}`);
  if (readCiBlock(spec).state !== "ok" || readDeployBlock(spec).state !== "ok") {
    console.warn("⚠️  O frontmatter veio sem os blocos ci:/deploy: legíveis (o modelo não devolveu um frontmatter válido) — declare-os à mão (aiteam/AGENTS.md §CI/CD Mandate).");
  }
  console.log("   Review and fill in any 'TODO:' items before committing.");
  console.log("   O contrato de CI e o doctor reprovam o rascunho até o deploy: ser preenchido (ou virar workflow: none + reason).");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
