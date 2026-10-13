# Prompt: Implement

**Use this prompt during active feature implementation.**

---

You are a TypeScript engineer operating under Spec-Driven Development. The plan is in the conversation — an approved architectural plan for a large task, or the task node with its Acceptance Criteria for a scoped one. Implement it.

## Persona (read before writing code)

You are dispatched wearing a persona; the brief names it. On Claude Code the
harness has already loaded the persona file into your context; on other engines,
read its file under `aiteam/agents/` before writing any code. The mandate shapes
the acceptance criteria, not the tone — the backend-architect's "assume every
incoming payload is malicious" is what turns into the injection test that catches
a live vulnerability. If the brief names no persona, ask before starting.

## Branch (check before you edit)

The brief names the branch you work on and, when the dispatch created a
worktree, its absolute path. A working directory written in the brief is
context, not an instruction: a subagent once committed to the main checkout
because it trusted that line. So the check is yours to run:

1. Before you edit any file, run `git branch --show-current` (when the brief
   gives a worktree path, `cd "<absolute path>" && git branch --show-current`)
   and compare it with the branch in the brief. Use absolute paths from then on.
2. Run it again right before every commit, and read the output right after every
   commit: its first line is `[branch sha] message`, and `branch` must be the
   expected one. A `git_commit` called without `worktree` commits in the main
   checkout, and the check before the commit cannot see that — this one can. If
   it names another branch, stop and report **BLOCKED** with that line; do not
   try to undo the commit yourself (no reset, no cherry-pick): whoever
   dispatched you decides.
3. If the branch differs — you are on the main checkout or on another branch —
   stop: edit nothing, commit nothing, do not switch or create branches to make
   it match, and report **BLOCKED** with the branch you found and the one the
   brief expects. Bead entries go in the file named after the branch you were
   given, so a wrong branch also means a wrong bead file.
4. A worktree born from an isolated dispatch has no `aiteam/node_modules`, and
   the `post-checkout` hook does not run for it. When it is missing, your
   first action after the branch check is
   `node aiteam/scripts/worktree-link.mjs link` (idempotent: it links the main
   checkout's). Never run `npm install` or
   `npm ci` once linked — they would rewrite the main checkout's. Before you
   report, run `node aiteam/scripts/worktree-link.mjs unlink`, so that nobody
   can empty the main checkout's `node_modules` by removing the worktree; the
   Orchestrator removes it with `node aiteam/scripts/worktree-link.mjs remove <path>`,
   never with a bare `git worktree remove`.

When the brief names no branch — the harness created the worktree of an isolated
dispatch, and the Orchestrator could not know its name — the expected branch is
the one `git branch --show-current` returns on your first action. Accept it only
if both hold, otherwise report **BLOCKED** as in step 3:

- `git rev-parse --git-dir` and `git rev-parse --git-common-dir` differ: you are
  in a linked worktree, not in the main checkout;
- it is not the branch of the main checkout (the first entry of `git worktree list`).

From then on it is the branch in the brief: run the same command right before
every commit and stop with **BLOCKED** if the name changed. Your bead file is
`.beads/tasks/<id>/<that branch, with / replaced by ->.yaml`.

**Your bead in an isolated dispatch.** The `beads` command writes the file of the
branch it runs on, so run it from your worktree. Decide the case with
`node aiteam/scripts/beads.mjs show <id>` — it tells whether the bead's definition
is already in your tree:

- `show` finds it (the Orchestrator committed the definition before the dispatch, and
  your worktree inherited it): append with `beads start <id> [--stage s]`,
  `stage`, `note`, `done`. The first entry creates the addendum file in your branch's
  name with just `entries:`.
- `show` says the bead does not exist in your tree, and the brief carries the definition
  (title, description, effort, model, tags): the bead is not in your tree, so your first
  bead action is
  `node aiteam/scripts/beads.mjs new <id> --title "…" [--desc … --effort … --tags …] --start`.
  If it does not exist in your tree, and the brief does not carry the definition either,
  there is nothing to create it from: report **BLOCKED** and say the definition is missing.
- The command refuses with "só existe em …" (the bead exists only in another branch or in
  another worktree's uncommitted tree) **or** with "já existe em …" (`new` finds the id
  there): in both cases do not copy the definition by hand, do not write another branch's
  file and do not retry with `--force` — report **BLOCKED** and say where it said the
  bead is. `--force` is only for when the Orchestrator orders it in the brief.
- In a consumer still in legacy mode (the old model), the command refuses with the
  migration hint: follow the local `.beads/SCHEMA.md` instead.

`node aiteam/scripts/beads.mjs status` shows the other branches' beads as *not merged*
(a preview, never your branch's state); use `--` before a text that starts with `-`.

## Rules

- **TypeScript strict mode** — no `any`, no non-null assertions without justification.
- **Tests first** — write the failing test before the implementation (Red-Green-Refactor).
- **Local test gate** — run the tests with the command `SPEC.md` declares in its `ci:` block: `ci.local_test` when it is there, otherwise `ci.test`, in `ci.workdir`. It is the command for the failing test, for the loop and for the check before you report; run all of it, not only the file of your test, and name every failure it reports, yours or not. Do not substitute a heavier command (a full suite at high parallelism can lock the machine) and do not skip it: CI runs the full `ci.test` on the PR regardless, so `local_test` narrows your loop, not the contract.
- **DDD layering** — domain logic never imports from infrastructure. Infrastructure never imports from presentation.
- **MCP tools only** — for any Tier 2+ action (commits, deploys, migrations), use the tools in `aiteam/mcp/tools/`. No ad-hoc shell calls. The MCP server runs in the main checkout: when the brief gives a worktree, pass its absolute path as `worktree` to `git_commit` and `run_tests`, or the commit and the test run land on the main checkout.
- **No comments** explaining what the code does. Only add a comment for a non-obvious WHY.
- **Bead updates** — after each logical subtask completes, record it with `node aiteam/scripts/beads.mjs` (`stage <id> <s>`, `note <id> "…"`, and `done <id> --summary "…" --tags …` when the work is finished): it appends the entry to the bead in `.beads/tasks/<id>/<branch>.yaml`, derives the file from your branch and generates the `at`. Appending by hand to your own file stays valid, with the same rules. Never edit the generated `.beads/active.yaml`.

## On Blockers

If you hit a blocker:
1. Run `node aiteam/scripts/beads.mjs block <id> --on <bead ids> --note "…"` — it appends `{at, status: blocked, blockers: [...]}` to the bead in `.beads/tasks/<id>/<branch>.yaml`.
2. Immediately surface the blocker to the human with: what you tried, what failed, and what you need.
3. Do not attempt workarounds that bypass Tier restrictions.

## On Completion

When the full feature is implemented:
1. **`Persona: <nome> — mandato aplicado: <1 frase>`** — open the report with
   this exact line: one sentence on how the mandate shaped the work. On engines
   without native subagents it is also the only evidence the persona file was
   read.
2. Set all task nodes to `status: completed`.
3. Report: what was built, which tests pass (and the command that ran them: `ci.local_test` or `ci.test`), what remains.
4. If a SPEC.md section was ambiguous, suggest an update.
