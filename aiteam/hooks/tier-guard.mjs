#!/usr/bin/env node
// PreToolUse guard — mechanical Permission Tier enforcement for every tool that
// runs a shell command (see COMMAND_TOOLS).
//
// Reads the hook payload on stdin, classifies the command against the
// canonical map in .claude/tier-rules.json (same file aiteam/src/tier-classifier.ts
// uses — that module is the typed, unit-tested reference implementation) and maps
// guardDecision() to the hook protocol. The map comes from
// aiteam/src/tier-rules-loader.mjs: when the project's file is missing or unusable
// (a new adopter, a deleted or corrupted file) the guard protects with the
// framework's canonical copy, aiteam/templates/tier-rules.json, and says so in the
// reason — it no longer lets everything through. Tier-3 deploy commands (ask_patterns
// subset) surface the native one-shot approval prompt ("ask"); any other Tier-3
// command is denied while SPEC.md's `tier_defaults.allow_tier3` is false.
//
// This turns the prose tiers in AGENTS.md into an enforced gate: a deploy needs
// a human click in chat per command, and destructive commands still need a human
// flipping allow_tier3 in SPEC.md (break-glass).
//
// It also asks for confirmation when a shell command WRITES to a file of the gate itself — SPEC.md's
// `tier_defaults`/`allow_tier3`, .claude/tier-rules.json, the hooks and permissions of .claude/settings.json
// (F13, aiteam/src/gate-files-core.mjs): `sed -i`, `>`, `Set-Content`, `cp`/`mv` over it, `tee`, `node -e
// writeFileSync`. The same files edited by Write/Edit/MultiEdit/NotebookEdit are covered by
// aiteam/hooks/gate-edit-guard.mjs. The ASK is the approval; the break-glass does not waive it.
//
// THE HOOK NEVER FAILS OPEN BY ITSELF. Claude Code treats a hook that crashes (exit 1
// with no JSON) or times out as a NON-blocking error: the command runs with the gate
// off. Two things used to cause that, and both are closed here:
//
//  1. A DEADLINE on the classification (DEADLINE_MS). Whoever writes the command picks
//     how long a pattern takes on it — rewriting the patterns one by one never ends (the
//     exponential ssh one was fixed, the next one was cubic). The whole classification
//     runs under a watchdog and, when it overruns, the command is DENIED with a message
//     asking to split it: a line the guard cannot read in time is not one it can let
//     through.
//
//  2. An unexpected exception (a bug in the classifier or the loader, a vendor module
//     that is corrupt or missing, a throw from a promise or a timer). The PO's decision
//     (F3): apply the FIXED FLOOR — recursive+force `rm` and `git push --force` are
//     denied — let the rest through, and say so in `systemMessage` (the user sees it)
//     and on stderr. Not "deny everything": that would lock out the repair (`git
//     checkout`, `node aiteam/install.mjs`); not "allow everything" either. The floor is
//     the same one the guard falls back to when no rules are usable (tier-core.mjs,
//     floorDenyCulprit). Last resort, a DECISION on record: if the floor itself cannot be
//     evaluated (it throws), the command is DENIED with a clear message — nothing is left
//     that could vouch for it, and that state needs a human to repair the aiteam/ folder.
//     tier-core.mjs and the loader are loaded with import() for exactly this reason: a
//     static import that fails would kill the hook before any handler exists. When
//     tier-core.mjs itself does not load, the hook applies a coarse copy of the floor
//     that it carries (coarseFloorCulprit) — tier-guard-hook.test.ts pins it to the
//     tier-core one.

import * as fs from "fs";
import * as path from "path";
import * as vm from "node:vm";

const REPO = process.cwd();

// The classification budget, in ms. Measured on 59 thousand real commands the
// slowest took 6 ms, and the attacks the budget exists for (a 64 KB payload against
// a cubic pattern) are cut at ~2.1 s, well inside the hook's own timeout.
const DEADLINE_MS = 2000;
const TIMEOUT_CODE = "ERR_SCRIPT_EXECUTION_TIMEOUT";

