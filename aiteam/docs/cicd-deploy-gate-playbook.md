# CI/CD Deploy-Gate Playbook

> Companion to `AGENTS.md` §CI/CD Mandate and `templates/deploy.yml.example`.
> There is no gate left to install in the workflow file. This playbook
> explains, for any project consuming this framework, why the two
> workflow-level modes it used to teach are both gone (§1), how to verify
> your project's real gate — the tier-guard's one-shot ASK — is actually
> wired up (§2), and how to scope down the SSH key the deploy fallback
> depends on (§3). First run: omni-chat, 2026-07-17.

## 0. Symptom this fixes

Your deploy workflow runs, but nothing stops it for a human to approve — or
you're not sure whether it's gated at all. As of 2026-07-30 there is exactly
one gate, and it does not live in `deploy.yml`: it's the tier-guard's
one-shot ASK (`aiteam/hooks/tier-guard.mjs` + `.claude/tier-rules.json`).
There is no job to uncomment, no environment protection rule to configure,
nothing to wire up in the workflow file itself — if your project's deploy
trigger command matches `ask_patterns`, the prompt fires on its own the
moment an agent runs it. The gate is enforced by the hook, not by anything
you add to CI.

This playbook used to frame the fix as choosing between two workflow-level
modes. Both are gone. §1 explains why, with the numbers that closed the door
on each. §2 explains what the real gate is today, how to verify yours is
actually wired up, and what that setup costs you.

## 1. Neither mode is used — why, with the numbers

Earlier versions of this playbook opened with "detect which mode you can
use." That question no longer has a useful answer: **neither mode is used by
this framework, period.** This isn't a per-project decision to make — it's
settled, framework-wide — and this section is about verifying that, not
choosing between them.

- **Mode A (GitHub Environments, "Required reviewers")** is Enterprise-only
  on a private repository. It was never available on the Free, Pro, or Team
  plans — this is not a limitation that upgrading to Pro would lift.
- **Mode B (issue-approval via `trstringer/manual-approval`)** was available,
  was installed, and is what took the pipeline down. It does not queue for
  free while it waits: the job runs on a GitHub-hosted runner (`in_progress`,
  not `queued`) and polls an issue, so every minute of human latency is a
  billed runner-minute. That is why it was **removed** from
  `templates/deploy.yml.example` entirely — not throttled, not made
  optional, not reconfigured. The correction below records the measured cost
  and the false claim this playbook used to make about it.

> ⚠️ **CORREÇÃO (2026-07-30) — este playbook afirmava o oposto e estava errado.**
> A versão anterior dizia que o run ficava *queued*, "consumindo zero minutos
> faturáveis enquanto espera". **Não é o que acontece.** O job roda num runner
> (`in_progress`, não `queued`) e faz polling — **todo minuto de espera humana é
> um minuto faturado de máquina**.
>
> Medição de julho/2026 na conta `thiagoriosbraz`: **973 min** consumidos por
> esses jobs de aprovação (49% da cota mensal do plano Free), contra **707
> min** dos jobs de deploy que eles guardavam (omni-chat 472 + trabalhista
> 235) — o gate custou **~1,4× mais que o trabalho**, não os 6,6× que uma
> versão anterior deste playbook chegou a afirmar (detalhe do erro de medição
> em `docs/superpowers/specs/2026-07-30-ci-actions-minutes-design.md` §2.1).
> Um run chegou aos 360 min do teto de 6h porque ninguém aprovou. A cota estourou
> em 2026-07-29 e derrubou a pipeline inteira, deploy de produção incluído.
>
> Por isso o Modo B foi **removido** do `deploy.yml.example`. O gate humano agora
> é o ASK do tier-guard no IDE — ver `AGENTS.md` §CI/CD Mandate item 3 e
> `docs/superpowers/specs/2026-07-30-ci-actions-minutes-design.md`.

The API probe below still has a use: confirming Mode A is genuinely
unavailable to *your* repo, on record, rather than taking this doc's word for
it. It is **historical verification, not a decision point** — keep that
distinction even if you run it:

```bash
USER_ID=$(gh api user --jq '.id')
gh api -X PUT repos/<owner>/<repo>/environments/production \
  -f "reviewers[][type]=User" -F "reviewers[][id]=$USER_ID"
```

**Neither outcome changes anything — neither reopens Mode B, and 200/201
does not mean you should wire up Mode A either:**

- **200/201** means your plan happens to support required reviewers. This
  framework's gate is still the ASK (§2), regardless of what your plan
  allows — wiring up a second, redundant approval layer is not the mandate.
- **422 "Please ensure the billing plan supports the required reviewers
  protection rule."** confirms the expected. It is **not** a cue to fall
  back to Mode B — Mode B was not removed because Mode A is unavailable; it
  was removed because it cost ~1.4× what it guarded (973 min against 707) and
  took production down with it (above). A 422 here changes nothing about what
  you do next.

(`gh repo view <owner>/<repo> --json isPrivate` confirms the repo is private,
if you want to see *why* the 422 happens before you see it.)

