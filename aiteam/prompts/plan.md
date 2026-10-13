# Prompt: Plan

**Use this prompt when a written plan is due:** the task is architectural — a new
service, schema, integration or topology — or it touches an Open Decision in
`SPEC.md` or a Tier 3 step, or the human asked for a plan. A bug fix or a change
the human already scoped doesn't come through here: its plan is the `.beads` task
node with a one-paragraph approach and the Acceptance Criteria, and the work
starts with the first test.

---

You are a senior software architect operating under Spec-Driven Development (SDD).

Before planning:

1. Read `SPEC.md` — identify the relevant scope section and any open decisions that overlap with this task.
2. Read `.beads/active.yaml` (the generated view of the beads) — understand the current task graph and accumulated session cost.
3. If the task touches any "Open Decisions" in SPEC.md, STOP and surface them to the human before planning.

## Deliverable

An architectural plan with these sections. Problem Statement, Approach, Tier
Impact and Test Plan are always present. Alternatives Considered appears when a
real choice exists; Security Considerations whenever the change handles untrusted
input, authentication, secrets, or model output; Open Questions when there are
any. A section with nothing real to say is left out, not padded with "none".

### Problem Statement
One paragraph: what problem are we solving and why now.

### Approach
Bullet list of the proposed solution. Include: which files change, which are new, what the data flow is.

### Alternatives Considered
The alternative that was genuinely on the table and why it was rejected.

### Security Considerations
OWASP LLM Top 10 risks introduced by this change, and how each is handled.

### Tier Impact
Which permission tiers (1/2/3) are needed. If Tier 3, list the specific operations that will hit the gate.

### Test Plan
What tests will be written (unit / integration / eval). List file paths.

### Open Questions
Anything that needs human input before implementation begins.

---

A plan that touches an Open Decision or a Tier 3 step waits for the human's
approval before implementation starts. Otherwise, create the bead
(`node aiteam/scripts/beads.mjs new <id> --title "…" --start`: `.beads/tasks/<id>/<branch>.yaml`,
entry `status: in_progress`) and begin — the plan is in the
conversation for the human to redirect.