// AITEAM_TIER_GUARD_DEADLINE_MS shortens the budget (the tests use it to avoid waiting
// 2 s per case). It can only go DOWN: raising it would weaken the gate, and the hook's
// environment is the user's, which the agent can influence (settings.json `env`).
function deadlineMs() {
  const raw = Number(process.env.AITEAM_TIER_GUARD_DEADLINE_MS);
  return Number.isFinite(raw) && raw >= 1 && raw < DEADLINE_MS ? Math.floor(raw) : DEADLINE_MS;
}

// Tools whose tool_input.command is a command line the engine executes. Bash
// alone was not enough (issue #12): on Windows the PowerShell tool ran a deploy
// with no ASK and `Remove-Item -Recurse -Force` with no deny, and Monitor runs
// its `command` through the same shell. The desktop app's terminal tool has its
// own approval prompt, but not these deny rules. Dispatch is by tool name, so a
// tool that merely has a `command` field is never classified. The matching
// settings.json entries live in FRAMEWORK_SETTINGS (aiteam/src/install-core.mjs).
const COMMAND_TOOLS = new Set(["Bash", "PowerShell", "Monitor", "mcp__terminal__run_in_terminal"]);

// State the failure path needs. `command` is set as soon as there is one to classify; `core`
// is the tier-core module once it has loaded (null when it did not).
let command = null;
let core = null;
let failing = false;

// Output. writeSync, not process.stdout.write: the failure path can run from an
// uncaughtException handler and the process exits right after, and an async pipe write
// that has not flushed is lost.
function write(fd, text) {
  const buffer = Buffer.from(text);
  let offset = 0;
  for (let attempt = 0; offset < buffer.length && attempt < 200; attempt++) {
    try {
      offset += fs.writeSync(fd, buffer, offset);
    } catch (e) {
      if (e?.code !== "EAGAIN") return; // the pipe is gone: nobody to tell
    }
  }
}

function emit(object) {
  write(1, JSON.stringify(object));
  process.exit(0);
}

function allow() {
  // Empty object = no decision; let normal permission flow proceed.
  emit({});
}

function decide(permissionDecision, reason) {
  emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason: reason } });
}

const deny = (reason) => decide("deny", reason);
const ask = (reason) => decide("ask", reason);

// Allow, but tell the user (systemMessage) and the log (stderr): the gate ran degraded.
function warnAllow(message) {
  write(2, `${message}\n`);
  emit({ systemMessage: message });
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// The break-glass. A SPEC.md that cannot be read, or a tier-core that did not load, is false.
function breakGlass() {
  try {
    return core ? core.allowTier3FromSpec(fs.readFileSync(path.resolve(REPO, "SPEC.md"), "utf8")) : false;
  } catch {
    return false;
  }
}

// ---- the failure path (F3) -------------------------------------------------------------

const BREAK_GLASS_HINT = "Set tier_defaults.allow_tier3: true in SPEC.md after explicit human approval to permit it.";

// A coarse copy of tier-core's floor (isRecursiveForceRm, isForcePush) over the whole text,
// for when tier-core.mjs does not load and there is no splitter to lean on. Coarser than the
// real one — it also denies a quoted `rm -rf` —, never looser. Pinned to tier-core by
// tier-guard-hook.test.ts.
function coarseFloorCulprit(text) {
  const whole = String(text).trim();
  const recursive = /(^|\s)-[a-z]*r/i.test(whole) || /\s--recursive\b/.test(whole);
  const force = /(^|\s)-[a-z]*f/i.test(whole) || /\s--force\b/.test(whole);
  const rm = /\brm\b/.test(whole) && recursive && force;
  const push = /\bgit\b/.test(whole) && /\bpush\b/.test(whole) && /--force\b/.test(whole) && !/--force-with-lease\b/.test(whole);
  return rm || push ? whole : null;
}

function describe(error) {
  let text;
  try {
    text = String(error?.message ?? error);
  } catch {
    text = "unprintable error";
  }
  return text.replace(/\s+/g, " ").slice(0, 200);
}

// Something threw that nobody planned for. Never throws, never lets the process end any other
// way than a decision on stdout.
function failClosed(error) {
  if (failing) lastResortDeny();
  failing = true;
  try {
    const why = describe(error);
    if (command === null) {
      // Nothing to classify yet: the payload was not read, or it carries no command line.
      warnAllow(`aiteam tier-guard: internal error before a command was read (${why}); nothing was classified.`);
    }
    let culprit;
    try {
      culprit = core ? core.floorDenyCulprit(command) : coarseFloorCulprit(command);
    } catch (floorError) {
      deny(
        `Tier 3 gate hit an internal error (${why}) and could not even apply its fixed floor (${describe(floorError)}): ` +
          `the command is denied, because nothing is left that could vouch for it. ` +
          `Repair the aiteam/ folder (node aiteam/install.mjs) and run node aiteam/scripts/doctor.mjs.`
      );
    }
    if (culprit !== null && !breakGlass()) {
      deny(
        `Tier 3 (critical) command blocked by aiteam/hooks/tier-guard.mjs: "${culprit}". ${BREAK_GLASS_HINT} ` +
          `(The guard hit an internal error and could not classify the command, so only its fixed floor applied: ${why}. ` +
          `Run node aiteam/scripts/doctor.mjs.)`
      );
    }
    warnAllow(
      `aiteam tier-guard: internal error while classifying this command (${why}); only the fixed floor (rm -rf and ` +
        `git push --force) was applied, so the Tier-3 patterns (drop table, deploys...) did NOT run on it. ` +
        `Run node aiteam/scripts/doctor.mjs and repair the guard.`
    );
  } catch {
    lastResortDeny();
  }
}

// The failure path failed too (or ran twice). Hard-coded text, no dependency on anything.
function lastResortDeny() {
  write(
    1,
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "Tier 3 gate failed while handling an internal error: the command is denied. Run node aiteam/scripts/doctor.mjs.",
      },
    })
  );
  process.exit(0);
}

