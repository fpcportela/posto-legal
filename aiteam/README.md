<div align="center">

# 🤖 RB AI Team

### The AI-Powered Software Factory

*An opinionated multi-agent template for AI-assisted development — personas, permission tiers, a cost circuit breaker, and git-backed memory.*

> **Status:** in active validation. The framework is wired up and tested, but the "autonomous, idea-to-production" workflow is still being dogfooded — see the [backlog](https://github.com/thiagoriosbraz/rb-ai-team/blob/main/.beads/BACKLOG.md). Treat strong claims below as the design intent, not a finished guarantee.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#)
[![Claude](https://img.shields.io/badge/AI-Claude%20Sonnet-8A2BE2?logo=anthropic)](https://claude.ai)
[![Gemini](https://img.shields.io/badge/AI-Gemini-4285F4?logo=google)](https://gemini.google.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6?logo=typescript)](https://www.typescriptlang.org)
[![TDD](https://img.shields.io/badge/Methodology-TDD-brightgreen)](#)
[![OWASP](https://img.shields.io/badge/Security-OWASP%20LLM%20Top%2010-red)](#)

---

**[🇺🇸 English](#english) · [🇧🇷 Português](#português)**

</div>

---

<a name="english"></a>
# 🇺🇸 English

## What is this?

**RB AI Team** is more than a boilerplate: it's an **opinionated multi-agent development framework** packed into a repository. Powered by Claude and Gemini, it coordinates specialized AI personas that plan, architect, build, and test software — following strict permission tiers, TDD, and OWASP security standards. The aim is an agent team you can point at an idea; today it's a well-structured, mechanically-enforced template under active validation.

> Drop in your idea. The agents help you take it from scope to a tested implementation.

---

## 🧠 The Team

| Persona | Role | Activates When |
|---|---|---|
| 🎯 **Lead Orchestrator** | Plans, decomposes tasks, enforces rules | Always — the default hat |
| 📋 **Product Manager** | Runs Discovery Mode, writes `SPEC.md` | Product work with no scope in `SPEC.md`, or an unscoped idea |
| 🎨 **Frontend Expert** | React/Next.js, Tailwind, TDD components | UI/UX work |
| ⚙️ **Backend Architect** | Prisma, Supabase, secure APIs, Zod | APIs, DB schemas, business logic |
| 🏗️ **System Design Architect** | Docker, VPS, CI/CD, cloud topology | Infrastructure and deployment |
| 🚀 **Release Engineer** | Runs the release: preconditions, the one-shot ASK, the deploy workflow, version health check, rollback by `deploy/` tag | Shipping to production |
| 🔍 **QA & Security Reviewer** | Audits, OWASP checks, test coverage | Before any merge |
| 🐛 **Deep Debugger** | Root cause analysis, trace inspection | Bugs and production incidents |
| 📊 **Data & AI Engineer** | Data pipelines, Vector DBs, RAG | High volume data and AI search |
| 🛡️ **SRE / FinOps** | Observability, incident response, FinOps | Uptime and cloud cost reduction |
| 🖌️ **UX/UI Designer** | User journeys, CRO, WCAG a11y | Before frontend implementation |

---

## 🏭 The Software Factory Workflow

```
💡 Idea
  └─► 📋 Product Manager   →  SPEC.md (MVP defined)
        └─► 🏗️  Architect    →  docker-compose.yml + topology
              └─► ⚙️  Backend  →  API + DB schemas
                    └─► 🎨 Frontend →  UI components
                          └─► 🔍 QA/Sec →  audits + tests
                                └─► 🚀 Deployed
```

---

## 🔐 Permission Tiers

The permission-tier table is maintained in a single canonical location —
**[`AGENTS.md` → Permission Tiers](./AGENTS.md#permission-tiers)** — to avoid
drift. Tier 3 (production/destructive) is enforced mechanically by the
`aiteam/hooks/tier-guard.mjs` `PreToolUse` hook (patterns in
`.claude/tier-rules.json`), plus `.claude/settings.json` deny rules — not just
documented here. If that file is missing or unreadable, the hook protects with
the framework's canonical copy (`aiteam/templates/tier-rules.json`) and says so
in its reason; it does not let everything through. The hook classifies every command run through Bash,
PowerShell, Monitor and the desktop app's terminal tool: a production deploy
gets a one-shot ASK, a destructive command a deny that quotes the sub-command
and, for a class with its own advice (`tier3.deny_hints`, e.g. host control over
SSH), explains it — otherwise it gives the break-glass instruction. Text passed
as a message (`git commit -m`, `gh issue|pr --body`/`--title`) is data, not a
command; a `$(…)` inside it still counts. The only override is
`allow_tier3: true` directly under `tier_defaults:` in `SPEC.md`, read the same
in LF and CRLF. It is GLOBAL: it also lifts the deploy ASK, so set it back to
`false` right after the emergency use.

---

## 🧠 Git-Backed Memory Architecture

Instead of volatile chat context, state is persisted in Git:

| File | Purpose |
|---|---|
| `AGENTS.md` | Supreme law — Permission Tiers, TDD mandates, global rules |
| `SPEC.md` | Single source of truth — scope, architecture, open decisions; its frontmatter feeds the gates (`budget_usd`, `tier_defaults`, `ci:`, `deploy:`, `infra_kb`) |
| `.beads/tasks/<id>/<branch>.yaml` | The beads — one file per task and per branch, appended at the end (contract: `aiteam/docs/beads-schema.md`). `.beads/active.yaml` and `.beads/index.yaml` are views generated from them, out of git. Write them with `node aiteam/scripts/beads.mjs` (`npm --prefix aiteam run beads -- status`); it also shows other branches' beads, marked as not merged |
| `CLAUDE.md` | Claude-specific boot protocol |
| `GEMINI.md` | Gemini-specific boot protocol |

---

## 🎯 AI Skills

Specialist agents load domain skills from `aiteam/skills/`:

| Skill | Used By |
|---|---|
| `ui-ux-pro-max` | Frontend Expert |
| `agile-product-owner` | Product Manager |
| `security-privacy-child-safety` | Backend Architect |
| `qa-testing-automation` | QA & Security Reviewer |
| `ai-rag-prompt-engineer` | Orchestrator |
| `dba-prisma-supabase-optimizer` | Backend Architect |
| `tech-writer-docgen` | Any persona |
| `trello-review` | Orchestrator — a slash command: the procedure ships in `skills/trello-review/PROCEDURE.md`, each project keeps a thin `.claude/skills/trello-review/SKILL.md` ([docs/trello-review-adoption.md](docs/trello-review-adoption.md)); the Trello MCP it uses ships in `mcp/trello-server.ts` ([docs/trello-mcp.md](docs/trello-mcp.md)) |

The framework does not need the [superpowers](https://github.com/obra/superpowers) plugin, but it was **validated with superpowers 6.4.1** (the version the official Claude Code marketplace serves; 6.4.2 only changes `writing-plans`): its rules for what that plugin's skills leave behind — `.superpowers/` as scratch and never state, the skills' final review next to the QA & Security Reviewer, the local test gate — are written against that version's behavior. `node aiteam/scripts/doctor.mjs` reports the installed version and whether the plugin is on: INFO, or WARN on Windows below 6.2.0 when the plugin is on or has no declared state (its SessionStart hook failed silently there; turned off, it stays INFO).

---

## 🚀 Getting Started

### First-Time Setup (~2 minutes)

```bash
# 1. Use this template (or clone)
git clone https://github.com/thiagoriosbraz/rb-ai-team.git my-new-project
cd my-new-project

# 2. Install dependencies (cd is safer for some terminal environments)
cd aiteam
npm install
cd ..

# 3. Activate the git-backed memory hooks (CRITICAL)
git config core.hooksPath aiteam/githooks
chmod +x aiteam/githooks/*  # (Mac/Linux/Git Bash only. Ignore if on PowerShell)

# 4. Configure your API key. Nothing in aiteam/ loads a .env file: the Anthropic
#    SDK reads ANTHROPIC_API_KEY from the environment, so export it in your shell
#    (aiteam/.env.example documents the optional ones, e.g. AI_SESSION_BUDGET_USD)
export ANTHROPIC_API_KEY=<your-key>   # PowerShell: $env:ANTHROPIC_API_KEY = "<your-key>"

# 5. Bootstrap state. The clone brings the framework's own SPEC.md and beads:
#    for a new project, fill in SPEC.md and reset .beads/tasks/ as in "Using This
#    Repo as a Template" (steps 4–5). bootstrap-beads and generate-spec are for
#    adopting into an existing repo (next section); both refuse to overwrite.
npm --prefix aiteam run sync:agents         # generate .claude/agents/ from the canonical personas

# 5b. On Windows, the cloned .gitattributes already pins these to LF. A repo that
#     brought only aiteam/ adds them BEFORE sync:agents, or the drift check will
#     flag correct bindings (CRLF checkout vs LF generation):
#       aiteam/agents/*.md  text eol=lf
#       .claude/agents/*.md text eol=lf
#       SPEC.md             text eol=lf
#     (the SPEC.md line is defense in depth: its frontmatter readers accept CRLF)

# 6. (Optional) Start observability
docker compose -f aiteam/docker-compose.yml --profile observability up -d   # Langfuse on :3001
```

### Adopting into an Existing (Legacy) Project

If you are dropping `rb-ai-team` into an ongoing project, the framework is designed to **not interfere** with your existing CI, linting, or formatting rules. See the full guide at **[docs/legacy-onboarding.md](docs/legacy-onboarding.md)**.
1. **Copy the framework:** Bring the `aiteam/` folder to your repo, then run `cd aiteam && npm install`. The tier map `.claude/tier-rules.json` lives outside `aiteam/`, so it is not part of that copy: step 3's `install.mjs` creates it from `aiteam/templates/tier-rules.json` when it is missing (and never overwrites yours), and until it exists the tier-guard protects with that canonical copy instead of letting everything through. Do **not** reach for npm's `--prefix` flag here: it sets the install *target* only — the manifest is still read from the current directory, so you end up installing the wrong `package.json` (or none at all).
2. **Draft the Spec:** Run `npm --prefix aiteam run generate-spec` (npm runs the script inside `aiteam/`, but it writes to your repo root by default; `-- ..` or any other directory after `--` still works as an explicit target; it makes one Claude call, so export `ANTHROPIC_API_KEY` in your shell first — nothing in `aiteam/` reads a `.env`). Review the AI-generated `SPEC.md` draft, then check the two frontmatter blocks the script writes from code, not from the model. `ci:` comes from your `package.json` scripts (`test`, `typecheck`, `lint`), run with the package manager your repo uses (`packageManager` field or lockfile: `pnpm run`, `yarn run`, `bun run`; `npm run` otherwise) and `workdir: .`: fix the commands or the `workdir` if the app lives elsewhere, and if there is no `test` script, declare the command or the opt-out `test: none` + `reason`. A `test:changed`, `test:affected`, `test:related` or `test:local` script also becomes `local_test:`, the optional local gate the agents run while they work, in place of `test` (CI still runs the full `test`). `deploy:` is a placeholder (`workflow: deploy.yml`, empty `version_url`): copy `aiteam/templates/deploy.yml.example` to `.github/workflows/deploy.yml` and set `version_url`, or switch to the opt-out `workflow: none` + `reason` if there is no production deploy (format: `AGENTS.md` §CI/CD Mandate). The contract tests and the doctor fail on the draft's `deploy:` until it is filled in, on purpose: the draft never opts out for you. Commit it.
3. **Bootstrap Memory & Wire Hooks:** Run `npm --prefix aiteam run bootstrap-beads` (it targets your repo root by default; `-- <dir>` picks another one) to map your git history into beads under `.beads/tasks/`. Then, run `node aiteam/install.mjs` to safely chain the git hooks without breaking your existing ones. A repo already on the framework's old single-file beads migrates instead (step 7).
4. **Generate the native subagents:** Run `npm --prefix aiteam run sync:agents` to render `.claude/agents/` from the canonical personas. Your own agent files are never overwritten — a same-named one is reported and left alone. On Windows, add the `eol=lf` lines from step 5b of the quick-start above to `.gitattributes` first.
5. **Health Check:** Run `node aiteam/scripts/doctor.mjs` to confirm everything is wired correctly. Expect `PASS` on every check; a `FAIL` names what is missing (without `.claude/tier-rules.json`, or with one that does not parse, the tier-guard falls back to the canonical copy and the doctor fails that check until `node aiteam/install.mjs` creates the file or you fix it), and a `WARN` is not a failure: a declared opt-out such as `workflow: none`, a `.claude/tier-rules.json` that lacks Tier-3 patterns the canonical copy has (the warning lists them), or one with a pattern that backtracks catastrophically (a hook timeout fails open, so a command built to time the guard out would run ungated; the warning names the pattern, runs a probe in a child process so it never hangs the doctor, and for the old `ssh` script pattern gives the replacement to paste). It also `WARN`s when a root file the framework distributes is behind what the upstream has — your `.beads/SCHEMA.md` is still a copy of the contract instead of the pointer (only once the repo has migrated off legacy mode: there the local copy is the contract in force), a shim lacks its `@aiteam/…` line, the `.gitattributes` lacks the `eol=lf` rules, no `pull_request` workflow runs a step of the template's `framework` job — comparing with the `upstream` ref your clone already has (read-only: it never fetches, so run `git fetch upstream` first; see [docs/consuming-as-upstream.md](docs/consuming-as-upstream.md)).
6. **Dogfooding:** Pick a small bugfix and run it through the agent workflow to get comfortable before scaling up.
7. **Keep it updated:** Pull framework updates as in **[docs/consuming-as-upstream.md](docs/consuming-as-upstream.md)**, then re-run `node aiteam/install.mjs`: it adds the new hook entries to `.claude/settings.json` (the doctor fails naming any command tool the tier-guard does not cover yet), `worktree.baseRef: "head"`, and `.claude/worktrees/`, `.trello-cache/` and `.superpowers/` to `.gitignore`. `.claude/tier-rules.json` is yours: the install only creates it when it is missing, so merge new patterns by hand (`git diff --no-index aiteam/templates/tier-rules.json .claude/tier-rules.json` shows what the canonical copy has that yours lacks; the doctor warns with the same list). The scoped checkout takes `aiteam/` only: the other root files (`.beads/SCHEMA.md`, the `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` shims, `.gitattributes`, your CI workflows) are yours, and the table in that guide says how each one reaches you. Record the sync with `node aiteam/scripts/upstream-marker.mjs write` (the aiteam-sync PR does it for you) so the next pull measures what changed in the root files from your last sync, not from the previous release. A repo still on the old single-file beads (`git ls-files .beads/active.yaml` lists it) runs in legacy mode until it migrates: the hooks stop resetting and mirroring the backlog and warn that it is time to migrate, and they refuse the new model before that — the `pre-commit` refuses `.beads/tasks/` and `.beads/project/`, and the `beads-guard` denies a Write there. Migrate with `node aiteam/scripts/migrate-beads.mjs --dry-run`, then without `--dry-run` (`--recover-mirrors` brings beads that live only in a branch mirror), and commit. Afterwards, `--scan-history` recovers beads the old model lost, and `--port`/`--port-from` port a branch opened before the migration ([docs/beads-schema.md](docs/beads-schema.md) §11).

### Daily Workflow

1. **Agents:** Read `CLAUDE.md` or `GEMINI.md` and adopt the Orchestrator persona immediately.
2. **Humans:** Just describe your idea. If `SPEC.md` is empty, the Product Manager agent will interview you first.
3. **Cost safety:** `aiteam/src/circuit-breaker.ts` wraps non-streaming AI calls. Once `budget_usd` in `SPEC.md` is reached the *next* call throws, and a predictive pre-call guard refuses any single call whose worst case would breach the budget. Streaming calls are not metered (you're warned once). The session cost lives only on local disk (`.beads/session.local.json`), never in git.
4. **Branch-independent memory:** every branch writes only its own bead files, so merges never conflict in `.beads/` and no backlog is lost; `git checkout`, merge, commit and rebase regenerate the views.
5. **Model Routing (Manual):** As the human orchestrator in your IDE, switch models depending on the task. For planning, discovery, or complex logical decisions, use the current top tier (the latest Claude Opus or Fable, or Gemini's Pro tier). For development of well-defined tasks, use the current fast tier (the latest Claude Sonnet, or Gemini's Flash tier) to code quickly and cost-effectively. The personas pin `sonnet`/`opus` aliases in their frontmatter, so native subagents follow the current generation without edits.
6. **Isolated dispatch (Claude Code):** a subagent that edits files is dispatched with `isolation: "worktree"`, so it works on its own branch and worktree, never in your checkout; read-only ones (review, exploration) don't need it. The worktree starts from your local `HEAD` (`worktree.baseRef: "head"`) under the git-ignored `.claude/worktrees/`. It is born without `aiteam/node_modules`: the subagent runs `node aiteam/scripts/worktree-link.mjs link` first (it links the main checkout's — never `npm install` there) and `unlink` before it reports. Remove a worktree with `node aiteam/scripts/worktree-link.mjs remove <path>`: on Windows a bare `git worktree remove` follows the link and empties the main checkout's `node_modules`.

---

## 📊 Bead Board — Visual Observability Dashboard

A standalone, real-time dashboard that turns the generated `.beads/active.yaml` into a live 2.5D animated view of your AI team at work. Fully isolated under `aiteam/tools/bead_board/` — drop-in portable across any `rb-ai-team` repo.

**What it delivers**
- Live agent room with idle/working animations, one desk per persona, routed by a keyword in the bead id (convention: a prefix — `aiteam/docs/beads-schema.md` §5).
- Click-through task popovers and a full Kanban view (`pending` / `in_progress` / `completed`).
- Session budget burn-rate from the local session cost (`.beads/session.local.json`, via the view).
- Two themes: 🎮 **Retro Gamer** (8-bit isometric) and 👔 **Silicon Valley** (premium SaaS glassmorphism).
- Read-only by design — mutate state via CLI/agents, observe via the board. It regenerates the views first when a bead file is newer than them.

**Start it**
```bash
# From repo root — zero dependencies beyond Python 3.x
python aiteam/tools/bead_board/server.py
# Open http://localhost:8080/
#  • /         → 2.5D agent room (room.html)
#  • /kanban   → detailed Kanban board (index.html)
#  • /panorama → project phases and critical path (panorama.html)
#  • /api/state → JSON { worktrees, yaml, index, branch, elsewhere, elsewhere_partial, elsewhere_available, elsewhere_stale }
```

---

## 🧬 Using This Repo as a Template for a New Project

```bash
# Step 1 — Clone and detach from template origin
git clone https://github.com/thiagoriosbraz/rb-ai-team.git my-new-project
cd my-new-project
rm -rf .git
git init
git remote add origin https://github.com/<your-org>/my-new-project.git

# Step 2 — Install and configure hooks
# (cd in: npm's --prefix sets the install target only, never where the
#  manifest is read from)
( cd aiteam && npm install )
git config core.hooksPath aiteam/githooks
chmod +x aiteam/githooks/*
# Remove the "AITEAM_UPSTREAM" line from the "env" of .claude/settings.json: it exists
# only for the rb-ai-team repo, where it switches OFF the ask on edits of the gate's own
# code (aiteam/hooks, aiteam/src, aiteam/templates/tier-rules.json), and your project
# must keep that ask on (the doctor warns while the variable is set outside rb-ai-team).
node -e "const fs=require('fs'),f='.claude/settings.json',s=JSON.parse(fs.readFileSync(f,'utf8'));if(s.env){delete s.env.AITEAM_UPSTREAM;if(!Object.keys(s.env).length)delete s.env}fs.writeFileSync(f,JSON.stringify(s,null,2)+'\n')"

# Step 3 — Environment: nothing in aiteam/ loads a .env; export the variables
# in your shell (aiteam/.env.example lists them)
export ANTHROPIC_API_KEY=<your-key>

# Step 4 — Fill in SPEC.md (critical — agents won't code without it)
# Edit SPEC.md: project name, last_updated, Overview, Architecture — and the
# ci: block: your app's PR commands, with workdir pointing at your app, not at
# aiteam/. Swap .github/workflows/ci.yml for aiteam/templates/ci.yml.example:
# the inherited one tests only the framework (AGENTS.md §CI/CD Mandate item 1).
# Then the deploy: block, whose inherited value says the framework has none:
# workflow: deploy.yml + version_url (copy aiteam/templates/deploy.yml.example
# to .github/workflows/deploy.yml), or workflow: none + your own reason.
# The contract tests and the doctor fail until ci: and deploy: match your workflows.

# Step 5 — Reset Beads state: drop the framework's own beads, keep
# .beads/SCHEMA.md and .beads/.gitignore. The hooks generate the views again
# once .beads/tasks/ holds a bead; with none there is nothing to generate.
rm -r .beads/tasks .beads/BACKLOG.md

# Step 6 — First commit
git add .
git commit -m "feat: bootstrap from rb-ai-team template"
git push -u origin main
```

> **What you keep:** `aiteam/agents/`, `aiteam/skills/`, `aiteam/mcp/tools/`, git hooks, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`
>
> **What you customize:** `SPEC.md`, your environment variables, and your `src/` application code.

---

<a name="português"></a>
# 🇧🇷 Português

## O que é isso?

**RB AI Team** é mais que um boilerplate: é um **framework multi-agente opinativo** dentro de um repositório. Movido por Claude e Gemini, coordena personas especializadas que planejam, arquitetam, constroem e testam software — seguindo tiers de permissão rigorosos, TDD e padrões de segurança OWASP. O objetivo é um time de agentes ao qual você aponta uma ideia; hoje é um template bem estruturado e com aplicação mecânica de regras, em validação ativa.

> **Status:** em validação ativa. O framework está montado e testado, mas o fluxo "autônomo, da ideia à produção" ainda está em dogfooding — veja o [backlog](https://github.com/thiagoriosbraz/rb-ai-team/blob/main/.beads/BACKLOG.md).

> Descreva sua ideia. Os agentes ajudam a levá-la do escopo a uma implementação testada.

---

## 🧠 O Time

| Persona | Função | Ativa quando |
|---|---|---|
| 🎯 **Lead Orchestrator** | Planeja, decompõe tarefas, aplica regras | Sempre — o papel padrão |
| 📋 **Product Manager** | Roda o Discovery Mode, escreve o `SPEC.md` | Trabalho de produto sem escopo no `SPEC.md`, ou ideia sem escopo |
| 🎨 **Frontend Expert** | React/Next.js, Tailwind, componentes com TDD | Trabalho de UI/UX |
| ⚙️ **Backend Architect** | Prisma, Supabase, APIs seguras, Zod | APIs, schemas de BD, lógica de negócio |
| 🏗️ **System Design Architect** | Docker, VPS, CI/CD, topologia cloud | Infraestrutura e deploy |
| 🚀 **Release Engineer** | Executa o release: pré-condições, o ASK one-shot, o workflow de deploy, health check da versão, rollback pela tag `deploy/` | Deploy em produção |
| 🔍 **QA & Security Reviewer** | Auditorias, verificações OWASP, cobertura de testes | Antes de qualquer merge |
| 🐛 **Deep Debugger** | Análise de causa raiz, inspeção de traces | Bugs e incidentes em produção |
| 📊 **Data & AI Engineer** | Pipelines de dados, Vector DBs, RAG | Alto volume de dados e IA |
| 🛡️ **SRE / FinOps** | Observabilidade, FinOps, SLAs | Redução de custos e disponibilidade |
| 🖌️ **UX/UI Designer** | Jornadas de usuário, acessibilidade (WCAG) | Antes da implementação frontend |

---

## 🏭 O Fluxo da Fábrica de Software

```
💡 Ideia
  └─► 📋 Product Manager   →  SPEC.md (MVP definido)
        └─► 🏗️  Architect    →  docker-compose.yml + topologia
              └─► ⚙️  Backend  →  API + schemas de BD
                    └─► 🎨 Frontend →  componentes de UI
                          └─► 🔍 QA/Sec →  auditorias + testes
                                └─► 🚀 Em produção
```

---

## 🔐 Tiers de Permissão

A tabela de tiers de permissão é mantida em um único local canônico —
**[`AGENTS.md` → Permission Tiers](./AGENTS.md#permission-tiers)** — para evitar
divergência. O Tier 3 (produção/destrutivo) é aplicado mecanicamente pelo hook
`PreToolUse` `aiteam/hooks/tier-guard.mjs` (padrões em
`.claude/tier-rules.json`), mais as regras `deny` em `.claude/settings.json` —
não apenas documentado aqui. Se esse arquivo falta ou não lê, o hook protege com
a cópia canônica do framework (`aiteam/templates/tier-rules.json`) e avisa no
motivo; ele não libera tudo. O hook classifica todo comando rodado por Bash,
PowerShell, Monitor e a ferramenta de terminal do app desktop: deploy de
produção recebe um ASK one-shot, comando destrutivo um deny que cita o
sub-comando e, numa classe com orientação própria (`tier3.deny_hints`, como
controle de host por SSH), a explica — nas demais, traz a instrução do
break-glass. Texto passado como mensagem (`git commit -m`,
`gh issue|pr --body`/`--title`) é dado, não comando; um `$(…)` dentro dele
continua contando. A única liberação é `allow_tier3: true` como filho direto de
`tier_defaults:` no `SPEC.md`, lido igual em LF e CRLF. Ela é GLOBAL: libera
também o ASK de deploy, então volte para `false` logo depois do uso emergencial.

---

## 🧠 Arquitetura de Memória Baseada em Git

Em vez de contexto volátil de chat, o estado é persistido no Git:

| Arquivo | Propósito |
|---|---|
| `AGENTS.md` | Lei suprema — Tiers de permissão, mandatos TDD, regras globais |
| `SPEC.md` | Fonte única da verdade — escopo, arquitetura, decisões em aberto; o frontmatter alimenta os gates (`budget_usd`, `tier_defaults`, `ci:`, `deploy:`, `infra_kb`) |
| `.beads/tasks/<id>/<branch>.yaml` | Os beads — um arquivo por tarefa e por branch, só acrescentado no fim (contrato: `aiteam/docs/beads-schema.md`). `.beads/active.yaml` e `.beads/index.yaml` são visões geradas deles, fora do git. Escreva com `node aiteam/scripts/beads.mjs` (`npm --prefix aiteam run beads -- status`); ele mostra também os beads de outras branches, marcados como não mergeados |
| `CLAUDE.md` | Protocolo de boot específico para Claude |
| `GEMINI.md` | Protocolo de boot específico para Gemini |

---

## 🎯 Skills de AI

Os agentes carregam skills de domínio de `aiteam/skills/`:

| Skill | Usada por |
|---|---|
| `ui-ux-pro-max` | Frontend Expert |
| `agile-product-owner` | Product Manager |
| `security-privacy-child-safety` | Backend Architect |
| `qa-testing-automation` | QA & Security Reviewer |
| `ai-rag-prompt-engineer` | Orchestrator |
| `dba-prisma-supabase-optimizer` | Backend Architect |
| `tech-writer-docgen` | Qualquer persona |
| `trello-review` | Orchestrator — comando de barra: o procedimento vem em `skills/trello-review/PROCEDURE.md`, cada projeto guarda um `.claude/skills/trello-review/SKILL.md` fino ([docs/trello-review-adoption.md](docs/trello-review-adoption.md)); o MCP do Trello que ela usa vem em `mcp/trello-server.ts` ([docs/trello-mcp.md](docs/trello-mcp.md)) |

O framework não exige o plugin [superpowers](https://github.com/obra/superpowers), mas foi **validado com o superpowers 6.4.1** (a versão que o marketplace oficial do Claude Code serve; a 6.4.2 só muda o `writing-plans`): as regras dele para o que os skills do plugin deixam para trás — `.superpowers/` como rascunho e nunca estado, a revisão final dos skills ao lado do QA & Security Reviewer, o portão local de testes — são escritas contra o comportamento dessa versão. O `node aiteam/scripts/doctor.mjs` informa a versão instalada e se o plugin está ligado: INFO, ou WARN no Windows abaixo da 6.2.0 quando o plugin está ligado ou sem estado declarado (o hook SessionStart dele falhava sem aviso ali; desligado, fica em INFO).

---

## 🚀 Como Começar

### Configuração Inicial (~2 minutos)

```bash
# 1. Use este template (ou clone)
git clone https://github.com/thiagoriosbraz/rb-ai-team.git meu-novo-projeto
cd meu-novo-projeto

# 2. Instale as dependências (fazer cd é mais seguro em alguns terminais)
cd aiteam
npm install
cd ..

# 3. Ative os hooks de memória git (CRÍTICO)
git config core.hooksPath aiteam/githooks
chmod +x aiteam/githooks/*  # (Apenas Mac/Linux/Git Bash. Se usar PowerShell, ignore o erro)

# 4. Configure sua chave de API. Nada em aiteam/ carrega um arquivo .env: o SDK
#    da Anthropic lê ANTHROPIC_API_KEY do ambiente, então exporte-a no seu shell
#    (o aiteam/.env.example documenta as opcionais, como AI_SESSION_BUDGET_USD)
export ANTHROPIC_API_KEY=<sua-chave>   # PowerShell: $env:ANTHROPIC_API_KEY = "<sua-chave>"

# 5. Bootstrap do estado. O clone traz o SPEC.md e os beads do próprio framework:
#    num projeto novo, preencha o SPEC.md e reinicie o .beads/tasks/ como em
#    "Usando Este Repositório como Template" (passos 4–5). bootstrap-beads e
#    generate-spec são para adotar num repo existente (próxima seção); os dois
#    se recusam a sobrescrever.
npm --prefix aiteam run sync:agents         # gera .claude/agents/ a partir das personas canônicas

# 5b. No Windows, o .gitattributes clonado já fixa estas linhas em LF. Um repo
#     que trouxe só o aiteam/ as acrescenta ANTES do sync:agents, senão o drift
#     check acusa bindings corretos (checkout CRLF vs geração em LF):
#       aiteam/agents/*.md  text eol=lf
#       .claude/agents/*.md text eol=lf
#       SPEC.md             text eol=lf
#     (a linha do SPEC.md é defesa em profundidade: os leitores do frontmatter aceitam CRLF)

# 6. (Opcional) Inicie a observabilidade
docker compose -f aiteam/docker-compose.yml --profile observability up -d   # Langfuse em :3001
```

### Adotando em um Projeto Existente (Legado)

Se você está implementando o `rb-ai-team` em um projeto já em andamento, o framework foi projetado para **não interferir** nas suas regras atuais de CI, formatação ou lint. Veja o guia completo em **[docs/legacy-onboarding.md](docs/legacy-onboarding.md)**.
1. **Traga o framework:** Copie a pasta `aiteam/` para o seu repositório e instale as dependências executando `cd aiteam && npm install`. O mapa de tiers `.claude/tier-rules.json` fica fora de `aiteam/`, então não vem nessa cópia: o `install.mjs` do passo 3 o cria a partir de `aiteam/templates/tier-rules.json` quando ele falta (e nunca sobrescreve o seu), e enquanto ele não existe o tier-guard protege com essa cópia canônica em vez de liberar tudo. **Não** use a flag `--prefix` do npm aqui: ela define só o *destino* da instalação — o manifesto continua sendo lido do diretório atual, então você instala o `package.json` errado (ou nenhum).
2. **Gere a Especificação:** Rode `npm --prefix aiteam run generate-spec` (o npm roda o script dentro de `aiteam/`, mas ele grava na raiz do seu repo por padrão; `-- ..`, ou outro diretório depois do `--`, continua valendo como alvo explícito; ele faz uma chamada ao Claude, então exporte antes a `ANTHROPIC_API_KEY` no seu shell — nada em `aiteam/` lê um `.env`). Revise o rascunho de `SPEC.md` gerado pela IA e confira os dois blocos do frontmatter que o script escreve por código, não pelo modelo. O `ci:` vem dos scripts do seu `package.json` (`test`, `typecheck`, `lint`), rodados pelo gerenciador que o seu repo usa (campo `packageManager` ou lockfile: `pnpm run`, `yarn run`, `bun run`; `npm run` nos demais) e `workdir: .`: corrija os comandos ou o `workdir` se a app morar em outro diretório e, sem script `test`, declare o comando ou o opt-out `test: none` + `reason`. Um script `test:changed`, `test:affected`, `test:related` ou `test:local` vira também `local_test:`, o portão local opcional que os agentes rodam enquanto trabalham, no lugar do `test` (o CI segue rodando o `test` completo). O `deploy:` é um placeholder (`workflow: deploy.yml`, `version_url` vazio): copie `aiteam/templates/deploy.yml.example` para `.github/workflows/deploy.yml` e preencha o `version_url`, ou troque pelo opt-out `workflow: none` + `reason` se não há deploy de produção (formato: `AGENTS.md` §CI/CD Mandate). Os contract tests e o doctor reprovam o `deploy:` do rascunho até ele ser preenchido, de propósito: o rascunho nunca faz o opt-out por você. Faça o commit.
3. **Inicie a Memória e Conecte os Hooks:** Rode `npm --prefix aiteam run bootstrap-beads` (o alvo padrão é a raiz do seu repo; `-- <diretório>` escolhe outro) para mapear o histórico do git em beads sob `.beads/tasks/`. Depois, rode `node aiteam/install.mjs` para mesclar as configurações e atrelar os git hooks de forma segura (sem sobrescrever os seus hooks atuais). Um repo que já usa os beads antigos do framework, de arquivo único, migra em vez disso (passo 7).
4. **Gere os subagentes nativos:** Rode `npm --prefix aiteam run sync:agents` para renderizar `.claude/agents/` a partir das personas canônicas. Agentes seus nunca são sobrescritos — um com o mesmo nome é reportado e preservado. No Windows, acrescente antes ao `.gitattributes` as linhas `eol=lf` do passo 5b do início rápido acima.
5. **Verificação de Saúde (Health Check):** Rode `node aiteam/scripts/doctor.mjs` para confirmar que a fiação não quebrou o seu ambiente. Espere `PASS` em todos os itens; um `FAIL` diz o que falta (sem o `.claude/tier-rules.json`, ou com um que não lê, o tier-guard cai na cópia canônica e o doctor reprova essa checagem até o `node aiteam/install.mjs` criar o arquivo ou você corrigi-lo), e um `WARN` não é falha: um opt-out declarado, como `workflow: none`, um `.claude/tier-rules.json` sem padrões Tier 3 que a cópia canônica tem (o aviso lista quais), ou com um padrão de backtracking catastrófico (o timeout de um hook falha aberto, então um comando montado para estourar o tempo do guard rodaria sem o gate; o aviso nomeia o padrão, sonda num processo filho para nunca pendurar o doctor e, para o padrão antigo do script por `ssh`, traz o substituto para colar). Também dá `WARN` quando um arquivo de raiz que o framework distribui ficou atrás do que o upstream tem — o seu `.beads/SCHEMA.md` ainda é uma cópia do contrato em vez do apontador (só depois de migrar do modo legado: lá a cópia local é o contrato em vigor), um shim sem a linha `@aiteam/…`, o `.gitattributes` sem as regras `eol=lf`, nenhum workflow de `pull_request` roda um passo do job `framework` do modelo —, comparando com a ref do `upstream` que o seu clone já tem (só leitura: ele nunca roda fetch, então rode `git fetch upstream` antes; veja [docs/consuming-as-upstream.md](docs/consuming-as-upstream.md)).
6. **Teste Prático (Dogfooding):** Escolha uma tarefa pequena (ex: um bugfix) e passe-a pelo fluxo dos agentes para se acostumar antes de escalar o uso.
7. **Mantenha atualizado:** Traga as atualizações do framework como em **[docs/consuming-as-upstream.md](docs/consuming-as-upstream.md)** e rode de novo `node aiteam/install.mjs`: ele acrescenta ao `.claude/settings.json` as entradas novas de hook (o doctor falha nomeando a ferramenta de comando que o tier-guard ainda não cobre), o `worktree.baseRef: "head"` e o `.claude/worktrees/`, o `.trello-cache/` e o `.superpowers/` no `.gitignore`. O `.claude/tier-rules.json` é seu: o install só o cria quando ele falta, então mescle os padrões novos à mão (`git diff --no-index aiteam/templates/tier-rules.json .claude/tier-rules.json` mostra o que a cópia canônica tem e o seu não; o doctor avisa com a mesma lista). O checkout escopado leva só `aiteam/`: os demais arquivos de raiz (`.beads/SCHEMA.md`, os shims `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`, `.gitattributes`, os seus workflows de CI) são seus, e a tabela daquele guia diz como cada um chega. Grave o sync com `node aiteam/scripts/upstream-marker.mjs write` (o PR do aiteam-sync já o faz) para o próximo pull medir o que mudou nos arquivos de raiz desde o seu último sync, e não desde o release anterior. Um repo ainda nos beads antigos, de arquivo único (`git ls-files .beads/active.yaml` lista o arquivo), roda em modo legado até migrar: os hooks param de zerar e espelhar o backlog, avisam que é hora de migrar e recusam o modelo novo antes disso — o `pre-commit` recusa `.beads/tasks/` e `.beads/project/`, e o `beads-guard` nega o Write ali. Migre com `node aiteam/scripts/migrate-beads.mjs --dry-run`, depois sem o `--dry-run` (`--recover-mirrors` traz os beads que só existem no espelho de uma branch), e commit. Depois, `--scan-history` recupera os beads que o modelo antigo perdeu, e `--port`/`--port-from` portam uma branch aberta antes da migração ([docs/beads-schema.md](docs/beads-schema.md) §11).

### Fluxo Diário

1. **Agentes:** Leem `CLAUDE.md` ou `GEMINI.md` e adotam a persona de Orchestrator imediatamente.
2. **Humanos:** Descreva sua ideia. Se o `SPEC.md` estiver vazio, o Product Manager vai te entrevistar primeiro.
3. **Controle de custo:** `aiteam/src/circuit-breaker.ts` envolve as chamadas AI não-streaming. Quando `budget_usd` no `SPEC.md` é atingido, a *próxima* chamada lança erro; e um guarda preditivo recusa qualquer chamada cujo pior caso estouraria o orçamento. Chamadas com streaming não são medidas (você é avisado uma vez). O custo da sessão fica só no disco local (`.beads/session.local.json`), nunca no git.
4. **Memória independente de branch:** cada branch escreve só os seus arquivos de bead, então o merge nunca conflita no `.beads/` e backlog nenhum se perde; checkout, merge, commit e rebase regeneram as visões.
5. **Orquestração de Modelos (Manual):** Sendo você o orquestrador na sua IDE, alterne os modelos manualmente conforme a fase da tarefa. Para tomadas de decisão, *discovery* e raciocínio lógico complexo, use o tier mais alto da geração atual (o Claude Opus ou Fable mais recente, ou o tier Pro do Gemini). Para o desenvolvimento de tarefas já bem definidas na especificação, use o tier rápido da geração atual (o Claude Sonnet mais recente, ou o tier Flash do Gemini) para codar com agilidade e menor custo. As personas pinam os aliases `sonnet`/`opus` no frontmatter, então os subagentes nativos acompanham a geração atual sem edição.
6. **Despacho isolado (Claude Code):** subagente que edita arquivos é despachado com `isolation: "worktree"`, então trabalha na própria branch e worktree, nunca no seu checkout; os que só leem (revisão, exploração) não precisam. A worktree parte do seu `HEAD` local (`worktree.baseRef: "head"`), sob o `.claude/worktrees/` ignorado pelo git. Ela nasce sem `aiteam/node_modules`: o subagente roda primeiro `node aiteam/scripts/worktree-link.mjs link` (liga o do checkout principal — nunca rode `npm install` ali) e `unlink` antes de reportar. Remova uma worktree com `node aiteam/scripts/worktree-link.mjs remove <caminho>`: no Windows, o `git worktree remove` cru segue o link e esvazia o `node_modules` do checkout principal.

---

## 📊 Bead Board — Painel Visual de Observabilidade

Painel autônomo em tempo real que transforma o `.beads/active.yaml` gerado em uma visão 2.5D animada do seu time de AI em ação. Totalmente isolado em `aiteam/tools/bead_board/` — portátil e plug-and-play em qualquer repositório `rb-ai-team`.

**O que entrega**
- Sala animada com agentes em estados ocioso/trabalhando, uma mesa por persona, roteada por palavra-chave no id do bead (convenção: prefixo — `aiteam/docs/beads-schema.md` §5).
- Popovers de histórico por agente e Kanban completo (`pending` / `in_progress` / `completed`).
- Taxa de queima de orçamento da sessão, do custo local (`.beads/session.local.json`, via a visão).
- Dois temas: 🎮 **Retro Gamer** (isométrico 8-bit) e 👔 **Silicon Valley** (SaaS premium com glassmorphism).
- Somente leitura por design — o estado muda via CLI/agentes; o painel apenas observa. Ele regenera as visões antes, quando um arquivo de bead é mais novo que elas.

**Como iniciar**
```bash
# A partir da raiz do repo — sem dependências além de Python 3.x
python aiteam/tools/bead_board/server.py
# Abra http://localhost:8080/
#  • /         → sala 2.5D dos agentes (room.html)
#  • /kanban   → quadro Kanban detalhado (index.html)
#  • /panorama → fases do projeto e caminho crítico (panorama.html)
#  • /api/state → JSON { worktrees, yaml, index, branch, elsewhere, elsewhere_partial, elsewhere_available, elsewhere_stale }
```

---

## 🧬 Usando Este Repositório como Template para um Novo Projeto

```bash
# Passo 1 — Clone e desconecte do origin do template
git clone https://github.com/thiagoriosbraz/rb-ai-team.git meu-novo-projeto
cd meu-novo-projeto
rm -rf .git
git init
git remote add origin https://github.com/<sua-org>/meu-novo-projeto.git

# Passo 2 — Instale e configure os hooks
# (entre no diretório: a flag --prefix do npm define só o destino da
#  instalação, nunca de onde o manifesto é lido)
( cd aiteam && npm install )
git config core.hooksPath aiteam/githooks
chmod +x aiteam/githooks/*
# Tire a linha "AITEAM_UPSTREAM" do "env" do .claude/settings.json: ela existe só para o
# repo rb-ai-team, onde DESLIGA o ask nas edições do código do próprio gate (aiteam/hooks,
# aiteam/src, aiteam/templates/tier-rules.json), e o seu projeto precisa manter esse ask
# ligado (o doctor avisa enquanto a variável estiver posta fora do rb-ai-team).
node -e "const fs=require('fs'),f='.claude/settings.json',s=JSON.parse(fs.readFileSync(f,'utf8'));if(s.env){delete s.env.AITEAM_UPSTREAM;if(!Object.keys(s.env).length)delete s.env}fs.writeFileSync(f,JSON.stringify(s,null,2)+'\n')"

# Passo 3 — Ambiente: nada em aiteam/ carrega um .env; exporte as variáveis
# no seu shell (o aiteam/.env.example as lista)
export ANTHROPIC_API_KEY=<sua-chave>

# Passo 4 — Preencha o SPEC.md (crítico — os agentes não codificam sem ele)
# Edite SPEC.md: nome do projeto, last_updated, Overview, Arquitetura — e o
# bloco ci: com os comandos de PR da sua app, com o workdir na app, não no
# aiteam/. Troque o .github/workflows/ci.yml pelo aiteam/templates/ci.yml.example:
# o herdado testa só o framework (AGENTS.md §CI/CD Mandate, item 1).
# Depois o bloco deploy:, cujo valor herdado diz que o framework não tem deploy:
# workflow: deploy.yml + version_url (copie aiteam/templates/deploy.yml.example
# para .github/workflows/deploy.yml), ou workflow: none + o seu próprio reason.
# Os contract tests e o doctor falham até o ci: e o deploy: baterem com os seus workflows.

# Passo 5 — Reinicie o estado do Beads: apague os beads do próprio framework,
# mantenha .beads/SCHEMA.md e .beads/.gitignore. Os hooks voltam a gerar as
# visões quando o .beads/tasks/ tiver um bead; sem nenhum, não há o que gerar.
rm -r .beads/tasks .beads/BACKLOG.md

# Passo 6 — Primeiro commit
git add .
git commit -m "feat: bootstrap from rb-ai-team template"
git push -u origin main
```

> **O que você mantém:** `aiteam/agents/`, `aiteam/skills/`, `aiteam/mcp/tools/`, git hooks, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`
>
> **O que você personaliza:** `SPEC.md`, as suas variáveis de ambiente, e o diretório `src/` com o código da sua aplicação.

---

<div align="center">

## Credits · Créditos

**Specification & Architecture · Especificação & Arquitetura**

**Braz, Thiago R.**

*Developed with the support of · Desenvolvido com o suporte de*

[![Claude](https://img.shields.io/badge/Claude-Anthropic-8A2BE2?style=for-the-badge&logo=anthropic)](https://claude.ai) &nbsp;
[![Gemini](https://img.shields.io/badge/Gemini-Google-4285F4?style=for-the-badge&logo=google)](https://gemini.google.com)

</div>
