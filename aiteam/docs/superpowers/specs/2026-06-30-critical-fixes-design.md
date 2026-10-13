# Design — Critical fixes (secret scanner, circuit breaker, tier classifier)

> Date: 2026-06-30 · Status: approved (design + decisions) · Author: Orchestrator
> Source: deep technical evaluation of `rb-ai-team`. Fixes the three highest-ROI
> correctness/security gaps found. TDD (red→green) per `AGENTS.md`.

## Fix 1 — Comprehensive secret scanner (security)

**Problem.** `aiteam/githooks/pre-commit` only greps `ANTHROPIC_API_KEY=<value>`. It
misses `GEMINI_API_KEY` (required by setup), OpenAI/AWS keys, and raw key
material with no variable name. A real Gemini-key leak passes.

**Approach** (tested TS core + thin hook, mirroring `validate-beads`):
- `aiteam/src/secret-scanner.ts` — pure `scanForSecrets(diff: string): Finding[]`,
  unit-tested. Matches **values, not mentions** (the retro lesson).
- `aiteam/scripts/scan-secrets.ts` — runs `git diff --cached --diff-filter=ACM`, scans
  only **added** lines, prints findings, exits 1 on any leak.
- `aiteam/githooks/pre-commit` calls the script when the toolchain is present; keeps a
  **bash-grep fallback** (covers key-value prefixes) when `node_modules` is
  absent — same degradation pattern as the beads validator.
- Detection set: named secrets with a non-placeholder value
  (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `OPENAI_API_KEY`,
  `LANGFUSE_SECRET_KEY`, `AWS_SECRET_ACCESS_KEY`) **plus** raw material
  (`sk-ant-…`, `sk-…`, `AIza…`, `AKIA…`, `ghp_…`, PEM `BEGIN … PRIVATE KEY`,
  and a `redis://` URL carrying embedded credentials). Placeholder allowlist (`your-…`, `<…>`, empty, `xxx`,
  `changeme`, `example`). Excludes `*.example` only — `.md` is still scanned but
  value-shaped matching avoids the "mention" false-positive.

**Acceptance:** a staged `GEMINI_API_KEY=AIza…` (or a raw `sk-ant-…`) blocks the
commit; the empty `.env.example` placeholder and a doc that merely names a key do
not. Unit tests cover each provider, each placeholder, and the diff-parse.

## Fix 2 — Calibrate + harden the circuit breaker

**Problem.** The README claims "intercepts every AI call" and "hard-stops"; in
reality (`aiteam/src/circuit-breaker.ts`) the check is **pre-call**, accrual is
**post-call**, and streaming is unmetered. So one in-flight call can overshoot
unbounded and streaming bypasses the gate entirely.

**Approach:**
- **Calibrate docs** — README (EN+PT) and `createClient` JSDoc state the true
  behavior: the *next* call stops once budget is reached; a single in-flight
  call can overshoot; streaming is not metered.
- **Predictive pre-call guard** — before calling, project this call's worst case
  from `params.max_tokens` (output ceiling) × output rate + a cheap input
  estimate (chars/4 of the serialized messages) × input rate. If
  `accumulated + worstCase ≥ budget`, trip **before** the expensive call.
  Bounds overshoot to one call's ceiling.
- **Streaming made visible** (chosen posture) — when `params.stream === true`,
  emit a one-time `budget_warn`-style notice that the call is unmetered and
  proceed. Full stream metering is deferred to a backlog item.

**Acceptance:** new unit tests for the worst-case projection (`projectMaxCost`)
and a pre-call trip when the projection exceeds budget; the existing 18 breaker
tests stay green; streaming path logs the unmetered notice.

## Fix 3 — Argv/sub-command-aware tier classifier

**Problem.** `classifyTier` substring-matches the whole command line. It
**over-matches** (`echo "vercel --prod"` → Tier 3, observed in the retro) and
**under-matches** (`rm -r -f`, `foo && rm -rf x`, `node -e "…"` escape).

**Key subtlety:** stripping quotes is wrong — `psql -c 'DROP TABLE'` *executes*
its quoted arg (and a test requires Tier 3), while `echo` does not. The
discriminator is the *program*, not the quotes.

**Approach:**
1. Split the line into sub-commands on `&&`, `||`, `;`, `|`, newline, and `$()`;
   classify each, take the **max** tier.
2. If a sub-command's `argv[0]` is inert (`echo`, `printf`, `:`, `true`,
   `false`) → Tier 1 (fixes over-match), regardless of its args.
3. Otherwise apply the tier3/tier2 patterns to that sub-command's text
   (preserves `psql -c 'DROP TABLE'` → Tier 3).
4. Normalize high-value under-match: `rm` recursive+force across split flags
   (`-r -f`, `--recursive --force`); `git push … --force` anywhere in args.
5. **De-duplicate the algorithm** — extract one dependency-free `.mjs` core used
   by both `aiteam/hooks/tier-guard.mjs` and `aiteam/src/tier-classifier.ts`, so the
   security gate and its typed reference cannot drift.
6. **Calibrate the prose** — docs frame this as blocking *accidental/obvious*
   Tier-3, not an adversarial sandbox (`base64 | sh` still escapes — be honest).

**Acceptance:** all 21 existing classifier tests stay green; new tests add
`echo "vercel --prod"` → 1, `rm -r -f build` → 3, `lint && rm -rf dist` → 3,
`bash -c "rm -rf /"` → 3. The hook and the TS reference return identical tiers
for the same input (shared core).

## Out of scope (tracked separately)
- Full streaming cost metering (wrap the stream iterator).
- Native-primitives migration (personas→subagents, skills→native skills).
- Committed personal `agent-memory`, doc/skill drift, dormant evals, CRLF
  normalization — hygiene backlog, not part of these three fixes.
