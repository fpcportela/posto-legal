// Pure, dependency-free health checks for `aiteam doctor`. Each check takes an
// already-parsed config object and returns { name, pass, detail }. The CLI shell
// (aiteam/scripts/doctor.mjs) does the file I/O and the dynamic checks (live hook
// deny, validate:beads) on top of these. Keeping the logic pure makes it testable
// without touching the filesystem.

import { evaluateCiContract } from "./ci-contract-core.mjs";
import { evaluateDeployContract } from "./deploy-contract-core.mjs";
import { extractFrontmatter } from "./frontmatter.mjs";
import { readAllowTier3 } from "./tier-core.mjs";

function norm(s) {
  return String(s ?? "").replace(/\\/g, "/");
}

// Tools that execute a command the tier-guard must see. A guard wired only for
// Bash passed this check while PowerShell ran deploys with no ASK and
// destructive commands with no deny (issue #12). The desktop app's terminal tool
// is wired by install too, but it only exists in the desktop app, so a
// CLI-only consumer is not failed over it.
const TIER_GUARD_TOOLS = ["Bash", "PowerShell", "Monitor"];

// Claude Code's own matcher semantics (hooks reference): "*", "" or no matcher
// match every tool; a matcher made only of letters, digits, "_", "-", spaces,
// "," and "|" is a list of exact names; anything else is an unanchored regex.
function matcherCovers(matcher, tool) {
  const m = String(matcher ?? "");
  if (m === "" || m === "*") return true;
  if (/^[\w\s,|-]+$/.test(m)) return m.split(/[|,]/).some((name) => name.trim() === tool);
  try {
    return new RegExp(m).test(tool);
  } catch {
    return false;
  }
}

export function checkSettings(settings) {
  const entries = settings?.hooks?.PreToolUse ?? [];
  const guardMatchers = entries
    .filter((e) => (e?.hooks ?? []).some((h) => /aiteam\/hooks\/tier-guard\.mjs/.test(norm(h?.command))))
    .map((e) => e?.matcher);
  const uncovered = TIER_GUARD_TOOLS.filter((tool) => !guardMatchers.some((m) => matcherCovers(m, tool)));
  const pass = uncovered.length === 0;
  return {
    name: ".claude/settings.json PreToolUse tier-guard",
    pass,
    detail: pass
      ? `PreToolUse runs aiteam/hooks/tier-guard.mjs for ${TIER_GUARD_TOOLS.join(", ")}`
      : `aiteam/hooks/tier-guard.mjs is not a PreToolUse hook for ${uncovered.join(", ")} — commands run through ` +
        `${uncovered.length === 1 ? "that tool" : "those tools"} skip the Tier-3 gate. Run: npm --prefix aiteam run install:framework`,
  };
}

// Sibling of checkSettings, not a branch inside it: the two hooks are wired by
// separate FRAMEWORK_SETTINGS entries (different matcher) and can drift out of
// sync independently — install-core.test.ts pins FRAMEWORK_SETTINGS itself, but
// nothing previously caught a CONSUMER whose settings.json fell out of date
// (stale install, hand-edited file). Kept as its own row so doctor's output
// stays one-hazard-per-line instead of folding two unrelated wirings into a
// single pass/fail.
export function checkInfraKbGuardSettings(settings) {
  const entries = settings?.hooks?.PreToolUse ?? [];
  const pass = entries.some(
    (e) =>
      norm(e?.matcher) === "Write|Edit" &&
      (e?.hooks ?? []).some((h) => /aiteam\/hooks\/infra-kb-guard\.mjs/.test(norm(h?.command)))
  );
  return {
    name: ".claude/settings.json PreToolUse infra-kb-guard",
    pass,
    detail: pass
      ? "Write|Edit PreToolUse hook runs aiteam/hooks/infra-kb-guard.mjs"
      : "no Write|Edit PreToolUse hook references aiteam/hooks/infra-kb-guard.mjs — run: node aiteam/install.mjs",
  };
}

// The tools that edit a file and that the gate-edit-guard (F13) must cover: the beads-guard and the
// infra-kb-guard only look at Write|Edit, but MultiEdit and NotebookEdit edit files too.
const GATE_EDIT_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

// Sibling of checkSettings and checkInfraKbGuardSettings: the gate-edit-guard has its OWN entry in
// FRAMEWORK_SETTINGS (a consumer that synced the vendor and did not re-run the install lacks it, and then
// the files that ARE the gate — SPEC.md's tier_defaults/allow_tier3, .claude/tier-rules.json, the hooks and
// permissions of .claude/settings.json — are edited with nobody asked).
export function checkGateEditGuardSettings(settings) {
  const entries = settings?.hooks?.PreToolUse ?? [];
  const matchers = entries
    .filter((e) => (e?.hooks ?? []).some((h) => /aiteam\/hooks\/gate-edit-guard\.mjs/.test(norm(h?.command))))
    .map((e) => e?.matcher);
  const uncovered = GATE_EDIT_TOOLS.filter((tool) => !matchers.some((m) => matcherCovers(m, tool)));
  const pass = uncovered.length === 0;
  return {
    name: ".claude/settings.json PreToolUse gate-edit-guard",
    pass,
    detail: pass
      ? `PreToolUse runs aiteam/hooks/gate-edit-guard.mjs for ${GATE_EDIT_TOOLS.join(", ")}`
      : `aiteam/hooks/gate-edit-guard.mjs is not a PreToolUse hook for ${uncovered.join(", ")} — edits made through ` +
        `${uncovered.length === 1 ? "that tool" : "those tools"} change SPEC.md's break-glass, .claude/tier-rules.json or the hooks and ` +
        `permissions with nobody asked. Run: node aiteam/install.mjs`,
  };
}

/**
 * The live sample of the gate-edit-guard: the real hook, given a Write to .claude/tier-rules.json, must
 * answer ask. `decision` is what readGateEditDecision (doctor-io.mjs) got: "ask" | "allow" | "deny", or
 * null when the hook did not answer (missing, no JSON, hung). A stale vendor copy, or a hook that fell
 * back to silence, would pass the wiring check above and still ask nobody.
 *
 * @param {{decision: "ask"|"allow"|"deny"|null}} input
 */
export function checkGateEditSample({ decision }) {
  const name = "gate-edit-guard asks before an edit of .claude/tier-rules.json";
  if (decision === "ask") return { name, pass: true, detail: "a Write to .claude/tier-rules.json → ask" };
  return {
    name,
    pass: false,
    detail:
      `a Write to .claude/tier-rules.json got ${decision ?? "no decision"} from aiteam/hooks/gate-edit-guard.mjs, not ask: ` +
      `the hook is missing, stale or broken — restore the aiteam/ vendor folder and run node aiteam/install.mjs`,
  };
}

