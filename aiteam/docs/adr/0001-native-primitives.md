# ADR 0001 — Relationship to Claude Code Native Primitives

- **Status:** Accepted (initial direction; revisit after dogfooding — `orch-dogfood-beads-2wk`)
- **Date:** 2026-06-10
- **Deciders:** Lead Orchestrator
- **Context tasks:** `spec-native-primitives-decision`, `infra-tier-permission-hooks`, `orch-publish-github-template`

## Context

rb-ai-team grew its own conventions for layers Claude Code now provides
natively. The open question (the most consequential architectural call in the
backlog) is **adopt vs. duplicate** per layer. The risk of duplication is that
the custom conventions only work if the model *remembers* to read the right
files — nothing auto-loads them — whereas native primitives are enforced by the
harness.

Layers in question:

1. **Personas** (`aiteam/agents/*.md`) vs. native **subagents** (`.claude/agents/`).
2. **Permission tiers** (prose in `AGENTS.md`) vs. **`permissions.deny` rules +
   `PreToolUse` hooks**.
3. **Skills** (`aiteam/skills/`) vs. native **skills** directory.
4. **Memory** (`.beads/`) — no native equivalent.

## Decision (per layer)

| Layer | Decision | Rationale |
|---|---|---|
| **Tiers → hooks** | **Adopt native, done.** | Implemented in `infra-tier-permission-hooks`: `.claude/settings.json` deny rules + `aiteam/hooks/tier-guard.mjs`, with the canonical map in `.claude/tier-rules.json` and a tested `classifyTier`. Prose alone was unenforceable; this is the clearest win. |
| **Memory → keep `.beads`** | **Keep — this is the differentiator.** | There is no native cross-session, git-backed, board-rendered task memory. `.beads` — one folder per bead and one file per branch (`.beads/tasks/<id>/<branch>.yaml`), so merges need no driver (`infra-beads-modelo-novo`, which replaced the merge driver of `api-beads-conflict-protocol`) — + structured logs (`infra-structured-logging-metrics`) are the project's reason to exist. |
| **Personas → native subagents** | **Migrate, thin layer on top. Done** (2026-07-27). | Native subagents auto-load and are dispatched by the harness; personas alone only work if the model reads the file. Implemented as a *generated binding*: `aiteam/agents/*.md` stays canonical (with `name`/`description`/`model` frontmatter), `aiteam/scripts/sync-agents.ts` renders `.claude/agents/*.md`, and the pre-commit `validate:agents` fails on drift. Retain `AGENTS.md` as the provider-agnostic description for non-Claude tools. |
| **Skills → native skills dir** | **Migrate.** | The `aiteam/skills/` content maps directly onto native skills with progressive disclosure. Native skills are discoverable without the model being told to read them. |

**Overall target architecture:** a *thin governance layer* (provider-agnostic
`AGENTS.md` + the `.beads` memory/observability stack, which are the genuine
differentiators) sitting **on top of** native Claude Code primitives
(subagents, permission rules + hooks, skills) for everything the harness can
enforce. Stop hand-rolling what the platform enforces; keep what it doesn't.

## Trade-offs

- **Cross-tool portability vs. native enforcement.** `AGENTS.md` and the
  `aiteam/agents/*.md` prose work across Claude Code, Cursor, Copilot, Gemini, etc.;
  native subagents/skills/hooks are Claude-Code-specific. **Mitigation:** keep
  `AGENTS.md` as the portable contract and treat the native definitions as the
  Claude-Code *binding* of the same intent, generated from / kept in sync with
  it — not a second source of truth.
- **Migration cost.** Re-expressing 7 personas as subagents and the skills as a
  native dir is real work; it can be staged (tiers already done; personas and
  skills next) without a big-bang rewrite.

## Migration sketch

1. ✅ **Tiers → hooks** — done (`infra-tier-permission-hooks`).
2. ✅ **Personas → `.claude/agents/`** — done (`qa-persona-native-subagents`, 2026-07-27),
   with three deviations from the original sketch, all learned from dogfooding:
   - **10 bindings, not 11.** The Lead Orchestrator is the persona of the *main
     loop* — the one that dispatches. As a dispatchable subagent it would be a
     dispatcher inside a dispatched context. It carries `dispatch: session` in
     its frontmatter, which keeps the exclusion in the data instead of a
     hard-coded list in the sync script.
   - **The binding is generated, never hand-written.** `.claude/agents/*.md`
     carries a provenance marker; `sync-agents.ts` only overwrites files that
     carry it. A consumer's own agent of the same name is reported and left
     alone — the same non-interference invariant `install.mjs` honours for
     `settings.json`. Drift fails `validate:agents` in pre-commit.
   - **Frontmatter had to be authored, not copied.** Only 4 of 11 personas had
     any; and the `description` a native dispatcher triggers on ("use when…")
     did not exist in any of them — the old ones were declarative summaries.
     That normalization is itself portable value: non-Claude engines get a
     trigger line they did not have before.
