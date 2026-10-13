# ADR 0003 — Deploy gate: a single one-shot ASK, no second approval on the pipeline

> Date: 2026-07-30 · Status: accepted · Recorded here on 2026-10-03, moving the
> rationale out of [`AGENTS.md`](../../AGENTS.md) §CI/CD Mandate so the mandate
> states the current rule and this file keeps the history. Refines the tiers
> decision in [0001](0001-native-primitives.md).

## Context

The CI/CD Mandate requires that a human approves each specific production
deploy before it reaches production (item 3). Until 2026-07-30 the mandate
asked for that approval in two layers:

- **Layer 2** — the tier-guard ASK: `aiteam/hooks/tier-guard.mjs` classifies
  the deploy trigger via `ask_patterns` in `.claude/tier-rules.json` and
  surfaces the native one-shot approval prompt in the IDE.
- **Layer 3** — an approval the agent could not satisfy on its own, living
  outside the agent on the pipeline: GitHub Environments with required
  reviewers, or an issue-approval job.

Measured reality in July 2026:

- Required reviewers on GitHub Environments is Enterprise-only on private
  repos, so the practical layer 3 was the issue-approval workaround
  (`trstringer/manual-approval`), which holds a billable runner polling an
  issue until someone comments "approved".
- That runner consumed **973 min in July 2026 — 49% of the monthly Actions
  quota, about 1.4× the cost of the deploys it guarded (707 min)**. The quota
  ran out on 2026-07-29 (4,063 billable minutes against 2,000) and took the
  whole pipeline down, production deploys included.
- Findings from the same period shaped the surrounding rules:
  - 2026-07-18: an agent relayed a prior, general "you're approved to deploy"
    as covering a later run. The mandate now says the human approves that
    specific command, naming that specific `ref`, in that turn.
  - 2026-07-21 (consumer `trabalhista`): a deploy over an SSH session held open
    across a heavy build dropped the link (`client_loop: send disconnect:
    Broken pipe`, exit 255) after the build had already run. Item 7 of the
    mandate (deploy resilience) comes from this.
  - 2026-07-27: `ssh host bash deploy.sh` and `ssh host npm run deploy` name no
    infra verb, classified as Tier 1 and ran with no prompt. The ssh+deploy-script
    patterns were added to `.claude/tier-rules.json`.
  - 2026-07-29 (issue #13): with the pipeline down and a verified fix sitting
    in `main`, the only way to ship was flipping the global `allow_tier3`
    break-glass, which also unlocks destructive commands. The direct-deploy
    fallback was sanctioned instead, and the SSH deploy patterns moved from
    `deny` to `ask`.

## Decision

1. **Layer 3 is removed — deliberately, not by oversight.** The one-shot ASK
   the human answers in the IDE is the only gate on a production deploy, on the
   pipeline path and on the direct-deploy fallback alike. The deploy workflow
   carries no manual-approval step; `aiteam/src/ci-contract.test.ts` enforces
   that no workflow uses `manual-approval`.
2. **Direct deploy over SSH is a sanctioned fallback**, only while the pipeline
   is genuinely unavailable, with the human approving that specific command via
   the ASK, deploying the same reviewed ref, and recording the deploy in
   `.beads`. `ssh <host> reboot|shutdown|poweroff` stays denied, and deny wins
   on any chain that mixes a deploy with a destructive command.
3. **A trigger that is not in `ask_patterns` is Tier 1 and runs with no
   prompt.** Projects on a provider other than GitHub Actions register their
   deploy trigger there; the mandate carries this warning.

## Consequences

- There is no longer a barrier a confused or compromised agent cannot cross
  alone, because the agent is what surfaces the ASK. The residual risk is
  bounded by scope — private repos, a single human — not by architecture.
  **Reassess when adding collaborators, going public, or onboarding a project
  where more than one person can trigger a deploy.**
- What still separates the pipeline from the fallback is traceability, not
  gate strength: a pipeline run leaves an auditable record outside the
  operator's terminal (who dispatched it, which ref, what the conclusion was)
  and executes code reviewed in the repo, while a direct deploy leaves only the
  `.beads` node and is the by-hand step the mandate otherwise rules out. That
  is why it stays a fallback rather than an equal option.
- The SSH key behind the fallback is scoped with a `command=` forced command in
  the host's `authorized_keys`, so a leaked key can only re-run the one deploy
  script: steps in [`cicd-deploy-gate-playbook.md`](../cicd-deploy-gate-playbook.md) §3.

## Alternative on record, not adopted

Split the deploy into `deploy-request.yml` (a dispatch opens an issue and exits
in seconds) plus `deploy.yml` on `issue_comment`, validating the approver
against an allowlist, requiring the workflow's label, and reading `ref` from the
issue body. This preserves layer 3 at zero idle billing — the comment wakes the
workflow instead of a runner waiting for it. Revisit this first if the policy is
reconsidered. Design notes: `docs/superpowers/specs/2026-07-30-ci-actions-minutes-design.md`
§4.1 (repository root).