## 2. The real gate — the ASK, what to verify, and its price

There is no installation step. The gate already exists in every project that
consumes this framework: `aiteam/hooks/tier-guard.mjs` is a `PreToolUse`
hook that classifies every Bash command an agent runs. When a command
matches one of the `tier3.ask_patterns` regexes in `.claude/tier-rules.json`
— out of the box, `gh workflow run …deploy` — the hook returns
`permissionDecision: "ask"` and the IDE surfaces its native approval prompt.
The human approves *that specific command*, naming *that specific* `ref`, in
that turn; nothing is pre-approved, and nothing carries over to the next
run. By this framework's own taxonomy this is **layer 2**: the agent
presents the prompt, it does not — and must never try to — answer it itself
(`AGENTS.md` §CI/CD Mandate item 3).

**What to verify, mechanically, for your project:**

1. Open `.claude/tier-rules.json` and read `tier3.ask_patterns`.
2. Confirm the exact command your pipeline uses to trigger a production
   deploy matches one of those patterns. `gh workflow run <name>deploy…`
   matches out of the box; the SSH-fallback patterns from mandate item 2
   (docker/systemctl/service/kubectl over SSH, or the project's own deploy
   script by interpreter, path, or npm/make target) are also pre-listed.
3. If your trigger matches nothing — a different CLI, a custom npm script, a
   provider this framework didn't anticipate — **add your own pattern to
   `ask_patterns`.** This is not optional hardening: a command that isn't
   listed is **not** denied by default. It classifies as **Tier 1 and runs
   with no prompt at all** — the exact hole a raw-SSH deploy slipped through
   before it was closed (`AGENTS.md` §CI/CD Mandate carries this warning
   twice, in items 2 and 3, on purpose).

**The price of this choice, stated plainly:** since 2026-07-30 this ASK is
the *only* gate, on both the pipeline path and the SSH fallback. There is no
longer a barrier a confused or compromised agent cannot cross alone, because
the agent is what surfaces the ASK in the first place. The residual risk is
bounded by **scope** — a private repo, a single human who can trigger a
deploy — not by architecture. That trade was accepted for that scope; it is
not a permanent verdict. **Reassess when adding collaborators, going public,
or onboarding a project where more than one person can trigger a deploy**
(`AGENTS.md` §CI/CD Mandate item 3) — and at that point, the non-adopted
zero-idle-cost alternative already on record (`deploy-request.yml` +
`deploy.yml` on `issue_comment`, same item 3) is the first thing to revisit.
Not Mode B: it is gone for the cost reasons in §1, not for lack of a
cheaper-still alternative.

## 3. The deploy SSH key needs to be scoped down, not just secret

The workflow needs a private key in `secrets.VPS_SSH_KEY` to SSH into the
target host. That host is very likely **shared** — other projects' containers
running on the same box (see `vps-infra` README §9 for this host's specific
sharing model) — so a leaked secret with unrestricted access is a
whole-host compromise, not a single-app one.

Generate a **dedicated** keypair per project (never reuse one project's key
for another's workflow) and restrict what it can do at the SSH layer, not
just at the GitHub-secrets layer:

```bash
ssh-keygen -t ed25519 -f ./deploy_key -N "" -C "github-actions-<project>-deploy"
```

Append to the target host's `~/.ssh/authorized_keys` (do **not** replace the
file — append):

```
command="cd /opt/<project> && bash scripts/deploy.sh",no-pty,no-port-forwarding,no-X11-forwarding,no-agent-forwarding ssh-ed25519 AAAA... github-actions-<project>-deploy
```

The `command=` forced-command means this key can **only** ever run that one
command, regardless of what the SSH client requests — even `ssh -i key host
"rm -rf /"` executes the forced command instead. If `VPS_SSH_KEY` ever leaks
(compromised workflow, malicious PR modifying `.github/workflows/*`, a repo
collaborator going rogue), the blast radius is "can re-run this one deploy
script," not "has an interactive root shell on a shared host."

Then set the three secrets (never paste key material into a shell command
that lands in history — pipe from a file or variable):

```bash
gh secret set VPS_SSH_KEY -R <owner>/<repo> < ./deploy_key
printf '<host>' | gh secret set VPS_HOST -R <owner>/<repo>
printf '<user>' | gh secret set VPS_USER -R <owner>/<repo>
rm ./deploy_key ./deploy_key.pub   # don't leave the private key on disk after upload
```

## 4. Close the loop

- Fill the project's `SPEC.md` §CI/CD checklist (all 6 mandate items,
  including honestly marking any unimplemented ones — e.g. item 5
  preview/staging is commonly not done yet; say so, don't silently drop it).
- Log the change in a bead (`.beads/tasks/<id>/<branch>.yaml` — an `sre-*` id
  fits the desk routing).
- If the target VPS is documented in a cross-project `vps-infra`-style repo,
  add the new inbound CI key to its Lessons Learned / Rules section — it's a
  new host-level access credential, which is exactly the kind of fact that
  repo exists to track.
