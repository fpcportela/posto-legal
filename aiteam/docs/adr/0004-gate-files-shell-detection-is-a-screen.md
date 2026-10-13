# ADR 0004 — Gate files (F13): the shell detection is a screen, not a sandbox

> Date: 2026-10-06 (revised 2026-10-07) · Status: accepted (PO decision) ·
> Records where the F13 work stops. Rule and file list:
> [`AGENTS.md`](../../AGENTS.md) §Mechanical enforcement. Builds on
> [0003](0003-deploy-gate-single-ask.md): the ASK is the gate, and an edit of the
> gate itself needs the same human click.

## Context

Rewriting a file that IS the gate (`SPEC.md` `allow_tier3`, `.claude/tier-rules.json`,
the hooks, permissions and `env` of `.claude/settings.json`, `.mcp.json`, and in a
consumer the guard's own code) switches the gate off without tripping a Tier-3
pattern. F13 asks for a human on such an edit, by two routes:

- the edit tools (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`), in
  `aiteam/hooks/gate-edit-guard.mjs`: the tool says which file and what it
  writes, so the verdict needs no shell parsing. It is the strong half, not a
  proof: an Edit whose old text the guard cannot find as written (the Edit tool
  also matches curly quotes with straight ones) cannot be applied to check what
  it changes, and on `SPEC.md` that case asks;
- the shell, in `aiteam/hooks/tier-guard.mjs` through
  `aiteam/src/gate-files-core.mjs`: the command is text, and deciding what it
  writes means parsing a shell.

The shell route went through five rounds of automated security review (an
allowlist instead of a deny-list for `settings.json`, links to the gate
directory, git comparisons by `git diff`, a patch read before it is applied, a
marker file the agent could create, the git global options, `-c` keys). Each
round found a real defect, and each fix added parsing surface that the next round
reviewed. Two of those fixes turned open lists into CLOSED ones (git's global
options, `-c`/`--config-env` keys, subcommands that are builtins): anything the
parser does not know asks. That closes the git PARSER as a class. The git
COMPARISON did not survive: running `git diff` inside the hook to see whether a
merge, a rebase or a pull brings a changed gate file was the largest source of
asks and of surface (refs, parents, stashes, a git that runs somewhere else, a
deadline of 2 s that a loaded machine overran), and what those commands bring
arrives reviewed, through a PR. The PO cut it: **no git runs inside the hook**, and
a git command asks only when it names a gate file (or the directory of one) as an
operand it writes, or when its command line runs something the parser does not
follow. None of this makes the shell route a barrier, because the set of programs
that can write a file is open by nature.

Cost measured on 107,974 real commands (59,109 from the QA corpus, 48,865 from
Claude Code sessions; every figure in this ADR is on that one set): 303 ask
(0.28%). With the git comparison it was 717 (0.66%): the 416 that disappeared are
`git pull` (178), `git merge` (97), `git stash pop` (73), `git reset` (39), `git
cherry-pick` (15), `git rebase` (12) and `git revert` (2). What is left is mostly
the git forms that name a gate file (`git checkout <ref> -- <path>`, `git restore`),
`git -c <key>` with a key outside the harmless list, and `node -e` scripts or
redirects that name `SPEC.md` or `tier-rules.json` with a write API.

## Decision

Stop here. The shell detection stays a screen against accidents and the usual
way of writing a gate file, and the documents say so. It is not extended with an
allowlist of readers, and `aiteam/githooks/*` and `aiteam/src/push-guard-core.mjs`
stay outside the set that counts as the gate's own code.

What it does not catch is listed in `AGENTS.md` (§Mechanical enforcement, "What
still passes without an ask"): writers outside its list, wrappers it does not skip,
scripts it does not read, paths built at run time, `ed`/`ex` scripts, the git forms
that pass (every merge, rebase without `-x`, cherry-pick, revert, pull, `reset
--hard`, `stash pop|apply|branch` and branch checkout, plus `git config <key>
<value>`, `git rm|mv` of a gate file and what git itself runs), the portable
backstops, the tools of other MCP servers, and the gap between decision and run.

One case was closed after the list was first written, by the PO: every in-place
edit of `SPEC.md` by shell (`sed -i`, `perl -i`, `ruby -i`, `awk -i inplace`) asks,
whether or not the command names `allow_tier3`. `sed -i '4s/false/true/' SPEC.md`
flips the break-glass without naming it, and the command does not say which line
that is. Cost on real commands: 0 of the 59,109 in the QA corpus change, and 2
of the 107,974 once the Claude Code sessions are added (both a `sed -i` on a
scratch copy of a `SPEC.md`). Printing (`sed 's/x/y/' SPEC.md`, `sed -n`) and
reading still pass.

Two limits fail closed instead of open: a command nested more than 3 levels deep
(a shell inside a shell inside an `eval`) and more than 32 control words or
groupings in front of a program are not followed, and both ask. The same rule
applies to the review's later findings: a limit that is reached asks, and a new
parser goes to the follow-ups, not into the guard.

## Consequences

- A stronger guarantee than "an agent that wants to evade it, cannot" needs a
  mechanism that does not depend on how the command is spelled: `permissions.ask`
  rules in `.claude/settings.json` (the harness asks before the tool runs) or an
  OS sandbox / file permissions the agent cannot write through. Either is a
  decision about the environment, not about this parser.
- The edit-tool route stays the strong half. The shell route is worth its false
  positives (0.28% of commands, most of them `git` forms that name a gate file) for
  the accidents and the common forms it does catch.
- A new git global option asks until it is added to the closed list in
  `gate-files-core.mjs`; that is the intended direction of the failure.
- In the upstream, the exemption for the guard's code does not reach
  `.claude/tier-rules.json`: syncing it from `aiteam/templates/tier-rules.json` is
  an edit of a gate file and asks, so a background subagent cannot finish it. Do
  it in the main session. A consumer never defines `AITEAM_UPSTREAM`.