// Is the repo the framework's own (rb-ai-team)? By the last segment of its origin URL: owner and host do not
// matter, and a fork called rb-ai-team is the upstream's development too.
const UPSTREAM_ORIGIN = /(?:^|[/:\\])rb-ai-team(?:\.git)?[/\\]?$/i;

/**
 * AITEAM_UPSTREAM (in the `env` of .claude/settings.json or settings.local.json) turns OFF the ASK on edits of
 * the gate's own code (aiteam/hooks, their imports, the canonical tier-rules template): it exists for the
 * framework's own repo, where that code is developed. Only the rb-ai-team repo has it. A project born from "Use
 * this template" copies the whole .claude/settings.json and would start with the exemption on, and the install
 * never removes a key it did not write. So: on + an origin that is not rb-ai-team (or no origin at all) is a WARN.
 * It is an alert for the human, not the protection — the origin URL can be forged; the protection is the ASK on an
 * edit of settings.json, which an agent has to get past to put the variable there.
 *
 * Returns null when the variable is off (nothing to say), a PASS row when it is on in rb-ai-team, a WARN otherwise.
 *
 * @param {{settings: object|null, local: object|null, origin: string|null}} facts the parsed settings files
 *   and the URL of `origin` (null when there is none)
 */
export function checkUpstreamFlag({ settings, local, origin }) {
  const on = [
    [".claude/settings.json", settings],
    [".claude/settings.local.json", local],
  ].filter(([, file]) => file && typeof file === "object" && file.env && typeof file.env === "object" && String(file.env.AITEAM_UPSTREAM) === "1");
  if (on.length === 0) return null;
  const where = on.map(([file]) => file).join(" and ");
  const name = "AITEAM_UPSTREAM is on only in the rb-ai-team repo";
  const url = typeof origin === "string" ? origin.trim() : "";
  if (url !== "" && UPSTREAM_ORIGIN.test(url)) {
    return { name, pass: true, detail: `AITEAM_UPSTREAM=1 in ${where}, origin is ${url}: edits of the gate's own code are developed here without an ASK` };
  }
  return {
    name,
    pass: true,
    warn: true,
    detail:
      `AITEAM_UPSTREAM=1 is set in ${where}, but ${url === "" ? "this repo has no origin" : `origin is ${url}, not rb-ai-team`}: ` +
      `it switches OFF the ask on edits of aiteam/hooks, the modules they import and aiteam/templates/tier-rules.json. ` +
      `A project made from the template inherits it. If this is not the framework's own repo, remove "AITEAM_UPSTREAM" from the "env" of ${where}`,
  };
}

export function checkMcp(mcp) {
  const servers = mcp?.mcpServers ?? {};
  const pass = Object.values(servers).some((s) =>
    (s?.args ?? []).some((a) => /aiteam\/mcp\/server\.ts/.test(norm(a)))
  );
  return {
    name: ".mcp.json server entry",
    pass,
    detail: pass
      ? "an mcpServers entry runs aiteam/mcp/server.ts"
      : "no server references aiteam/mcp/server.ts",
  };
}

/**
 * AGENTS.md §CI/CD Mandate, item 1, judged by the same core the contract test
 * uses (ci-contract-core.mjs, rb-ai-team#31): every command SPEC.md declares
 * in its `ci:` block runs in a pull_request workflow, in the declared workdir.
 * A `fail` finding fails the row; a `warn` one (the `test: none` opt-out and
 * its reason, a path-filtered or continue-on-error step) passes it as WARN, so
 * the opt-out stays visible.
 *
 * `workflowsUnavailable` is why the shell could not parse .github/workflows
 * (no js-yaml in a checkout without node_modules): the `ci:` block and the
 * package.json delegation are still judged — that reader needs no package —
 * and only the workflow lookup degrades to WARN.
 *
 * @param {{specText: string|null|undefined,
 *          workflows: Array<{file: string, doc?: unknown, error?: string}>|null,
 *          readScripts?: (dir: string) => Record<string, unknown>|null|undefined,
 *          workflowsUnavailable?: string|null,
 *          rootManifests?: string[]}} input
 *   rootManifests: the app manifests the shell found at the repo root
 *   (isAppManifest); with one, a ci.workdir inside aiteam/ fails.
 */
export function checkCiContract({ specText, workflows, readScripts, workflowsUnavailable = null, rootManifests = [] }) {
  const name = "SPEC.md ci: — the PR pipeline runs the declared commands";
  const r = evaluateCiContract({
    specText,
    workflows: workflowsUnavailable ? null : workflows,
    readScripts,
    rootManifests,
  });
  const message = (f) =>
    f.key === "workflows" && workflowsUnavailable ? `workflows não conferidos — ${workflowsUnavailable}` : f.message;
  const fails = r.findings.filter((f) => f.level === "fail").map(message);
  const warns = r.findings.filter((f) => f.level === "warn").map(message);
  const where = r.located.map(
    (l) =>
      `${l.key} \`${l.command}\` → ${l.where
        .map((w) => [...w.via, `${w.file} › ${w.job}`].join(" → "))
        .join(", ")}`,
  );
  if (fails.length > 0) return { name, pass: false, detail: fails.join(" | ") };
  // O portão local (rb-ai-team#51) não roda em workflow nenhum: aparece como é,
  // só local, para ninguém lê-lo como a cobertura do PR.
  const localGate =
    r.block.state === "ok" && r.block.ci.local_test
      ? [`local_test \`${r.block.ci.local_test.trim()}\` → só local (o TDD dos agentes); o CI roda o test completo`]
      : [];
  return {
    name,
    pass: true,
    ...(warns.length > 0 ? { warn: true } : {}),
    detail: [...warns, ...where, ...localGate].join(" | ") || "nothing declared to locate",
  };
}

/**
 * AGENTS.md §CI/CD Mandate, the fixed deploy contract, judged by the same core
 * the contract test uses (deploy-contract-core.mjs, rb-ai-team#32). It reads
 * the workflow SPEC.md declares in its `deploy:` block, statically: the `ref`
 * input (or the SHA resolved from it) reaches a step that talks to the host,
 * a step compares `version_url` with that SHA and can fail the job, and a job
 * with contents: write pushes a `deploy/` tag after it. A pass means wired,
 * not working: scripts on the host that the workflow does not name stay out
 * of sight. It answers step 1 of the Release Loop before a release depends on
 * it. The `workflow: none` opt-out passes as WARN with its reason.
 *
 * `workflowsUnavailable` is why the shell could not parse .github/workflows
 * (no js-yaml): the `deploy:` block is still judged and only the workflow
 * check degrades to WARN.
 *
 * @param {{specText: string|null|undefined,
 *          workflows: Array<{file: string, doc?: unknown, error?: string}>|null,
 *          readFile?: (rel: string) => string|null|undefined,
 *          workflowsUnavailable?: string|null}} input
 */