process.on("uncaughtException", failClosed);
process.on("unhandledRejection", failClosed);

// ---- the classification -----------------------------------------------------------------

// Runs the decision AND, for a deny, the explanation (it classifies again) under the
// deadline. The vm watchdog interrupts a regex that is backtracking: the regexes are
// created in the host realm and called from a host function, which still counts as
// running inside runInContext (measured on Node 22). Throws an error whose `code` is
// ERR_SCRIPT_EXECUTION_TIMEOUT when the budget is spent.
//
// F13: the same run also asks gate-files-core whether a sub-command WRITES to a gate file (SPEC.md's
// tier_defaults/allow_tier3, .claude/tier-rules.json, the hooks and permissions of .claude/settings.json).
// That is its own ASK, whatever the Tier-3 verdict (the break-glass does not waive it). A failure of that
// detection — the module did not load, or it threw — does not take the Tier-3 classification down with it:
// it comes back as `gateError`, and a command the classifier lets through then carries a warning.
function classifyWithDeadline(command, rules, allow, ms, gate) {
  const context = vm.createContext({
    run: () => {
      const decision = core.guardDecision(command, rules, allow);
      if (decision === "deny") return { decision, ...core.explainDeny(command, rules) };
      let gateWrite = null;
      let gateError = null;
      if (gate) {
        try {
          gateWrite = gate.gateWriteInCommand(command, {
            split: core.splitSubCommands,
            cwd: REPO,
            isFrameworkRoot,
            realpath,
            read: readPatch,
            guardCode: gate.guardCodeMatcher(REPO, guardFs, { upstream: process.env.AITEAM_UPSTREAM === "1" }),
          });
        } catch (e) {
          gateError = describe(e);
        }
      }
      return { decision, gateWrite, gateError };
    },
  });
  return vm.runInContext("run()", context, { timeout: ms });
}

// A directory that is the root of a framework repo (a worktree, another checkout): it has .claude/ or aiteam/.
function isFrameworkRoot(dir) {
  return fs.existsSync(path.join(dir, ".claude")) || fs.existsSync(path.join(dir, "aiteam"));
}

// The file a path really is, through symlinks and junctions: a link named notes.md that points at SPEC.md
// is SPEC.md. A file that does not exist yet takes the real path of its nearest existing parent
// (`junction/new.json` is `.claude/new.json`); null when nothing resolves.
function realpath(p) {
  let probe = path.resolve(REPO, p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(probe), ...rest.slice().reverse());
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      rest.push(path.basename(probe));
      probe = parent;
    }
  }
}

