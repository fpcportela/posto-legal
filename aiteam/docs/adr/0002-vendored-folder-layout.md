# ADR 0002 — Vendored folder layout (`aiteam/`)

> Date: 2026-06-30 · Status: accepted · Supersedes part of the distribution
> decision in [0001](0001-native-primitives.md) and
> [consuming-as-upstream.md](../consuming-as-upstream.md).

## Context

The framework historically *was* the repository: `src/`, `package.json`,
`tsconfig.json`, `README.md`, `docs/`, `.github/`, `scripts/` etc. all live at
the root. When dropped into or merged onto an existing host project, those root
files collide hard with the host's own `src/`, `package.json`, build config,
README and CI. The framework cannot be "used inside another project" without
polluting it.

## Decision

Vendor the **entire framework into a single namespaced folder, `aiteam/`**, with
its own `package.json`, so the host's tree is untouched except for an
irreducible, conventional root footprint.

### What stays at the host root
- **State / interface:** `SPEC.md`, `.beads/` — human-authored / framework-managed
  project state. These do not collide (framework-specific names) and are the
  contract surface between host and framework. *(Decision: keep at root, not
  inside `aiteam/`.)*
- **Tool convention (required there):** `.claude/settings.json`,
  `.claude/tier-rules.json`, `.mcp.json`, and `CLAUDE.md` / `AGENTS.md`. The
  Claude Code harness only reads these from the root. Their bodies point *into*
  `aiteam/`; `CLAUDE.md`/`AGENTS.md` carry a single `@aiteam/…` import line so
  framework content never collides with the host's.

### What moves into `aiteam/`
Everything else: `src/`, `scripts/`, `evals/`, `prompts/`, `tools/`, `docs/`,
`agents/` (was `.agents/`), `skills/` (was `.agent/skills/`), `mcp/` (was
`.mcp/`), `hooks/` (was `.claude/hooks/` + `.githooks/`), `package.json`,
`tsconfig.json`, `vitest.config.ts`, `docker-compose.yml`, `.devcontainer/`,
and the framework's `CLAUDE/AGENTS/GEMINI/README.md`.

### Path resolution — the linchpin
Framework code historically anchors state reads on `process.cwd()`, which only
works because cwd *was* the framework root. After vendoring, framework tooling
may run with cwd = `aiteam/`, while state lives at the host root. Introduce one
helper, **`repoRoot()`** (= `git rev-parse --show-toplevel`, cached per-cwd,
fallback `process.cwd()`), and anchor every framework-state read on it:
`SPEC.md`, `.beads/*`, `.claude/tier-rules.json`, `session-log`, `cost-log`.

**Two roots, kept distinct:** framework *state* resolves via `repoRoot()`; host
*operations* (the MCP `git_commit`/`run_tests` tools, the Bead Board's
`git worktree list`) keep acting on the host repo via cwd/git. Conflating them
is the main bug risk.

The PreToolUse and git hooks always run with cwd = repo root, so they keep cwd
for state reads; only their internal file/import paths change.

### Installer (`aiteam/install.mjs`) — the non-relocation parts
1. **Git hooks:** `core.hooksPath` is single-valued, so the installer *chains*
   the framework hooks into the host's existing hooks instead of clobbering the
   path.
2. **Config merge:** idempotently merge the framework's `.claude/settings.json`
   (deny + PreToolUse hook) and `.mcp.json` (server entry) into the host's, and
   inject the `@aiteam/CLAUDE.md` / `@aiteam/AGENTS.md` import lines.

## Consequences
- Host integration is clean; recommended wiring is an npm **workspace** so
  `aiteam/`'s deps resolve without touching the host lockfile.
- Migration is ~95% mechanical (move + rewrite references); the residual risk is
  concentrated in `repoRoot()` and the installer, so the rollout is phased with
  a green test suite gating each step.
- The committed personal `.claude/agent-memory/` is removed during the move.

## Rollout (each phase gated by typecheck + 121 tests + validate:beads + hook smoke)
1. Add `repoRoot()` and re-anchor state reads **on the current tree** — prove
   behavior-preserving before moving anything.
2. `git mv` into `aiteam/`; rewrite all internal references and config paths.
3. Root shims + `install.mjs`; update the consumption guides.
