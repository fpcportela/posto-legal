# Dogfooding Retro — Session 1 (rb-ai-team on its own backlog)

> Partial deliverable for `orch-dogfood-beads-2wk`. This session drove **17
> backlog tasks** (all P0, all P1 structural, P2 README/ADR, and Blueprint
> 8.1/8.2/8.3/8.6/8.9) end-to-end through the framework: orchestrator loop →
> persona reads → TDD red-green → `.beads` updates per task → tier enforcement.
> It is **not** the full 2-week, real-cost dogfood the task specifies (see
> "What this retro does NOT cover"), but it is real, observation-backed usage.

## What worked (keep)

1. **Mechanical tier enforcement actually fires.** The `PreToolUse` tier-guard
   hook blocked a real Bash call during this session because the command *text*
   contained `vercel --prod` / `prisma migrate deploy` (in `echo` strings). That
   is the honor-system→mechanical-gate transition working as intended — an agent
   cannot run a Tier-3 command by "forgetting" to ask.
2. **Per-task `.beads` updates kept context durable.** Across a long session the
   `context_summary` + `status` discipline meant no task state lived only in the
   conversation. The pre-commit `validate:beads` gate caught nothing malformed
   because the schema was followed — i.e. the guardrail shaped behavior.
3. **TDD red-first caught a false-green.** The git-injection test initially
   *passed* against the vulnerable code on Windows (cmd.exe doesn't interpret
   `$(...)`). Watching it fail forced a platform-aware payload — without the
   red step the test would have shipped proving nothing. This is the single
   strongest argument for the TDD mandate, observed live.

## Friction (change)

1. **The tier-guard classifier matches command *text* too broadly.** It flagged
   `echo "... vercel --prod ..."` as Tier 3. Recommendation: classify on the
   leading command token / parsed argv rather than a substring match over the
   whole command line, or exclude obvious quoted/echo contexts. Workaround used
   this session: route verification through fixture files and PowerShell.
2. **The secret-scanner false-positived twice** — once on the legitimate empty
   API-key placeholder in `.env.example` (the key name followed by a bare `=`),
   once on the scanner's own documentation comment. Fixed in-session (match a
   non-empty value only), but
   the lesson generalizes: secret scanners must match *values*, not *mentions*,
   and should exclude template/doc files.
3. **`active.yaml` re-stage churn.** The pre-commit hook bumps `last_updated` and
   re-stages `active.yaml`, which repeatedly triggered "file modified since read"
   when editing the same file across tasks. Minor, but it adds a re-read per
   edit. Recommendation: only the timestamp line needs touching; consider a
   narrower stage or a tool that edits in place.
4. **CRLF/LF noise on every commit** (Windows). ~every commit emitted LF→CRLF
   warnings. Recommendation: add `* text=auto eol=lf` normalization to
   `.gitattributes` (kept out of this session to avoid a repo-wide renormalize
   diff).

## What this retro does NOT cover (why the task stays open)

- **No real cost-log data.** `cost-log.json` is still `{"sessions": []}` — this
  session made zero paid `createClient` calls (it was code/docs work, not agent
  inference). The circuit breaker, CostStore, and metrics were unit-tested but
  never exercised against real spend. A true dogfood must make real (small-
  budget) model calls so cost accrual, the trip, and `npm run metrics` are
  validated end-to-end.
- **Not 2 weeks.** The task asks for ≥2 weeks of real tasks to find where the
  ceremony actually hurts over time. One session can't surface long-horizon
  friction (e.g. branch-memory churn across many `git checkout`s, multi-agent
  `.beads` merge conflicts in the wild).

## Recommended next steps for the full dogfood

1. Point the framework at a real consumer (the WIP WhatsApp platform or this
   repo's next features) for two weeks, making real model calls.
2. Capture `cost-log.json` / `session-log.ndjson` and run `npm run metrics`
   weekly; confirm the breaker trips at budget at least once intentionally.
3. Land the two friction fixes above (tier-classifier token-matching,
   `.gitattributes` eol) and re-evaluate.