3. **Skills → native skills dir** — move `aiteam/skills/*/SKILL.md` into the
   native layout; verify progressive-disclosure descriptions trigger correctly.
4. **Keep `.beads`** — no change; it is the differentiator.
5. Gate broad publishing (`orch-publish-github-template`) on at least the
   personas migration so a fresh template ships native-first.

## Consequences

- `infra-tier-permission-hooks` is the reference implementation of "adopt
  native enforcement"; future layers follow its shape (canonical config +
  tested logic + harness wiring).
- Revisit this ADR after `orch-dogfood-beads-2wk` — dogfooding may show the
  persona/skill migration pays off, or that the portable prose is enough.
- **Revisit done** (issue #2, 2026-07-27). Dogfooding in the `trabalhista`
  consumer confirmed the risk this ADR named: the persona↔subagent link was
  100% prompt discipline, with no auditable evidence the mandate was ever
  loaded. Two answers shipped together, and they are complementary rather than
  redundant — the binding makes the harness carry the persona on Claude Code;
  the report contract (`Persona: <nome> — mandato aplicado: …`) makes the
  omission *visible* everywhere else, including engines that will never have
  native subagents.
- **Measured** (2026-10-05/06, bead `qa-native-subagent-stateful-dispatch`).
  The open risk was whether a native subagent's fresh context carries the
  Memory Protocol and tier awareness the persona prose assumes — a subagent
  that cannot write `.beads` would trade a persona gap for a memory gap, and
  `.beads` is the differentiator this ADR keeps. It was measured on real work,
  not on a staged task: the native subagents the main loop dispatched with
  `isolation: "worktree"` while building PRs #45–#49, each on its own
  `worktree-agent-*` branch — git shows five of those branches carrying a
  bead into the PRs. The briefs followed `aiteam/agents/orchestrator.md`
  (task, Acceptance Criteria, the bead definition for the subagent to create on
  its own branch because the dispatch came from the default branch, the branch
  check of `aiteam/prompts/implement.md`, `worktree-link.mjs link`/`unlink`,
  commit rules and gates). For memory and for tiers, it crossed:
  - **Report contract.** Every report opened with the
    `Persona: … — mandato aplicado: …` line.
  - **Memory.** The subagents wrote beads only in their own branch's file —
    by hand, and with the `beads new`/`start`/`note` command once it landed
    (`91ca08b`, PR #47) — and never touched the generated views. In git: the five `chore(beads): abre …`
    commits that entered those PRs (`972c567`, `b9e0ca6`, `cc1fe7d`, `564d194`,
    `bb1799a`) each create `.beads/tasks/<id>/worktree-agent-<hash>.yaml`; the
    15 bead commits in `6e5146b..4b19290` touch only those five files, and none
    touches `.beads/active.yaml` or `.beads/index.yaml`. Tier 2 actions went in
    as `note` entries (`74407d3`), and one QA round was recorded "pelo comando
    beads" (`8649e69`).
  - **Tiers.** The tier-guard applied inside the subagents: it denied a
    recursive forced removal, a `git commit -m` with escaped quotes, and a
    `beads note` whose text quoted a destructive command. The agents adapted —
    another commit form, the text paraphrased — without routing around the
    guard. A denial leaves nothing in git (what git keeps is the adapted text),
    so this part comes from the reports, as received by the Orchestrator.
  - **Process.** They followed TDD and the branch check of `implement.md`:
    accepted the harness's branch only in a linked worktree and when it was
    not the main checkout's branch, and checked it again before and after each
    commit.

  So, in this repo and with a brief of that shape, a native subagent carries
  what stateful work needs: the risk is closed for that case. **Not measured
  yet:**
  - **The persona file alone.** The briefs carried the protocol explicitly
    (bead definition, commands, branch check), so the measurement shows that
    brief works — not that a bare persona file would. Whether the SessionStart
    brief reaches a subagent was not checked either.
  - **Engines without native subagents** (the hat switch on
    Antigravity/Gemini). There the report line stays the only evidence the
    persona was loaded.
  - **A subagent outside a worktree** (read-only, or in the main checkout):
    every dispatch that wrote beads here ran with `isolation: "worktree"`.
  - **The ASK path inside a subagent.** Only denials were observed; whether a
    deploy's one-shot approval prompt reaches the human from a dispatched
    subagent, or fails closed, was not exercised.
  - **Consumer repos.** The measurement ran in this repo. A consumer still in
    legacy mode (`.beads/active.yaml` tracked) refuses per-bead writes, so it
    carries over only after it migrates
    ([`beads-migration-runbook.md`](../beads-migration-runbook.md)).