export function checkDeployContract({ specText, workflows, readFile, workflowsUnavailable = null }) {
  const name = "SPEC.md deploy: — deploy workflow, read statically: ref to the host, SHA compared at version_url, deploy/ tag after it";
  const r = evaluateDeployContract({ specText, workflows: workflowsUnavailable ? null : workflows, readFile });
  const message = (f) =>
    f.key === "workflows" && workflowsUnavailable ? `workflow não conferido — ${workflowsUnavailable}` : f.message;
  const fails = r.findings.filter((f) => f.level === "fail").map(message);
  const warns = r.findings.filter((f) => f.level === "warn").map(message);
  const where = r.located.map((l) => `${l.key} → ${l.where}`);
  if (fails.length > 0) return { name, pass: false, detail: fails.join(" | ") };
  return {
    name,
    pass: true,
    ...(warns.length > 0 ? { warn: true } : {}),
    detail: [...warns, ...where].join(" | ") || "nothing declared to locate",
  };
}

// Why a pattern would be skipped by the guard (aiteam/src/tier-core.mjs
// compilePatterns), or null when it compiles the way the guard compiles it.
function patternProblem(p) {
  if (typeof p !== "string") return "not a string";
  // `""` compiles, and matches every command: in tier3.patterns it would deny even `ls`, in
  // ask_patterns it would turn every Tier-3 command into an ask. The guard skips it.
  if (p.trim() === "") return "empty or whitespace-only: it matches every command, so the guard skips it";
  try {
    // The guard also runs the pattern once on "" (tier-core compileList): V8 compiles lazily, so a pattern can parse and
    // still throw at its first use ("Regular expression too large", "Stack overflow"), and the guard skips it.
    new RegExp(p, "i").test("");
    return null;
  } catch (e) {
    // The message of a huge pattern repeats the pattern: keep the start of it.
    return String(e?.message ?? e).slice(0, 160);
  }
}

// Commands no Tier-3 or Tier-2 pattern should match: a pattern that matches "" or ALL of these
// matches every command. The guard APPLIES such a pattern (it is not skipped); in tier3.patterns it
// denies everything, and in ask_patterns it promotes nothing since the A3 fix (tier-core, tier3Verdict).
// The file is still wrong, and the guard cannot say so.
const ORDINARY_COMMANDS = ["ls -la", "git status", "echo hello", "node -v"];

function matchesEveryCommand(p) {
  const re = new RegExp(p, "i");
  return re.test("") || ORDINARY_COMMANDS.every((c) => re.test(c));
}

// Every entry the guard skips, named by where it lives. The guard skips them
// instead of crashing (a crashed hook lets the command run), so without this
// row a typo would silently switch its rule off. Also the entries it applies
// but that match every command (`.*`, `^`, `x*`: A3), which are as wrong.
function tierRulesProblems(rules) {
  const problems = [];
  const lists = [
    ["tier3.patterns", rules?.tier3?.patterns, true],
    ["tier3.ask_patterns", rules?.tier3?.ask_patterns, false],
    ["tier2.patterns", rules?.tier2?.patterns, true],
  ];
  for (const [where, list, required] of lists) {
    if (list === undefined && !required) continue;
    if (!Array.isArray(list)) {
      if (list !== undefined) problems.push(`${where} is not a list`);
      continue;
    }
    list.forEach((p, i) => {
      const why =
        patternProblem(p) ??
        (matchesEveryCommand(p)
          ? "matches every command (the empty string, or `ls`, `git status`...): a Tier-3 pattern like that denies everything, and one in ask_patterns promotes nothing"
          : null);
      if (why) problems.push(`${where}[${i}] ${JSON.stringify(p)} (${why})`);
    });
  }

  const hints = rules?.tier3?.deny_hints;
  if (hints !== undefined && !Array.isArray(hints)) problems.push("tier3.deny_hints is not a list");
  (Array.isArray(hints) ? hints : []).forEach((h, i) => {
    const where = `tier3.deny_hints[${i}]`;
    const usable =
      typeof h?.match === "string" && h.match.trim() !== "" && typeof h?.hint === "string" && h.hint.trim() !== "";
    if (!usable) {
      problems.push(`${where} (needs a non-empty "match" and "hint")`);
      return;
    }
    const why = patternProblem(h.match);
    if (why) problems.push(`${where}.match ${JSON.stringify(h.match)} (${why})`);
  });
  return problems;
}

// How many entries the guard can actually apply (compiles, and is not blank) — the same
// rule as compilePatterns in tier-core.mjs, restated here because this module stays pure.
function appliedCount(list) {
  return Array.isArray(list) ? list.filter((p) => typeof p === "string" && patternProblem(p) === null).length : 0;
}

// What the ask_patterns subset needs beyond each entry compiling. The guard consults it
// only AFTER a tier3.patterns entry matched (tier3Verdict), so:
//  - an ask_pattern that is not in tier3.patterns never fires: the command it should ask
//    about is not Tier 3 at all and runs with no prompt (the template documents the
//    subset as an invariant and a test checked the template; a consumer's file was not
//    checked). Compared by exact string, like the coverage check.
//  - ask_patterns present as a list but with nothing the guard can apply (empty, or only
//    entries that do not compile or are blank) leaves no deploy able to ask, so every
//    Tier-3 deploy is denied and only the GLOBAL break-glass releases it. An ABSENT
//    ask_patterns is the legacy mode (fail closed, on purpose): not flagged here — the
//    dynamic sample-deploy check and the coverage WARN already say it.
// Entries that do not compile are named by tierRulesProblems; they are not repeated here.
function askPatternsProblems(rules) {
  const ask = rules?.tier3?.ask_patterns;
  if (!Array.isArray(ask)) return [];
  const problems = [];
  if (appliedCount(ask) === 0) {
    problems.push(
      "tier3.ask_patterns has no pattern the guard can apply, so no deploy can ask for approval and every Tier-3 deploy is denied " +
        "(only the global break-glass allow_tier3 releases it) — copy tier3.ask_patterns from aiteam/templates/tier-rules.json"
    );
  }
  const patterns = Array.isArray(rules?.tier3?.patterns) ? rules.tier3.patterns : null;
  if (patterns) {
    ask.forEach((p, i) => {
      if (typeof p !== "string" || patternProblem(p) !== null || patterns.includes(p)) return;
      problems.push(
        `tier3.ask_patterns[${i}] ${JSON.stringify(p)} is not in tier3.patterns: a command that matches it but not tier3.patterns ` +
          "is not Tier 3 at all, so no approval prompt ever fires and the command runs — add it to tier3.patterns (ask_patterns ⊆ patterns)"
      );
    });
  }
  return problems;
}

