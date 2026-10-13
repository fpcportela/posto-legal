# Keeping Downstream Projects Updated from rb-ai-team

> Answers: *"If I publish this as a GitHub Template, can I push updates to the
> projects that use it?"* — **No.** A template creates each new project with a
> clean history and **no link** back here, so there is no native way to
> propagate template updates. This guide gives you the mechanism that **does**
> work: pull framework updates into a consumer repo via a git `upstream` remote.

## Checking for and receiving updates (start here)

**The decision to update is yours, on your schedule — this repo does not
track who consumes it, and the update flow does not depend on it doing so.**
Asked to "check for `rb-ai-team` updates"? Pull it yourself.

**1. Scoped pull (default — run this).** See what changed, read the release
runbook, then apply the scoped checkout ([Option B](#pulling-framework-updates) below):

```bash
git fetch upstream
node aiteam/scripts/upstream-marker.mjs changes   # root files that changed since YOUR last sync
git show upstream/main:docs/                       # list the per-release runbooks
#   then read the newest docs/consuming-*.md on upstream/main — it lists the
#   exact steps, the required hand-merges, and any Windows/CRLF gotchas.
```

The per-release runbooks (`docs/consuming-*.md`) live at the rb-ai-team
**root**, not under `aiteam/`, so they are **not** vendored into your repo —
read them from `upstream/main` as shown above. The rest of this document is
the mechanical detail behind this path.

**Measure from your last sync, not from the previous release.** `aiteam/` is a
checkout, so your repo shares no history with the upstream (`git log
main..upstream/main` lists the upstream's whole past, not what is new to you).
The only record of where your `aiteam/` came from is `aiteam/UPSTREAM`, which
the aiteam-sync tool writes and which you write at the end of a manual pull
(`node aiteam/scripts/upstream-marker.mjs write`, see Option B). With it,
`changes` is this, spelled out in git:

```bash
git log --format='%h %cs %s' "$(sed -n 's/^commit: *//p' aiteam/UPSTREAM)"..upstream/main -- \
  .beads/SCHEMA.md AGENTS.md CLAUDE.md GEMINI.md .gitattributes \
  aiteam/templates/ci.yml.example aiteam/templates/deploy.yml.example aiteam/templates/tier-rules.json
```

Without `aiteam/UPSTREAM` (a repo that never recorded a sync) **it cannot be
measured**: check every root file. `node aiteam/scripts/doctor.mjs` helps — it
compares your root files with the `upstream/<default>` ref you already have and
prints a WARN for what the upstream has and you do not, no history needed (it
never fetches: run `git fetch upstream` first, or it says so).

The marker records where your `aiteam/` came from, **not** that your root files
were reconciled with that commit: merging a sync PR advances the marker even if
you skipped a checklist item, and from then on `changes` no longer lists the
commits behind it. The doctor's WARN lines are the check that does not depend on
the marker.

**2. A sync PR, if you find one waiting (optional shortcut, not something to
wait for).** The maintainer *may* open a `chore/aiteam-sync-*` pull request
into your repo (via the author-driven `tools/aiteam-sync` fan-out) — typically
for an exceptional, time-sensitive fix across known forks, not as the routine
update path. It carries **only** framework-owned paths (`aiteam/`) plus the
safe wiring `install.mjs` produces, and its body holds a **hand-merge
checklist** for the files you may have customized — your
`.claude/tier-rules.json`, your root `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`, the
`permissions.deny` in `.claude/settings.json`, `.beads/SCHEMA.md`, a local copy
of the `trello-review` skill, of its reconcile script and of the Trello MCP (see
[below](#skills-with-a-per-project-half)),
`.gitattributes` (the `eol=lf` lines it lacks, and the old `merge=beads-yaml`
block and any `merge=union` rule on `.beads/`, which have to go — see
[below](#conflicts-are-cheaper-here-than-elsewhere)),
and your copies of the PR workflow (whatever its name: `ci.yml`, `build.yml`…) and
`.github/workflows/deploy.yml`. The body also
lists which upstream commits touched those root files **since your last sync**
(measured from `aiteam/UPSTREAM`, which the PR writes; with no marker it says
it cannot measure and to check everything). To apply:
review the diff, complete each checklist item by hand, then merge. The diff
never overwrites those customized files — that is the whole point. If no such
PR exists, that is normal, not a gap — use path 1.

## Template vs. upstream — pick by intent

| You want… | Use | Gives ongoing updates? |
|---|---|---|
| A low-friction way to **start** a new project from this skeleton | GitHub Template ("Use this template") | ❌ disconnected snapshot |
| To **keep an existing project updated** with framework changes | `upstream` remote (this guide) | ✅ pull on demand |
| To contribute back / track everything | Fork | ✅ but oriented to contribution, not independent products |
| Versioned, dependency-style updates | npm package / `npx` scaffolder (future) | ✅ via `npm update` |

The two are not mutually exclusive: you can flag this repo as a template **and**
have consumers wire an `upstream` remote for updates.

## Setup (in each consumer repo)

```bash
# 1. Point at this framework as a second remote (once)
git remote add upstream git@github.com:thiagoriosbraz/rb-ai-team.git
git fetch upstream
```

## Pulling framework updates

**Option A — full merge** (when the consumer hasn't diverged much):

```bash
git fetch upstream
git merge upstream/main          # resolve conflicts in your app code as needed
```

**Option B — scoped update** (recommended once your app code has grown): take
only the framework's own namespace, `aiteam/` (ADR 0002), leaving your
application code **and your root files** untouched:

```bash
git fetch upstream
git checkout upstream/main -- aiteam/
git add -A && git commit -m "chore: sync rb-ai-team framework from upstream"
```

**The checkout is `aiteam/` and nothing else.** The root files the framework
distributes (`.beads/SCHEMA.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`,
`.gitattributes`, `.claude/`, `.mcp.json`, `.github/workflows/`, `SPEC.md`) are
**yours** — you customize them — and a `git checkout upstream/main -- <one of
them>` overwrites that customization without a word: no error, no red test, the
protection or the convention is just gone. This list used to carry them; it no
longer does, and it must not grow them back. Each one reaches you another way —
`install.mjs`, the sync checklist or a hand-merge — and the table in
[Root files the framework distributes](#root-files-the-framework-distributes-and-how-each-reaches-you)
says which. A repo with no customization at the root can still take a root file
from the upstream, deliberately, one file at a time (`git show
upstream/main:<file>`), not by widening this checkout.

`git checkout` only writes what upstream *has*: a file upstream deleted stays in
your tree. Before the checkout, `git rm` each tracked file under `aiteam/` that
upstream no longer has but once had (`git log -1 upstream/main -- <file>` is not
empty). Never remove a file upstream never had — it is yours (e.g. a local MCP
server under `aiteam/mcp/`); better still, move it out of `aiteam/`. The
aiteam-sync tool does exactly this and lists the local files in the PR checklist.

After taking the framework files, wire them into your project with
`node aiteam/install.mjs` — idempotent; it merges `.claude/settings.json` (deny
rules, the guard hooks and `worktree.baseRef: "head"`, which makes every
worktree Claude Code creates — `claude -w` as well as a subagent dispatched with
`isolation: "worktree"` — start from your local `HEAD` instead of
`origin/<default>`; a `baseRef` you already set is kept) +
`.mcp.json`, adds `.claude/worktrees/` (where Claude Code puts those worktrees),
`.trello-cache/` (the card images the Trello MCP downloads) and `.superpowers/`
(the superpowers skills' scratch workspace) to your root `.gitignore`, each
unless it already ignores the folder, creates
`.claude/tier-rules.json` from the canonical copy that ships in
`aiteam/templates/tier-rules.json` when you have none (an existing one is yours
and is never overwritten — merge new patterns by hand, and the doctor warns
with the list of canonical Tier-3 patterns yours lacks; without the file the
tier-guard protects with the canonical copy and the doctor fails), injects the
`@aiteam/…` import lines into your root
`CLAUDE.md`/`AGENTS.md`, and **chains** the git hooks (setting `core.hooksPath`
only if you had none, otherwise routing into your existing hooks). One of those
hooks, `post-checkout`, links your main checkout's `aiteam/node_modules` into a
linked worktree that has none (a junction on Windows). A bare `git worktree
remove` follows that junction and empties the main checkout's `node_modules`:
remove such a worktree with `node aiteam/scripts/worktree-link.mjs remove <path>`.
Verify with `node aiteam/scripts/doctor.mjs`.

**Regenerate the personas' bindings.** The checkout above no longer takes
`.claude/`, so the generated bindings `.claude/agents/*.md` do not follow the
personas in `aiteam/agents/`: after a pull that changed a persona they are out
of sync, and the `pre-commit` refuses the next commit with "binding(s) fora de
sincronia". Regenerate them and commit the result with the sync:

```bash
npm --prefix aiteam run sync:agents      # needs aiteam/node_modules: cd aiteam && npm install, once
git add .claude/agents                   # the regenerated bindings go in the same commit
npm --prefix aiteam run validate:agents  # checks them against the personas
```

**Record the sync.** The last step of a manual pull writes where your `aiteam/`
came from, so the next pull can measure from it (see "Measure from your last
sync" above):

```bash
node aiteam/scripts/upstream-marker.mjs write            # aiteam/UPSTREAM = the upstream commit you just took
git add aiteam/UPSTREAM                                   # commit it together with the sync
# took a tag or a commit instead of the branch tip?  write --ref <that ref>
```

Run `changes` **before** `write` — it measures from the marker still in the
tree — and, the first time, **after** the checkout: a `aiteam/` that predates
this script does not have it until the checkout brings it. The aiteam-sync tool
does both by itself and the PR it opens carries the marker.

## Root files the framework distributes (and how each reaches you)

ADR 0002 keeps a few files at the **root** of your repo, outside `aiteam/`: the
harness only reads them from there, and you customize them. The scoped checkout
(`git checkout upstream/main -- aiteam/`) does not reach them, so each has its own
way in. None of them is overwritten by a sync:

| Root file | How it reaches you | What stays yours |
|---|---|---|
| `.claude/settings.json`, `.mcp.json`, `.cursor/…`, `.windsurfrules`, `.github/copilot-instructions.md`, `.gitignore`, `.beads/.gitignore` | `node aiteam/install.mjs` merges what the framework needs (a union; it adds, never removes) | everything else in the file; removing an obsolete `permissions.deny` is a hand edit (sync checklist) |
| `AGENTS.md`, `CLAUDE.md` | `install.mjs` appends the `@aiteam/…` import line | all your own guidance; the checklist flags an obsolete init sequence |
| `GEMINI.md` | **hand-merge**: the install does not inject its import line; checklist item | all your own guidance |
| `.claude/tier-rules.json` | `install.mjs` seeds it from `aiteam/templates/tier-rules.json` when you have none; afterwards a **hand-merge** (checklist; the doctor WARN lists the canonical patterns yours lacks) | the whole file — an overwrite deletes your local patterns silently |
| `.claude/agents/*.md` | generated: `cd aiteam && npm run sync:agents` (never overwrites a persona you wrote) | your own personas |
| `.beads/SCHEMA.md` | **hand-merge, only after you migrate** to the per-bead model: since rb-ai-team#37 the file is a **pointer** to `aiteam/docs/beads-schema.md` (the contract travels with `aiteam/`) plus a local appendix; the checklist item fires when the pointer is missing. **In legacy mode** (`git ls-files .beads/active.yaml` lists the file) your local copy is the contract in force until you migrate (`beads-schema.md` §11): the pointer tells agents to write `.beads/tasks/`, which the `pre-commit` refuses there — so do not swap it before the migration (the sync PR does not even list the item for a repo still in legacy mode) | the "Convenções locais" appendix |
| `.gitattributes` | **hand-merge**: checklist items (the `eol=lf` lines; the old `merge=beads-yaml` block and any `merge=union` on `.beads/` must **go**) | every other rule |
| `.github/workflows/ci.yml`, `.github/workflows/deploy.yml` | **copy-once** from `aiteam/templates/ci.yml.example` / `deploy.yml.example`; later template changes never reach your copy, so the checklist shows the template diff | the `app` job, the deploy steps |
| `SPEC.md` (`ci:` and `deploy:` blocks) | **hand-merge**: checklist; the contract tests and the doctor fail on purpose without them | the whole file |
| `.claude/skills/<name>/SKILL.md` (the per-project half of a skill) | **copy-once** from `aiteam/templates/`; checklist items for an old full copy (see [Skills with a per-project half](#skills-with-a-per-project-half)) | its ids and settings |

"Hand-merge" means: read what the upstream has now (`git show
upstream/main:<file>`, or for the copy-once ones the template under `aiteam/templates/`),
bring in what you lack, keep what is yours. Measure what changed since your last
sync with `node aiteam/scripts/upstream-marker.mjs changes` (see "Measure from your
last sync" above).

### How you find out one is behind

Nothing used to: a sync PR carries only `aiteam/`, so a root file could stay
months behind and no check noticed (the `.beads/SCHEMA.md` of one consumer was
stuck on an old copy of the contract while the contract moved on, rb-ai-team#39).
Now `node aiteam/scripts/doctor.mjs` compares the root files with the upstream
ref your clone **already has** — the remote's `HEAD`, else `upstream/main`, else
`upstream/master` — and prints a **WARN**, never a FAIL (customizing a root file
is legitimate), for what the upstream has and you do not. It is read-only and
offline: it **never runs `git fetch`**. If the tip of that ref is older than 14
days it says so and asks you to `git fetch upstream` first; with no `upstream`
remote it says it did not compare (a CI clone has none; the remote must be named
`upstream`, as in "Setup"). If you have a remote with another name that points to
the rb-ai-team (one consumer called it `rb-ai-team`), it WARNs instead and says
which: `git remote rename <name> upstream`. The first line also says which commit your `aiteam/`
came from, per `aiteam/UPSTREAM`, and how many upstream commits touched the root
files since.

| Doctor line | It WARNs when the upstream has… and you do not |
|---|---|
| `upstream do rb-ai-team (arquivos de raiz)` | not a comparison: the ref, its age, the last sync recorded in `aiteam/UPSTREAM` — or that there is none, so it cannot be measured and you check everything |
| `.beads/SCHEMA.md × upstream` | the pointer to `aiteam/docs/beads-schema.md` (yours is still a copy of the contract, or is missing) — **but not in legacy mode**: there the copy passes, with a note that the swap comes with the migration (and a pointer in a repo still on legacy is the one that WARNs) |
| `AGENTS.md / CLAUDE.md / GEMINI.md × upstream` | the `@aiteam/<file>` import line, shim by shim (a missing `GEMINI.md` counts; `install.mjs` fixes the first two, the third is by hand) |
| `.gitattributes × upstream` | the `eol=lf` rules the sync checklist asks for: `*.mjs`, `*.mts`, `aiteam/agents/*.md`, `.claude/agents/*.md`, `SPEC.md` (a global `* … eol=lf` satisfies all) |
| `CI de PR × modelo do upstream` | a script that the `framework` job of `aiteam/templates/ci.yml.example` runs (`validate:agents`, …) and none of your `pull_request` workflows runs. The file name does not matter (`ci.yml`, `build.yml`…); the `app` job is yours |

Not repeated here because it already has its own check: `.claude/tier-rules.json`
(the canonical Tier-3 patterns), `.claude/settings.json` and `.mcp.json` (the
wiring), the `ci:` and `deploy:` blocks of `SPEC.md` (the contracts) and the old
`merge=beads-yaml` block (the merge-driver residue).

## Skills with a per-project half

A skill that needs the project's own ids cannot be fully vendored: only `aiteam/`
descends in a sync, and Claude Code discovers a skill only at
`.claude/skills/<name>/SKILL.md`, never under `aiteam/`. The framework splits
such a skill in two: the procedure in `aiteam/skills/<name>/PROCEDURE.md`
(synced like any other framework file, never edited in a consumer) and a thin
`SKILL.md` in the project (the frontmatter that makes the skill discoverable,
plus its ids and settings), copied once from `aiteam/templates/` and never
overwritten by the sync. The skill becomes the trigger and the framework
becomes the content.

The first one is `trello-review` — card intake from a Trello board. A consumer
that still carries the old full copy of `.claude/skills/trello-review/SKILL.md`,
or a local `scripts/beads-trello-reconcile.mjs`, gets a hand-merge item in the
sync PR checklist (detected by the content of the local file; a consumer that
never had the skill gets none). The Trello MCP it needs now ships in
`aiteam/mcp/trello-server.ts` and the install registers it as `trello-tools` in
`.mcp.json` — but it never overwrites a `trello-tools` the consumer already
registered (typically pointing at a local `.mcp/` copy), so that swap is the
consumer's, flagged by two more checklist items
([`trello-mcp.md`](trello-mcp.md)). The swap — thin `SKILL.md` from
`aiteam/templates/trello-review-SKILL.md.example`, and
`aiteam/scripts/beads-trello-reconcile.mjs` in place of the local script — is a
per-consumer step, on demand: [`trello-review-adoption.md`](trello-review-adoption.md).
Its two bead fields, `trello` and `trello_scope`, are validated by the
framework ([`beads-schema.md`](beads-schema.md) §3.5).

## Conflicts are cheaper here than elsewhere

- `.beads/` needs **no merge driver**: each branch writes only its own
  `.beads/tasks/<id>/<branch>.yaml`, so git never conflicts there — not even in
  a merge made on GitHub ([`aiteam/docs/beads-schema.md`](beads-schema.md) §4).
  **The `merge=beads-yaml` mapping leaves your `.gitattributes` at the sync,
  legacy mode included** — the sync checklist has an item for it, and the
  framework's contract test (`aiteam/src/githooks-contract.test.ts`) fails while
  any `beads-yaml` is left in that file. Remove the whole old block, comment
  included, not just the mapping lines: the block is three comment lines
  (`Conflict-free merges…`, `…beads-merge.ts`, `…merge.beads-yaml.*`) and two or
  three `merge=beads-yaml` lines, and the test matches the comment too.

  ```bash
  sed -i.bak -E '/^#.*(Conflict-free merges for the Bead Board|beads-merge\.ts|merge\.beads-yaml)|merge=beads-yaml/d' .gitattributes && rm .gitattributes.bak
  git diff -- .gitattributes     # only the old block goes; the eol=lf rules stay
  grep -n beads-yaml .gitattributes
  ```

  The `sed` is narrow on purpose: it removes only those lines. If `grep` still
  finds `beads-yaml` — in the comment of **another** rule (say, a paragraph over
  an `index.yaml … merge=union` line) — rewrite that comment without citing the
  driver. The contract test and the sync item keep failing until you do; that is
  a visible failure by design, not something a broader `sed` should hide by
  eating the paragraph.

  A `merge=union` rule on anything under `.beads/` (say
  `.beads/archive/index.yaml merge=union`) goes too: it is the same silent union —
  on a local merge it joins the lines of both sides with no conflict and can
  duplicate or corrupt the YAML — and the contract test does not catch it. The
  sync checklist has its own item: drop the rule and the comment paragraph
  attached to it (usually the paragraph that still cites `beads-yaml`, so the two
  items resolve together). In the per-bead model `archive/` disappears at
  migration; until then a visible conflict is better. Afterwards check the
  `git diff`, the contract test green
  (`npm --prefix aiteam test -- githooks-contract`) and that `grep -nE
  'beads-yaml|^[[:space:]]*(/|\*\*/)?\.beads/.*merge=union' .gitattributes`
  finds nothing.

  What changes, in a repo still on the old single-file model (legacy mode): a
  local merge of `.beads/active.yaml` now shows a conflict instead of uniting it
  silently (that silent union once corrupted a consumer's `active.yaml`). In the
  per-bead model there is nothing to conflict on — the point above. A merge made
  on GitHub is unchanged either way, it never ran the driver.
  The `merge.beads-yaml` section left in your `.git/config` is inert once the
  mapping is gone — `node aiteam/scripts/doctor.mjs` warns about it and prints
  when to delete it (`git config --remove-section merge.beads-yaml`).
  A repo still on the old single-file model migrates with
  `node aiteam/scripts/migrate-beads.mjs --dry-run` (§11), on demand, in a
  session of its own — step by step, open branches and worktrees included, in
  [`beads-migration-runbook.md`](beads-migration-runbook.md). Until then the old
  `aiteam/scripts/beads-merge.ts` stays in the framework only so that a consumer
  who has not applied this hand-merge yet does not break on every local merge
  (removed after phase 3 of #37); nothing should map to it any more.
- Keep your **app code out of the framework paths** so scoped updates (Option B)
  rarely touch your business logic.

## Alternative: git subtree

If you prefer the framework to live in a subdirectory of the consumer:

```bash
git subtree add  --prefix vendor/rb-ai-team upstream main --squash
git subtree pull --prefix vendor/rb-ai-team upstream main --squash   # later updates
```

This keeps a clean separation but means the framework isn't the repo root, so
the hooks/paths above need re-pointing.

## When to graduate to a package

Once the "framework" surface stabilizes, publishing the reusable parts as an npm
package (or an `npx create-rb-ai-team` scaffolder) turns updates into
`npm update` and removes the manual merge step entirely. That is the deferred
follow-up to the template decision (Blueprint 8.8); the `upstream` remote above
is the zero-setup answer until then.
