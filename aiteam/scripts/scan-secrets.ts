#!/usr/bin/env node
/**
 * scan-secrets.ts — pre-commit secret gate.
 *
 * Scans the ADDED lines of the staged diff (so it flags the secret being
 * introduced, not pre-existing content) using the tested core in
 * src/secret-scanner.ts. Exit codes: 0 = clean, 1 = secret(s) found.
 *
 * Usage: npx tsx scripts/scan-secrets.ts
 */

import { execFileSync } from "child_process";
import { scanForSecrets } from "../src/secret-scanner.js";

// Placeholder templates and the scanner's own sources are not real leaks.
const EXCLUDE: RegExp[] = [
  /\.example$/,
  /\.test\.ts$/,
  /(^|\/)secret-scanner\.ts$/,
  /(^|\/)scan-secrets\.ts$/,
];

function stagedFiles(): string[] {
  const out = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=ACM"],
    { encoding: "utf8" }
  );
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

interface AddedLine {
  lineNo: number;
  text: string;
}

function addedLines(file: string): AddedLine[] {
  let diff: string;
  try {
    diff = execFileSync("git", ["diff", "--cached", "-U0", "--", file], {
      encoding: "utf8",
    });
  } catch {
    return [];
  }

  const added: AddedLine[] = [];
  let newLine = 0;
  for (const raw of diff.split(/\r?\n/)) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = parseInt(hunk[1] ?? "0", 10);
      continue;
    }
    if (raw.startsWith("+++")) continue;
    if (raw.startsWith("+")) {
      added.push({ lineNo: newLine, text: raw.slice(1) });
      newLine++;
    } else if (!raw.startsWith("-") && !raw.startsWith("\\")) {
      newLine++;
    }
  }
  return added;
}

let leaks = 0;
for (const file of stagedFiles()) {
  if (EXCLUDE.some((re) => re.test(file))) continue;
  for (const { lineNo, text } of addedLines(file)) {
    for (const finding of scanForSecrets(text)) {
      console.error(`  ✗ ${file}:${lineNo} — possible ${finding.rule}`);
      leaks++;
    }
  }
}

if (leaks > 0) {
  console.error(
    `\n✗ ${leaks} possible secret(s) in staged changes. Remove them (use placeholders in *.example files).`
  );
  process.exit(1);
}

console.log("✅ no secrets detected in staged changes");