export function checkTierRules(rules) {
  const ok = (band) => Array.isArray(band?.patterns) && band.patterns.length > 0;
  const bandsOk = ok(rules?.tier3) && ok(rules?.tier2);
  const problems = tierRulesProblems(rules);
  const askProblems = askPatternsProblems(rules);
  const pass = bandsOk && problems.length === 0 && askProblems.length === 0;
  const details = [];
  if (!bandsOk) details.push("tier3/tier2 patterns missing or empty");
  if (problems.length) details.push(`the guard skips these entries, so their rule protects nothing: ${problems.join("; ")}`);
  if (askProblems.length) details.push(askProblems.join("; "));
  return {
    name: ".claude/tier-rules.json well-formed",
    pass,
    detail: pass
      ? "tier3 and tier2 bands carry patterns, every pattern compiles, and ask_patterns ⊆ tier3.patterns"
      : details.join(" — "),
  };
}

const TIER_RULES_CHECK_NAME = ".claude/tier-rules.json well-formed";
const CANONICAL_RULES_PATH = "aiteam/templates/tier-rules.json";

/**
 * O arquivo .claude/tier-rules.json do projeto: existe, lê e está bem formado.
 * O guard não libera mais tudo sem ele — cai na cópia canônica do framework
 * (aiteam/templates/tier-rules.json) —, mas o projeto ficou sem o arquivo dele,
 * então o doctor reprova e diz o que o guard está fazendo. Os fatos vêm de
 * readTierRulesFacts (doctor-io.mjs); aqui só o julgamento, puro.
 *
 * @param {{project: {rules: object|null, problem: string|null, detail: string|null}, canonical: {rules: object|null, detail: string|null}}} facts
 */
export function checkTierRulesFile({ project, canonical }) {
  const name = TIER_RULES_CHECK_NAME;
  if (project?.rules) return checkTierRules(project.rules);

  // Nem a cópia canônica serve (vendor incompleto): não há mapa nenhum, e o
  // guard segue com regras vazias — só o piso fixo do tier-core protege (decisão
  // do PO: não nega tudo, que travaria o conserto, nem libera tudo).
  if (!canonical?.rules) {
    return {
      name,
      pass: false,
      detail:
        `${project?.detail ?? "o arquivo do projeto não existe"}; e a cópia canônica do framework ` +
        `(${CANONICAL_RULES_PATH}) também não serve (${canonical?.detail ?? "ilegível"}): o guard está só com o piso fixo ` +
        `(rm -rf e force-push negados) — drop table e deploy passam sem pergunta. ` +
        `Restaure o aiteam/ (o vendor está incompleto) e rode node aiteam/install.mjs`,
    };
  }
  if (project?.problem === "unreadable") {
    return {
      name,
      pass: false,
      detail:
        `${project.detail}. O guard está usando a cópia canônica do framework (${CANONICAL_RULES_PATH}), ` +
        `sem os padrões do projeto — corrija o arquivo, ou apague-o e rode node aiteam/install.mjs para semeá-lo de novo`,
    };
  }
  return {
    name,
    pass: false,
    detail:
      `o arquivo do projeto não existe. O guard está usando a cópia canônica do framework (${CANONICAL_RULES_PATH}) — ` +
      `rode node aiteam/install.mjs para semear o .claude/tier-rules.json`,
  };
}

/**
 * O arquivo do projeto tem os padrões Tier 3 que a cópia canônica do framework
 * tem? WARN com a lista do que falta em `tier3.patterns` e `tier3.ask_patterns`
 * (string exata); nunca FAIL: o projeto pode ter tirado um padrão de propósito.
 * Devolve null quando não há o que comparar — o arquivo do projeto não serve, e
 * checkTierRulesFile já reprova.
 *
 * @param {{project: {rules: object|null}, canonical: {rules: object|null, detail: string|null}}} facts
 */
export function checkTierRulesCoverage({ project, canonical }) {
  if (!project?.rules) return null;
  const name = ".claude/tier-rules.json has the canonical Tier-3 patterns";
  if (!canonical?.rules) {
    return {
      name,
      pass: true,
      warn: true,
      detail: `não deu para comparar com a cópia canônica do framework (${CANONICAL_RULES_PATH}): ${canonical?.detail ?? "ilegível"}`,
    };
  }
  const strings = (list) => (Array.isArray(list) ? list.filter((p) => typeof p === "string") : []);
  const lists = [
    ["tier3.patterns", canonical.rules.tier3?.patterns, project.rules.tier3?.patterns],
    ["tier3.ask_patterns", canonical.rules.tier3?.ask_patterns, project.rules.tier3?.ask_patterns],
  ];
  const missing = [];
  let count = 0;
  for (const [where, want, got] of lists) {
    const have = new Set(strings(got));
    const lacking = strings(want).filter((p) => !have.has(p));
    if (lacking.length > 0) {
      count += lacking.length;
      missing.push(`${where}: ${lacking.map((p) => JSON.stringify(p)).join(", ")}`);
    }
  }
  if (missing.length === 0) {
    return { name, pass: true, detail: "every tier3.patterns and tier3.ask_patterns entry of the canonical copy is in the project's file" };
  }
  return {
    name,
    pass: true,
    warn: true,
    detail:
      `faltam ${count} padrão(ões) que a cópia canônica do framework (${CANONICAL_RULES_PATH}) tem — ${missing.join("; ")}. ` +
      `Se o projeto os tirou de propósito, ignore; senão mescle-os no .claude/tier-rules.json`,
  };
}

