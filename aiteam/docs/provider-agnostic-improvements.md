# Provider-agnostic — honesty matrix & improvement plan

> Addresses audit finding #6 and the user directive "provider-agnostic, vamos
> melhorar, é necessário." `AGENTS.md` claims the framework applies to Claude
> Code, Cursor, Windsurf, Copilot and Gemini CLI, but today the *mechanical*
> enforcement is Claude-Code-only; on other tools the tiers are prose. This plan
> makes the claim honest AND lifts as much enforcement as possible to a portable
> layer.
>
> **Status: done, with recorded gaps.** The adapters, the pre-push backstop and
> the calibrated `AGENTS.md` banner are implemented — see §3 Acceptance. Still
> open: the README (EN/PT) carries neither the matrix nor a link to it; the
> install's writing of the four adapters has no automated test (only
> `ensurePointerFile` does); the install does not create the root `GEMINI.md`;
> and §2c's "Tier-3 only through the MCP tools" did not become the documented
> path (the sanctioned deploy is the `AGENTS.md` §CI/CD Mandate one). Tracked
> as bead `spec-provider-agnostic-matrix`, closed with these gaps in its
> summary.

## 1. Portability matrix (what is actually enforced where)

| Capability | Mechanism | Portable? |
|---|---|---|
| Persona/role contract | `AGENTS.md`, `aiteam/agents/*.md` (markdown) | ✅ Any agent that reads instruction files |
| Skills | `aiteam/skills/*` (markdown) | ✅ Portable (loaded as docs) |
| Secret scanning | git **pre-commit** (`scan-secrets`) | ✅ Fires on `git`, agent-independent |
| `.beads` ownership + format (one file per bead and per branch) | git **pre-commit** | ✅ Fires on `git`, agent-independent, plain node |
| `.beads` generated views | git **post-checkout / post-merge / post-commit / post-rewrite** | ✅ Fires on `git`, agent-independent |
| `.beads` view/branch-file write guard | `.claude/settings.json` + `beads-guard.mjs` PreToolUse | ❌ Claude Code only (the pre-commit is the portable gate) |
| MCP tool tier gating (`deploy_production`, `db_migrate`) | `aiteam/mcp/registry.ts` dispatch | ◑ Any MCP-capable client (Claude, Cursor, Windsurf) |
| **Runtime Tier-3 command block** (Bash, PowerShell, Monitor, desktop terminal) | `.claude/settings.json` + `tier-guard.mjs` PreToolUse | ❌ **Claude Code only** |

**Conclusion:** most of the framework is already portable (it lives in markdown
and git hooks). The single Claude-only piece is the *runtime command* gate. Be
explicit about this instead of implying full parity.

## 2. Plan

### 2a. Calibrate the claim (cheap, do first)
- Add the matrix above to `AGENTS.md` (or link it) and the README, replacing the
  flat "applies to Cursor/Windsurf/Copilot/Gemini" with "the contract and the
  git-level guardrails are portable; the *runtime* Tier-3 command gate is currently
  Claude-Code-specific."

### 2b. Ship per-tool adapters so the contract actually loads
Thin files that point each tool at the canonical `AGENTS.md` (no duplicated rules):
- **Cursor:** `.cursor/rules/aiteam.mdc` (or `.cursorrules`) → "Read and obey
  `AGENTS.md` and the active persona in `aiteam/agents/`."
- **Windsurf:** `.windsurfrules` → same pointer.
- **GitHub Copilot:** `.github/copilot-instructions.md` → same pointer.
- **Gemini CLI:** `GEMINI.md` (exists) — keep as the pointer.
- **MCP clients:** also emit `.cursor/mcp.json` (Cursor) mirroring `.mcp.json` so
  the tool server registers outside Claude too.
These are generated/merged by `aiteam/install.mjs` (Phase 3), idempotently.

### 2c. Lift enforcement toward the portable layer
- The most dangerous Tier-3 actions (prod deploy, DB drop) should be reachable
  **only** through the MCP tools (already tier-gated in `registry.ts`), not ad-hoc
  Bash — document this as the portable enforcement path. Any MCP-capable agent
  then inherits the gate.
- Add a git **pre-push** hook as a portable backstop for the worst destructive
  git operations (force-push to protected branches), reusing `tier-core.mjs`
  classification. This catches a class of Tier-3 regardless of agent.
- Accept the residual gap honestly: arbitrary runtime shell on non-Claude agents
  cannot be mechanically gated by this repo; the matrix says so.

## 3. Acceptance
- [x] `AGENTS.md` carries the matrix (linked); no claim implies runtime parity
  it lacks — see the calibrated "Applies to" banner and "Portable backstop"
  note in `aiteam/AGENTS.md`.
- [ ] The README (EN/PT) carries the matrix or links to it — not done: the
  README has neither.
- [x] `install.mjs` writes the per-tool adapter pointers (idempotent,
  non-clobbering) — `.cursor/rules/aiteam.mdc`, `.cursor/mcp.json`,
  `.windsurfrules`, `.github/copilot-instructions.md`. Verified live against a
  temp host repo: fresh install writes all four, a second run is a no-op, and
  pre-existing host content in a shared file (e.g. `.windsurfrules`) is
  preserved and only appended to.
- [x] A git pre-push backstop blocks force-push to protected branches. It does
  **not** literally reuse the Bash `tier-core.mjs` regex classifier — a native
  git pre-push hook receives ref updates on stdin, never the command line, so
  there is no command string to classify. `aiteam/src/push-guard-core.mjs`
  instead detects the same Tier-3 event structurally (non-fast-forward update
  to `refs/heads/main|master`) and gates it behind the same
  `tier_defaults.allow_tier3` flag via the shared `allowTier3FromSpec`
  (extracted from `tier-guard.mjs` into `tier-core.mjs` so the two gates can't
  drift on what "approved" means). Wired into `aiteam/githooks/pre-push`
  (tsx-backed, with a bash-only fallback) and into `install.mjs`'s hook-chaining
  list for consuming host repos. Verified live: fast-forward pushes to `main`
  pass, a rewriting push to `main` is blocked, the same rewrite to a
  non-protected branch passes, and the bash fallback reproduces the block
  without Node. The fallback cannot read `SPEC.md`, so it blocks regardless of
  `allow_tier3`; its message tells the user to install the toolchain, which is
  what makes the break-glass apply.
- [x] Tracked as bead `spec-provider-agnostic-matrix`.
