# Legacy Onboarding — Dropping rb-ai-team into an Existing Repo

> Blueprint 8.7. How to adopt this framework in a repo that already has its own
> lint, CI, conventions, and history — without the two fighting.

When you drop `CLAUDE.md` / `AGENTS.md` (TypeScript-strict, DDD, no-comments,
TDD) into a host project, those mandates can clash with the host's existing
ESLint/Prettier/CI rules and code style. This guide sets the precedence rules
and a concrete first-week path.

## Precedence — the host project wins

The framework's standards are **aspirational guidance for the agents**, not a
mandate to rewrite a working codebase. When they conflict with the host:

| Concern | Who wins | Why |
|---|---|---|
| Lint / format (ESLint, Prettier, EditorConfig) | **Host config** | A green build matters more than framework defaults. Don't reformat the repo to match `CLAUDE.md`. |
| CI gates (existing workflows, required checks) | **Host CI** | The framework's `eval.yml` is additive — add it alongside, don't replace required checks. |
| `tsconfig` strictness | **Host first, ratchet up** | If the host isn't `strict`, leave it; tighten incrementally in new modules, not in one sweep. |
| Architecture (DDD layering) | **Apply to new code** | Use it for new features; don't re-architect existing modules to satisfy it. |
| TDD | **Apply to new work** | New features/bugfixes are test-first; don't retro-fit tests to all legacy code at once. |
| Permission tiers + security hooks | **Framework wins** | `.claude/settings.json` deny rules and the tier-guard hook are safety rails — keep them. |

Rule of thumb: framework conventions govern **new** code the agents write; the
host's lint/CI/style govern the **existing** codebase. Where a real conflict
remains, the host's enforced tooling takes precedence and the framework standard
becomes a documented aspiration.

## Bootstrap scripts behave conservatively on a populated repo

Both adoption scripts **warn and exit without overwriting** when their target
already exists — so they are safe to run in a legacy repo. By default they
target your repo root: npm runs the script inside `aiteam/`, but the scripts
resolve the root from the directory npm was started in (`INIT_CWD`, else the git
toplevel). To point at another directory, pass it after `--`; the older
`-- ..` keeps working, it just stopped being required.

- **`npm --prefix aiteam run generate-spec`** (`aiteam/scripts/generate-spec.ts`) — scans the repo
  (package.json, README, `src/` tree, schema files, recent commits) and makes a
  one-shot Claude call to draft `SPEC.md`. **If `SPEC.md` already exists it exits
  1 and changes nothing.** Merge path: rename the existing file, generate into a
  scratch dir or temporarily, then hand-merge the draft into your real `SPEC.md`.
  (Cost is guarded by the circuit breaker; it uses Haiku for the analysis.)
  The frontmatter's `ci:` and `deploy:` blocks are written by code, not by the
  model: `ci:` lists the `test`/`typecheck`/`lint` scripts found in your
  `package.json` (`workdir: .`), plus `local_test` when it finds a
  `test:changed`-style script (the optional local TDD gate; CI still runs
  `test`), and `deploy:` is a placeholder
  (`workflow: deploy.yml`, empty `version_url`) that the CI/deploy contract and
  the doctor **fail until you fill it in** — copy
  `aiteam/templates/deploy.yml.example` and set the version endpoint, or opt out
  explicitly with `workflow: none` + `reason:`. The draft never opts out for you.
- **`npm --prefix aiteam run bootstrap-beads`** (`aiteam/scripts/bootstrap-beads.ts`) — derives
  initial beads from `git log` (grouped by conventional-commit scope, routed to
  desks per `aiteam/docs/beads-schema.md` §5), one folder per bead in
  `.beads/tasks/<id>/<branch>.yaml`. **If `.beads/tasks/` already has beads, or
  a tracked `.beads/active.yaml` of the old model exists, it exits 1.** A repo on
  the old model migrates with `node aiteam/scripts/migrate-beads.mjs --dry-run`
  instead; to keep only some bootstrapped beads, run it in a scratch clone and
  copy the folders you want.

Neither script clobbers your work; both require you to clear or merge manually.

## Wire the framework in (one idempotent step)

`node aiteam/install.mjs` wires the framework into the host **without clobbering
anything**: it merges the tier deny rules + the PreToolUse tier-guard into the
host's `.claude/settings.json`, adds the MCP server to `.mcp.json`, appends an
`@aiteam/…` import line to the host's root `CLAUDE.md`/`AGENTS.md` (creating them
if absent), creates `.claude/tier-rules.json` from `aiteam/templates/tier-rules.json`
only when the host has none (an existing map is the host's and is never touched —
the doctor warns if it lacks canonical Tier-3 patterns; a folder or unreadable file with that name is reported, not crashed on, and if your `.gitignore` ignores `.claude/` it tells you to track the map with `git add -f .claude/tier-rules.json`), and — for git hooks — *sets* `core.hooksPath` only if the host has
none, otherwise **chains** the framework hooks into the host's existing hooks
(e.g. `.husky/`) so the host's own hooks keep running. It is idempotent (re-run
freely) and supports `--dry-run`. Verify with `node aiteam/scripts/doctor.mjs`,
which prints PASS/FAIL for every wiring point (and confirms a sample Tier-3
command is denied) — read-only, no mutations.

## First-week adoption checklist

1. **Generate the spec.** `npm --prefix aiteam run generate-spec` → review the draft, replace
   every `TODO:` with a real answer (the `deploy:` block included, see above),
   commit `SPEC.md`. This is the source of
   truth the agents read first.
2. **Reconcile lint/CI.** Decide per the precedence table above. Keep the host's
   ESLint/Prettier/CI as the enforced gate; treat `CLAUDE.md` standards as
   guidance for new code. Add the framework's `eval.yml` as an *additional*
   workflow, not a replacement.
3. **Bootstrap memory + wire hooks.** `npm --prefix aiteam run bootstrap-beads`
   (or hand-write a bead in `.beads/tasks/<id>/<branch>.yaml`), then run `node aiteam/install.mjs` to
   activate the memory + tier hooks (it chains rather than clobbers any existing
   host hooks). Run `npm --prefix aiteam run validate:beads` to confirm conformance
   and `node aiteam/scripts/doctor.mjs` for a full health check.
4. **Set the budget.** Put a real `budget_usd` in `SPEC.md` frontmatter and
   export `ANTHROPIC_API_KEY` in your shell — nothing in `aiteam/` loads a
   `.env` (never commit the key — the pre-commit hook blocks real values).
5. **Run a small task through the loop.** Pick one bugfix, drive it
   orchestrator → persona → TDD → `.beads` update, and confirm the cost-log and
   board render. Adjust friction points before scaling up.

## What not to do

- Don't mass-reformat or re-lint the host repo to satisfy `CLAUDE.md`.
- Don't replace the host's required CI checks — add to them.
- Don't force `tsconfig` `strict` across a large legacy codebase in one commit.
- Don't delete `.beads/`/`SPEC.md` to force a re-bootstrap unless you've saved
  the existing content first.