// File system access for the matcher of the gate's own code (a consumer's aiteam/hooks and the modules they import).
const guardFs = {
  exists: (p) => fs.existsSync(p),
  read: (p) => {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  list: (dir) => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  },
};

// The text of a patch file the command applies (git apply, patch), so the paths it touches can be read.
// Capped: a patch is text, and the guard has a deadline.
function readPatch(p) {
  try {
    const file = path.resolve(REPO, p);
    if (fs.statSync(file).size > 4_000_000) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin() || "{}");
  } catch {
    return allow();
  }

  if (!COMMAND_TOOLS.has(payload?.tool_name)) return allow();

  // Monitor may carry a WebSocket source (`ws`) instead of a command — nothing to
  // classify then.
  const line = payload?.tool_input?.command;
  if (typeof line !== "string" || !line) return allow();
  command = line;

  // import(), not a static import: see the header (a module that fails to load must
  // reach the failure path, not kill the hook).
  core = await import("../src/tier-core.mjs");
  const loader = await import("../src/tier-rules-loader.mjs");
  // The gate-file detection loads on its own: a corrupt gate-files-core.mjs must not take the Tier-3
  // patterns down with it. Its absence is a warning on what gets through (see below).
  let gate = null;
  let gateProblem = null;
  try {
    gate = await import("../src/gate-files-core.mjs");
  } catch (e) {
    gateProblem = describe(e);
  }

  const loaded = loader.loadTierRulesWithFallback(REPO);
  // Last resort (the PO's decision): neither the project's map nor the framework's
  // canonical copy is usable (a broken vendor). The guard goes on with EMPTY rules,
  // so only the fixed floor of tier-core.mjs applies — `rm -rf` (recursive+force) and
  // `git push --force` are still denied, while what only a pattern catches (drop
  // table, a deploy) passes. It does not deny everything: that would lock out the
  // repair (`git checkout`, `node aiteam/install.mjs`). And it does not allow
  // everything. The doctor fails and the session brief warns in this state.
  const rules = loaded.rules ?? {};
  // When something other than the project's map decides, say so in the reason.
  const note =
    loaded.source === "framework"
      ? loader.frameworkRulesNote(loaded.problem)
      : loaded.source === "none"
        ? loader.noRulesNote(loaded.problem)
        : "";

  const ms = deadlineMs();
  let verdict;
  try {
    verdict = classifyWithDeadline(command, rules, breakGlass(), ms, gate);
  } catch (e) {
    if (e?.code !== TIMEOUT_CODE) return failClosed(e);
    return deny(
      `Tier 3 gate could not classify this command within ${ms} ms (it is too large or too intricate for the guard to read), ` +
        `and what the guard cannot read it does not let through. Split it into smaller commands and run them one at a time.${note}`
    );
  }

  if (verdict.decision === "deny") {
    // Quote the part that blocks, not the whole line, and give the advice for its
    // class (tier3.deny_hints, falling back to the break-glass instruction).
    return deny(`Tier 3 (critical) command blocked by aiteam/hooks/tier-guard.mjs: "${verdict.culprit}". ${verdict.hint}${note}`);
  }
  if (verdict.decision === "ask") {
    const alsoGate = verdict.gateWrite ? ` It also writes a gate file: "${verdict.gateWrite.sub}" (${verdict.gateWrite.why}).` : "";
    return ask(
      `Tier 3 deploy command — one-shot human approval required: "${command}". ` +
        `Approve in chat to run it once; headless sessions fail closed.${alsoGate}${note}`
    );
  }
  // F13: a write to a gate file asks, whatever the Tier-3 verdict — the break-glass lifts the Tier-3
  // patterns, it does not make rewriting the gate free.
  if (verdict.gateWrite) {
    return ask(
      `Gate file write — one-shot human approval required: "${verdict.gateWrite.sub}" (${verdict.gateWrite.why}). ` +
        `Approve in chat to run it once; headless sessions fail closed.${note}`
    );
  }
  if (gateProblem !== null || verdict.gateError) {
    return warnAllow(
      `aiteam tier-guard: gate-file write detection unavailable (${gateProblem ?? verdict.gateError}); the Tier-3 classification ran normally. ` +
        `Run node aiteam/scripts/doctor.mjs and repair the aiteam/ folder.`
    );
  }
  return allow();
}

main().catch(failClosed);