// A linha que um humano escreve para ligar o break-glass, citada ou não: `allow_tier3: true`.
const WRITTEN_BREAK_GLASS = /^[ \t]*allow_tier3[ \t]*:[ \t]*["']?true/im;

/**
 * O SPEC.md diz `allow_tier3: true` no frontmatter, mas o guard lê false? O leitor por linhas
 * (tier-core.mjs, readAllowTier3) recusa o que não consegue garantir — uma string de aspas que
 * atravessa linhas, um valor que continua na linha seguinte, tab na indentação, U+2028, um bloco
 * `tier_defaults:` duplicado, a chave sob outro pai — e nesses casos o break-glass fica DESLIGADO em
 * silêncio: o humano o ligou e o hook segue negando. WARN com a razão, nunca FAIL (o estado seguro é
 * o desligado, e o humano pode não ter querido ligar). null quando o texto não diz `true` ou o guard
 * concorda com ele.
 *
 * @param {{specText: string|null|undefined}} input
 */
export function checkAllowTier3Reading({ specText }) {
  if (typeof specText !== "string") return null;
  const fm = extractFrontmatter(specText);
  if (fm === null || !WRITTEN_BREAK_GLASS.test(fm)) return null;
  const { allowed, why } = readAllowTier3(specText);
  if (allowed) return null;
  return {
    name: "SPEC.md allow_tier3 is read the way it is written",
    pass: true,
    warn: true,
    detail:
      `SPEC.md spells "allow_tier3: true" but the guard reads it as false, so the break-glass is OFF and nothing said so: ` +
      `${why ?? "the value is not the bare YAML boolean true on its line (a quoted \"true\", or text after it)"}. ` +
      `Write the frontmatter as a plain block — \`tier_defaults:\` at column 0 and \`  allow_tier3: true\` under it, spaces only — ` +
      `or, if you did not mean to open the gate, ignore this.`,
  };
}

/**
 * Padrões que a cópia canônica já teve e trocou por serem catastróficos (backtracking
 * exponencial), e o que a canônica tem no lugar. O doctor usa a tabela para dizer ao
 * consumidor exatamente o que colar, em vez de só mandar "reescreva". Cada valor tem
 * de estar em tier3.patterns da cópia canônica (doctor-core.test.ts confere), e cada
 * chave tem de reprovar na sondagem.
 *
 * O de ssh: `(\s+\S+)?` também casava o próximo `-a`, então `ssh` + 36 flags levava 1 s
 * e dobrava a cada duas; o argumento agora é um token que não é ele mesmo uma flag.
 *
 * O de ssh com shell e script (`ssh host "bash ./deploy.sh"`) era CÚBICO: três escolhas livres
 * (qual `ssh`, qual shell, onde para o `[^|;&]*`), e "ssh sh " repetido levava 17,5 s a 16 KB.
 * O novo só olha o primeiro `ssh` de cada linha e o primeiro shell de cada trecho entre `|;&`.
 */
export const LEGACY_PATTERN_REPLACEMENTS = Object.freeze({
  "\\bssh\\b(\\s+-\\w+(\\s+\\S+)?)*\\s+\\S+\\s+[\"']?[~./]\\S*\\.(sh|bash)\\b":
    "\\bssh\\b(?:\\s+-\\S*(?:\\s+(?!-)\\S+)?)*\\s+\\S+\\s+[\"']?[~./]\\S*\\.(?:sh|bash)\\b",
  [String.raw`\bssh\b.*\b(bash|sh|zsh)\s+[^|;&]*\.(sh|bash)\b`]:
    String.raw`(?:^|[\n\r\u2028\u2029])(?:(?!\bssh\b)[^\n\r\u2028\u2029])*\bssh\b(?:[^|;&\n\r\u2028\u2029]*[|;&])*` +
    String.raw`(?:(?!\b(?:bash|sh|zsh)\s)[^|;&\n\r\u2028\u2029])*\b(?:bash|sh|zsh)\s[^|;&]*?\.(?:sh|bash)\b`,
});

/**
 * Todo padrão que o guard roda, uma vez cada, com os lugares do arquivo onde ele mora:
 * tier3.patterns, tier3.ask_patterns, tier2.patterns e o `match` de tier3.deny_hints.
 * Entrada que não é texto ou é vazia o guard pula, e aqui também. É a lista que o
 * doctor entrega à sondagem de ReDoS (readTierRulesProbe, doctor-io.mjs).
 *
 * @param {unknown} rules
 * @returns {Array<{source: string, where: string[]}>}
 */
export function tierRulesPatternEntries(rules) {
  const bySource = new Map();
  const add = (source, where) => {
    if (typeof source !== "string" || source === "") return;
    if (!bySource.has(source)) bySource.set(source, []);
    bySource.get(source).push(where);
  };
  const lists = [
    ["tier3.patterns", rules?.tier3?.patterns],
    ["tier3.ask_patterns", rules?.tier3?.ask_patterns],
    ["tier2.patterns", rules?.tier2?.patterns],
  ];
  for (const [name, list] of lists) {
    if (Array.isArray(list)) list.forEach((p, i) => add(p, `${name}[${i}]`));
  }
  const hints = rules?.tier3?.deny_hints;
  if (Array.isArray(hints)) hints.forEach((h, i) => add(h?.match, `tier3.deny_hints[${i}].match`));
  return [...bySource].map(([source, where]) => ({ source, where }));
}

const REGEX_SAFETY_CHECK_NAME = ".claude/tier-rules.json patterns do not backtrack catastrophically";

// "tier3.patterns[3]", "tier3.ask_patterns[1]" → "em tier3.patterns e em tier3.ask_patterns"
function listsOf(where) {
  const names = [...new Set(where.map((w) => w.replace(/\[\d+\].*$/, "")))];
  return `em ${names.join(" e em ")}`;
}

/**
 * O arquivo do projeto tem algum padrão com backtracking catastrófico? O guard roda
 * cada padrão contra o comando inteiro, e o timeout de um hook é falha ABERTA: quem
 * escreve o comando escolhe o tempo, e um comando montado para estourá-lo roda sem
 * passar pelo gate. O sync nunca sobrescreve o .claude/tier-rules.json do consumidor,
 * então o padrão antigo do ssh sobrevive ao sync — daí o doctor. Os fatos vêm de
 * readTierRulesProbe (doctor-io.mjs), que sonda cada padrão num processo filho; aqui
 * só o julgamento, puro. Sempre WARN, nunca FAIL (o projeto é dono do arquivo), e
 * nunca verde quando a sondagem não rodou ou não chegou a todos os padrões. Devolve
 * null quando não há arquivo do projeto para sondar (checkTierRulesFile já reprova).
 *
 * @param {{project: {rules: unknown},
 *          probe: {probed: number,
 *                  findings: Array<{source: string, where: string[], reason: string, ms: number, size: number, label: string}>,
 *                  hung: Array<{source: string, where: string[]}>,
 *                  unprobed: Array<{source: string, where: string[]}>,
 *                  error: string|null}}} facts
 */
export function checkTierRulesRegexSafety({ project, probe }) {
  if (!project?.rules) return null;
  const name = REGEX_SAFETY_CHECK_NAME;
  const findings = probe?.findings ?? [];
  const hung = probe?.hung ?? [];
  const unprobed = probe?.unprobed ?? [];
  const named = (e) => `${JSON.stringify(e.source)} (${e.where.join(", ")})`;

  const notes = [];
  if (probe?.error) notes.push(`a sondagem não rodou: ${probe.error}`);
  if (unprobed.length > 0) notes.push(`sem tempo para sondar: ${unprobed.map(named).join("; ")}`);
  if (findings.length === 0 && hung.length === 0) {
    if (notes.length === 0) {
      return {
        name,
        pass: true,
        detail: `${probe?.probed ?? 0} padrões sondados com entradas adversárias (flags repetidas, espaços, aspas, tokens): nenhum degenerou`,
      };
    }
    return { name, pass: true, warn: true, detail: `${notes.join(" | ")} — o que não foi sondado fica sem conferir` };
  }

  const parts = [];
  if (findings.length > 0) {
    const list = findings.map(
      (f) =>
        `${named(f)}: ${Number(f.ms).toFixed(1)} ms numa entrada de ${f.size} bytes (${f.label}) e o tempo ${
          f.reason === "budget" ? "já passa de qualquer orçamento" : "cresce a cada degrau da sondagem"
        }`,
    );
    parts.push(`backtracking catastrófico: ${list.join("; ")}`);
  }
  if (hung.length > 0) {
    parts.push(
      `o padrão travou a sondagem (não terminou nem em segundos numa entrada de poucas dezenas de bytes, o caso mais grave): ${hung.map(named).join("; ")}`,
    );
  }
  parts.push(
    "o guard roda cada padrão contra o comando inteiro, e o timeout de um hook é falha ABERTA: um comando montado para estourar o tempo roda sem passar pelo gate",
  );

  const bad = [...findings, ...hung];
  // OWN keys: `e.source` is a pattern the project wrote, and "constructor" would answer with an inherited function.
  const hasReplacement = (source) => Object.hasOwn(LEGACY_PATTERN_REPLACEMENTS, source);
  const known = bad.filter((e) => hasReplacement(e.source));
  const unknown = bad.filter((e) => !hasReplacement(e.source));
  for (const e of known) {
    parts.push(
      `troque ${JSON.stringify(e.source)} ${listsOf(e.where)} pelo padrão da cópia canônica do framework (aiteam/templates/tier-rules.json): ${JSON.stringify(LEGACY_PATTERN_REPLACEMENTS[e.source])}`,
    );
  }
  if (unknown.length > 0) {
    parts.push(
      `troque ${unknown.length === 1 ? "esse padrão" : "esses padrões"} pelo equivalente da cópia canônica do framework (aiteam/templates/tier-rules.json; compare com: git diff --no-index aiteam/templates/tier-rules.json .claude/tier-rules.json) ou reescreva com uma única leitura por token: cada volta de um laço começa num delimitador, e um argumento opcional não pode casar também o próximo flag`,
    );
  }
  return { name, pass: true, warn: true, detail: [...parts, ...notes].join(" — ") };
}

/**
 * The command tools the doctor samples the live tier-guard with. The hook dispatches by
 * tool name (COMMAND_TOOLS in aiteam/hooks/tier-guard.mjs), so a sample through Bash
 * alone proved nothing about a stale hook copy, or a dispatch that forgot PowerShell,
 * that let `Remove-Item -Recurse -Force` and a deploy run through the PowerShell tool
 * with no deny and no ASK (issue #12). Monitor and the desktop terminal share the same
 * dispatch set and the same classifier, so these two cover the shell syntaxes.
 */
export const TIER_GUARD_SAMPLE_TOOLS = Object.freeze(["Bash", "PowerShell"]);

/**
 * Judges one live sample of the tier-guard: the same command, run through every tool in
 * TIER_GUARD_SAMPLE_TOOLS, must get the expected decision from the hook. `decisions` maps
 * a tool to what the hook answered ("deny" | "ask" | "allow") or null when it did not
 * answer (missing, no JSON, hung) — see readTierGuardDecision in doctor-io.mjs.
 *
 * @param {{expected: "deny"|"ask", command: string, decisions: Record<string, string|null>}} input
 */
export function checkTierGuardSample({ expected, command, decisions }) {
  const deny = expected === "deny";
  const name = deny
    ? "tier-guard denies a sample destructive Tier-3 command"
    : "tier-guard asks for a sample deploy Tier-3 command";
  const tools = Object.keys(decisions ?? {});
  const wrong = tools.filter((tool) => decisions[tool] !== expected);
  if (tools.length > 0 && wrong.length === 0) {
    return { name, pass: true, detail: `\`${command}\` → ${expected} (${tools.join(", ")})` };
  }
  if (tools.length === 0) {
    return { name, pass: false, detail: `no decision to check for \`${command}\` — the tier-guard was not sampled` };
  }
  const got = wrong.map((tool) => `${tool} → ${decisions[tool] ?? "no decision"}`).join(", ");
  return {
    name,
    pass: false,
    detail: deny
      ? `sample destructive Tier-3 \`${command}\` was NOT denied (${got}): the gate may be down for that tool, or SPEC allow_tier3=true`
      : `sample deploy Tier-3 \`${command}\` was NOT set to ask (${got}): the gate may be down for that tool, SPEC allow_tier3=true, or ask_patterns missing`,
  };
}

/**
 * Are the framework's git hooks actually reachable? Two supported topologies:
 *
 *  - DIRECT: core.hooksPath names aiteam/githooks (what install sets when the
 *    host had none).
 *  - ROUTER: the host keeps its OWN core.hooksPath and install chains the
 *    framework hooks into it (planHookChaining's "router" action). The config
 *    then never mentions aiteam/githooks, so demanding it here failed the very
 *    topology the installer creates — `install` followed by `doctor` reported a
 *    healthy install as FAIL.
 *
 * `chainedHooks` is the list of host hooks found carrying the chain line; the
 * caller does that I/O (this module stays pure). Pass the expected roster so a
 * partial chain warns instead of silently reading as fully wired.
 */
export function checkHooksPath(hooksPath, chainedHooks = [], expectedHooks = []) {
  const n = norm(hooksPath);
  const direct = n.includes("aiteam/githooks");
  // The ONLY blessed direct value is the relative `aiteam/githooks`: git resolves
  // a relative core.hooksPath against each working tree's own root, so every git
  // worktree runs its OWN vendored hooks. An ABSOLUTE value still "contains" the
  // substring (so the old check passed it) but pins every tree to the main
  // checkout's hooks — silently defeating per-worktree hook resolution. Warn,
  // don't fail: it still works for the main checkout, so it's a latent hazard.
  const isRelativeExact = n === "aiteam/githooks";
  const routed = !direct && chainedHooks.length > 0;
  const partial = routed && expectedHooks.length > 0 && chainedHooks.length < expectedHooks.length;
  const pass = direct || routed;
  const warn = (direct && !isRelativeExact) || partial;

  let detail;
  if (!pass) {
    detail = `hooksPath neither reaches aiteam/githooks nor carries the chain line (got: ${hooksPath || "<unset>"}) — run: node aiteam/install.mjs`;
  } else if (direct && warn) {
    detail = `hooksPath is not the canonical relative form (got: ${hooksPath}) — an absolute path makes git worktrees run the MAIN checkout's hooks. Fix: git config core.hooksPath aiteam/githooks`;
  } else if (partial) {
    detail = `router mode via ${hooksPath}, but only ${chainedHooks.join(", ")} carry the chain line (expected ${expectedHooks.join(", ")}) — re-run: node aiteam/install.mjs`;
  } else if (routed) {
    detail = `router mode: host keeps ${hooksPath}, framework hooks chained into ${chainedHooks.join(", ")}`;
  } else {
    detail = `hooksPath = ${hooksPath}`;
  }

  return { name: "core.hooksPath -> aiteam/githooks", pass, warn, detail };
}

/**
 * Judges the dynamic validate:beads check (`beads-check --all`). It runs on
 * plain node with the vendored js-yaml, so doctor.mjs always reports the
 * toolchain as present; the absent branch stays for a caller that can't spawn
 * node — a WARN (doesn't fail the exit), never a false "schema broken". A REAL
 * failure (exit != 0) FAILs. I/O stays in the shell; only the judgment lives
 * here.
 *
 * @param {{toolchainPresent:boolean, status:number|null, output:string}} r
 */
export function checkBeadsValidation({ toolchainPresent, status, output }) {
  const name = "validate:beads passes (root .beads via repoRoot)";
  if (!toolchainPresent) {
    return {
      name,
      pass: true,
      warn: true,
      detail: "toolchain não instalado (tsx ausente) — beads não validado neste checkout",
    };
  }
  if (status === 0) {
    return { name, pass: true, detail: "beads-check --all: .beads conforms to aiteam/docs/beads-schema.md" };
  }
  return { name, pass: false, detail: `exit ${status}: ${String(output ?? "").trim().slice(0, 180)}` };
}

/**
 * Modelo do .beads (aiteam/docs/beads-schema.md §11). Modo legado — o
 * active.yaml do modelo antigo ainda rastreado — é WARN, não FAIL: é como um
 * consumidor vive até o PR de migração, com os hooks novos só avisando.
 * @param {{legacy: boolean}} input
 */
export function checkBeadsModel({ legacy }) {
  const name = ".beads no modelo por bead";
  if (legacy) {
    return {
      name,
      pass: true,
      warn: true,
      detail:
        "modo legado: .beads/active.yaml ainda é rastreado — os hooks não mexem no backlog. Migre com: node aiteam/scripts/migrate-beads.mjs --dry-run (aiteam/docs/beads-schema.md §11)",
    };
  }
  return { name, pass: true, detail: "beads em .beads/tasks/<id>/<branch>.yaml; active.yaml e index.yaml gerados fora do git" };
}

// Uma linha de verdade (não comentário) com `merge=beads-yaml`: o que faz o git
// chamar o driver.
const isDriverMapping = (line) => !/^\s*#/.test(line) && /(^|\s)merge=beads-yaml(\s|$)/.test(line);

/**
 * O .gitattributes mapeia algo para o driver beads-yaml? Só linha de verdade
 * conta: comentário que cita o driver (o bloco antigo trazia `merge.beads-yaml.*`)
 * não faz o git chamar nada. É o mapeamento, e não o registro no .git/config,
 * que decide se o driver roda.
 * @param {string|null|undefined} text conteúdo do .gitattributes da raiz
 */
export function gitattributesMapsDriver(text) {
  return String(text ?? "").split(/\r?\n/).some(isDriverMapping);
}

/**
 * O .gitattributes cita `beads-yaml` fora do mapeamento — num comentário? O
 * contract test (aiteam/src/githooks-contract.test.ts) reprova qualquer
 * `beads-yaml` no arquivo, mapeado ou não: quem tirou as linhas de mapeamento e
 * deixou o comentário do bloco antigo (ou o de outra regra) cai nele do mesmo
 * jeito. O mapeamento em si é o `gitattributesMapsDriver`.
 * @param {string|null|undefined} text conteúdo do .gitattributes da raiz
 */
export function gitattributesCitesDriver(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .some((line) => /beads-yaml/.test(line) && !isDriverMapping(line));
}

/**
 * O merge driver beads-yaml do modelo antigo mora no .git/config, que é
 * compartilhado entre o checkout principal e todas as worktrees. Os hooks
 * novos não o removem — outra worktree ainda no modelo antigo pode depender
 * dele —, então quem avisa do resíduo é o doctor.
 *
 * O sync manda tirar do .gitattributes o bloco inteiro do driver — as linhas
 * `merge=beads-yaml` e o comentário que as acompanha — também em modo legado
 * (aiteam/docs/consuming-as-upstream.md): o merge do GitHub nunca rodou o
 * driver, e no merge local de um repo legado o conflito aparece em vez da união
 * silenciosa. Sem o mapeamento o git não chama o driver — o registro no
 * .git/config fica inerte, e um script faltando não quebra merge nenhum. Por
 * isso só reprova quem AINDA mapeia, está em modo legado (o arquivo único que
 * o driver unia) e perdeu o script; migrado + mapeia + script ausente é WARN.
 * @param {{driver: string|null, legacy: boolean, missing?: string[], mapped?: boolean, cited?: boolean}} input
 *   `mapped`: o .gitattributes ainda mapeia .beads/*.yaml para o driver
 *   (gitattributesMapsDriver). `cited`: ainda cita `beads-yaml` num comentário
 *   (gitattributesCitesDriver). Quem chama faz o I/O (doctor-io.mjs).
 */
export function checkMergeDriverResidue({ driver, legacy, missing = [], mapped = false, cited = false }) {
  const name = "merge driver beads-yaml (resíduo do modelo antigo)";
  const dropBlock =
    "tire do .gitattributes o bloco inteiro do driver, comentário incluído (as linhas merge=beads-yaml e os comentários que o citam) — em modo legado, o merge local passa a mostrar o conflito em vez de unir em silêncio (aiteam/docs/consuming-as-upstream.md)";
  const dropSection = "git config --remove-section merge.beads-yaml";
  if (mapped) {
    if (driver && legacy && missing.length) {
      return {
        name,
        pass: false,
        detail: `merge.beads-yaml aponta para ${missing.join(", ")}, que não existe, e o .gitattributes ainda mapeia .beads/*.yaml para ele: todo merge local de .beads/*.yaml falha no driver. ${dropBlock} — ou migre para o modelo por bead, que não usa driver: node aiteam/scripts/migrate-beads.mjs --dry-run`,
      };
    }
    return {
      name,
      pass: true,
      warn: true,
      detail: driver
        ? `o .gitattributes ainda mapeia .beads/*.yaml para o driver beads-yaml, que o modelo por bead não usa: ${dropBlock}. Depois, o merge.beads-yaml do .git/config fica inerte: ${dropSection}`
        : `o .gitattributes ainda mapeia .beads/*.yaml para o driver beads-yaml, que não está registrado (o git usa o merge de texto) e o contract test reprova a linha: ${dropBlock}`,
    };
  }
  if (cited) {
    return {
      name,
      pass: true,
      warn: true,
      detail:
        "o .gitattributes não mapeia mais .beads/*.yaml para o driver, mas ainda cita 'beads-yaml' num comentário, e o contract test (aiteam/src/githooks-contract.test.ts) reprova esse texto: reescreva o comentário sem citar o driver — ou, se sobrou do bloco antigo, tire-o junto das linhas de mapeamento" +
        (driver ? `. O merge.beads-yaml do .git/config fica inerte: ${dropSection}` : ""),
    };
  }
  if (!driver) return { name, pass: true, detail: "nenhum merge.beads-yaml no .git/config" };
  return {
    name,
    pass: true,
    warn: true,
    detail: `merge.beads-yaml ainda está no .git/config, compartilhado com o checkout principal e as worktrees, mas o .gitattributes não mapeia nada para ele: o registro é inerte. Quando nenhuma worktree ou branch que ainda mapeie .beads/*.yaml para ele depender dele: ${dropSection}`,
  };
}

/**
 * Os caminhos que o comando de um merge driver referencia (o executável e o
 * script), para o doctor conferir que existem. Aspas duplas agrupam; os
 * placeholders %A/%O/%B e as palavras sem `/` nem extensão de script ficam de fora.
 */
export function driverPaths(driver) {
  const out = [];
  for (const m of String(driver ?? "").matchAll(/"([^"]*)"|(\S+)/g)) {
    const tok = m[1] ?? m[2];
    if (!tok || tok.startsWith("%") || tok.startsWith("-")) continue;
    if (/[\\/]/.test(tok) || /\.(m?[jt]s|cjs)$/.test(tok)) out.push(tok);
  }
  return out;
}

/**
 * O beads-guard (PreToolUse Write|Edit) é acelerador opcional do Claude Code:
 * o gate do .beads é o pre-commit. Ausente vira WARN, não FAIL.
 */
export function checkBeadsGuardSettings(settings) {
  const name = ".claude/settings.json PreToolUse beads-guard";
  const entries = settings?.hooks?.PreToolUse ?? [];
  const pass = entries.some(
    (e) => matcherCovers(e?.matcher, "Write") && (e?.hooks ?? []).some((h) => /aiteam\/hooks\/beads-guard\.mjs/.test(norm(h?.command)))
  );
  return pass
    ? { name, pass: true, detail: "Write|Edit PreToolUse hook runs aiteam/hooks/beads-guard.mjs" }
    : {
        name,
        pass: true,
        warn: true,
        detail:
          "sem o beads-guard, o Claude Code só descobre no pre-commit que editou uma visão ou o arquivo de outra branch — rode: node aiteam/install.mjs",
      };
}

// Sete dias: o registro de portas muda quando alguém sobe app, o que aqui
// acontece em semanas, não em horas. `ageDays` é a idade do COMMIT no topo do
// ref remoto-tracking (git log -1 --format=%cI) — NÃO de quando rodamos
// `git fetch` por último. Um `git fetch` bem-sucedido não move essa data se a
// KB não mudou desde então, então o aviso abaixo não pode prometer que rodar
// fetch o resolve — só sinaliza que vale a pena confirmar que o fetch está em
// dia antes de confiar no conteúdo (ver o caso do 3212 no spec).
const KB_STALE_DAYS = 7;

/**
 * Judges infra_kb slot configuration.
 * @param {{pointer: object|null, remoteExists: boolean|null, ageDays: number|null, malformedReason?: string|null}} input
 * remoteExists: null = git not available / couldn't check; false = git works but remote not found; true = remote exists
 * malformedReason: set when the frontmatter DECLARES infra_kb but the block is
 * unusable (not absent) — e.g. mis-nested, non-object, or a filled-in url with
 * no remote. Caller (doctor.mjs) computes this from the raw frontmatter, since
 * readPointer collapses that distinction to null for the hooks' benefit.
 */
export function checkInfraKb({ pointer, remoteExists, ageDays, malformedReason }) {
  const name = "infra_kb (KB do host compartilhado)";

  if (malformedReason) {
    return {
      name,
      pass: false,
      detail: `SPEC.md declara infra_kb, mas ${malformedReason} — corrija o frontmatter (ver aiteam/AGENTS.md §Infra KB)`,
    };
  }

  if (!pointer) {
    return { name, pass: true, detail: "SPEC.md não declara infra_kb — projeto sem host compartilhado (ok)" };
  }

  // git not available or not a git repo
  if (remoteExists === null) {
    return {
      name,
      pass: true,
      warn: true,
      detail: `git não está disponível ou repo não é um checkout git — não foi possível validar infra_kb "${pointer.remote}"`,
    };
  }

  // git works but remote not configured
  if (remoteExists === false) {
    return {
      name,
      pass: false,
      detail: `SPEC.md declara infra_kb.remote "${pointer.remote}", mas esse remote não existe — rode: node aiteam/install.mjs`,
    };
  }

  // remoteExists === true: remote is configured

  // ref never fetched or age couldn't be determined
  if (ageDays === null || ageDays === undefined) {
    return {
      name,
      pass: true,
      warn: true,
      detail: `${pointer.remote} configurado, mas ${pointer.ref} nunca foi sincronizado neste checkout — rode: git fetch ${pointer.remote} ${pointer.ref}`,
    };
  }

  // ref content is old — NOT necessarily "hasn't been fetched" (see the
  // KB_STALE_DAYS comment above). Phrased as content age, and the fetch is
  // framed as a way to CONFIRM, not as a fix this warning is promising.
  if (ageDays > KB_STALE_DAYS) {
    return {
      name,
      pass: true,
      warn: true,
      detail: `${pointer.remote}/${pointer.ref}: conteúdo do ref tem ${ageDays} dias — pode ser normal se o registro muda devagar; confirme com \`git fetch ${pointer.remote} ${pointer.ref}\` que não há reserva mais recente antes de usar a KB para reservar porta`,
    };
  }

  // everything is good
  return { name, pass: true, detail: `${pointer.remote}/${pointer.ref} presente e recente` };
}

export function summarize(results) {
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  return { pass: failed === 0, total: results.length, passed, failed };
}
