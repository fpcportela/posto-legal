import { z } from "zod";
import * as yaml from "js-yaml";
import { findDanglingBlockers } from "../tools/bead_board/blocker-refs.mjs";
import { TRELLO_CARD_ID, TRELLO_SCOPES, TRELLO_SHORTLINK } from "./beads-core.mjs";

// Contract of the generated view .beads/active.yaml — aiteam/docs/beads-schema.md §7.1.
// The view is rendered by aiteam/src/beads-core.mjs (the tests validate every
// render against this schema) and the Bead Board renders directly from it.

export const TASK_STATUSES = ["pending", "in_progress", "completed", "blocked"] as const;

// Minimum recommended implementation model per task (see AGENTS.md § Model Tiering).
// A more capable model is always allowed; a less capable one is not.
export const IMPL_MODELS = ["sonnet", "opus", "haiku"] as const;

export const ROUTING_KEYWORDS = [
  // frontend desk
  "ui", "web", "design", "creative", "content", "landing", "panel", "social", "blog",
  // backend desk
  "api", "infra", "database", "scaffold",
  // data & ai desk
  "data", "etl", "rag", "vector",
  // sre / finops desk
  "sre", "finops", "observability", "sla", "cloud",
  // ux/ui designer desk
  "ux", "a11y", "journey", "wcag", "cro",
  // product manager desk
  "spec", "plan", "brainstorm", "research", "funnel",
  // system design architect desk
  "devops", "docker", "terraform", "topology", "vps",
  // release engineer desk
  "deploy", "release", "rollout", "rollback", "ship",
  // deep debugger desk
  "debug", "bugfix", "hotfix", "troubleshoot",
  // qa & security reviewer desk
  "qa", "security", "audit", "review", "compliance",
] as const;

const MAX_DESCRIPTION_CHARS = 140;
const HTML_PATTERN = /<[a-z][^>]*>/i;

// The contract (§3.3) caps context_summary at ~3 sentences; past this it stops
// being a popover blurb and starts bloating the view.
export const MAX_CONTEXT_SUMMARY_CHARS = 600;

// Past this, the view no longer fits a single agent read. It only carries live
// beads, so the fix is closing what is done (status: completed).
export const ACTIVE_FILE_WARN_CHARS = 100_000;

// `trello` (aiteam/docs/beads-schema.md §3.3): o shortLink do card de origem — só ele, nunca a URL —
// ou uma lista deles quando o bead absorve mais de um card. Ausente é o caso normal.
const trelloLinkSchema = z
  .string()
  .regex(TRELLO_SHORTLINK, "must be the card's shortLink only (letters and digits), no URL and no spaces")
  .refine((s) => !TRELLO_CARD_ID.test(s), "that is the card id, not the shortLink (the shortLink is the last part of https://trello.com/c/<shortLink>)");

const phaseSchema = z
  .object({
    key: z.string().min(1),
    name: z.string().min(1),
    subtitle: z.string().optional(),
  })
  .passthrough();

const taskSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    status: z.enum(TASK_STATUSES),
    phase: z.union([z.number(), z.string()]).optional(),
    effort: z.string().optional(),
    impl_model: z.enum(IMPL_MODELS).optional(),
    estimated_time_m: z.number().optional(),
    estimated_cost_usd: z.number().optional(),
    context_summary: z.string().optional(),
    related_files: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    trello: z.union([trelloLinkSchema, z.array(trelloLinkSchema).min(1)]).optional(),
    // `partial` = o card pede menos que o bead cobre; só vale junto de `trello` (checado em validateBeads).
    trello_scope: z.enum(TRELLO_SCOPES).optional(),
    blockers: z.array(z.string()).optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
  })
  .passthrough();

// O contrato da visão gerada .beads/active.yaml (aiteam/docs/beads-schema.md
// §7.1), validado pelos testes do núcleo sobre renderActiveView(). A visão não
// traz branch (vem do git, na hora) nem last_updated (é reescrita a cada hook);
// os dois seguem aceitos para ler um active.yaml do modelo antigo.
const beadsSchema = z
  .object({
    version: z.string(),
    branch: z.string().optional(),
    project: z.string(),
    last_updated: z.string().optional(),
    phases: z.array(phaseSchema).optional(),
    session: z
      .object({
        active_spec_hash: z.string().optional(),
        budget_usd: z.number(),
        cost_accumulated_usd: z.number(),
        current_task_phase: z.string().optional(),
        focus_note: z.string().optional(),
        circuit_open: z.boolean().optional(),
      })
      .passthrough(),
    tasks: z.array(taskSchema),
  })
  .passthrough();

export type BeadsDocument = z.infer<typeof beadsSchema>;

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export interface ValidateOptions {
  /** Set false to skip the size warning (e.g. validating something other than the view). */
  warnOversize?: boolean;
}

export function validateBeads(text: string, opts: ValidateOptions = {}): ValidationResult {
  const { warnOversize = true } = opts;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (warnOversize && text.length > ACTIVE_FILE_WARN_CHARS) {
    warnings.push(
      `file is ~${Math.round(text.length / 1024)}KB (> ${Math.round(ACTIVE_FILE_WARN_CHARS / 1000)}KB) — too many live beads for a single agent read; close what is done with an entry status: completed (aiteam/docs/beads-schema.md §9)`
    );
  }

  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch (err) {
    return { errors: [`YAML parse error: ${(err as Error).message}`], warnings };
  }

  if (doc === null || doc === undefined) {
    return { errors: ["Document is empty — expected the view structure from aiteam/docs/beads-schema.md §7.1"], warnings };
  }

  const parsed = beadsSchema.safeParse(doc);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    return { errors, warnings };
  }

  const seen = new Set<string>();
  parsed.data.tasks.forEach((task, i) => {
    const label = `tasks[${i}] (${task.id})`;

    if (seen.has(task.id)) {
      errors.push(`${label}: duplicate id — task ids must be unique`);
    }
    seen.add(task.id);

    if (!task.description && !task.title) {
      errors.push(`${label}: needs "description" (or at least "title") — the Kanban card text`);
    }

    // `orch-` is the canonical, explicit prefix for Orchestrator tasks (contract §5),
    // so it does not need a frontend/backend/pm routing keyword.
    const idLower = task.id.toLowerCase();
    if (!idLower.startsWith("orch-") && !ROUTING_KEYWORDS.some((kw) => idLower.includes(kw))) {
      warnings.push(
        `${label}: id has no desk routing keyword — it will land on the Orchestrator desk (see aiteam/docs/beads-schema.md §5)`
      );
    }

    if (task.trello_scope !== undefined && task.trello === undefined) {
      errors.push(`${label}: trello_scope without trello — the mark only makes sense next to the origin card (aiteam/docs/beads-schema.md §3.3)`);
    }

    if (task.description && task.description.length > MAX_DESCRIPTION_CHARS) {
      warnings.push(`${label}: description exceeds ${MAX_DESCRIPTION_CHARS} chars — Kanban card will overflow`);
    }

    if (task.context_summary && task.context_summary.length > MAX_CONTEXT_SUMMARY_CHARS) {
      warnings.push(
        `${label}: context_summary exceeds ${MAX_CONTEXT_SUMMARY_CHARS} chars — keep it ≤3 sentences (aiteam/docs/beads-schema.md §3.3); session history belongs in git/docs, not the bead`
      );
    }

    for (const [field, value] of [
      ["description", task.description],
      ["title", task.title],
      ["context_summary", task.context_summary],
    ] as const) {
      if (value && HTML_PATTERN.test(value)) {
        warnings.push(`${label}: ${field} contains HTML — text fields must be plain text`);
      }
      if (value && value.includes("\n")) {
        warnings.push(`${label}: ${field} is multiline — use a single line (aiteam/docs/beads-schema.md §3.4)`);
      }
    }
  });

  // Phase keys: unique and non-empty (they route the panorama bars, like task ids).
  const phaseKeys = new Set<string>();
  (parsed.data.phases ?? []).forEach((p, i) => {
    if (phaseKeys.has(p.key)) errors.push(`phases[${i}]: duplicate key "${p.key}" — phase keys must be unique`);
    phaseKeys.add(p.key);
  });

  // Warn when a task.phase matches no declared phase key (non-fatal).
  parsed.data.tasks.forEach((task) => {
    if (typeof task.phase === "string" && phaseKeys.size > 0 && !phaseKeys.has(task.phase)) {
      warnings.push(`tasks[${task.id}]: phase "${task.phase}" matches no declared phases[].key`);
    }
  });

  // Warn on dangling blocker refs (non-fatal — the view only lists live beads, so
  // a blocker may point at a completed one). Shared with panorama-model.mjs's
  // danglingBlockers (Task 3) so the two implementations never drift apart.
  for (const { taskId, blockerId } of findDanglingBlockers(parsed.data.tasks)) {
    warnings.push(`tasks[${taskId}]: blocker "${blockerId}" matches no live task id (typo, or an already-completed bead)`);
  }

  // session.focus_note is documented as a single line (contract §6) — apply
  // the same multiline/HTML checks the task text fields already get above.
  const focusNote = parsed.data.session.focus_note;
  if (focusNote && HTML_PATTERN.test(focusNote)) {
    warnings.push(`session.focus_note: contains HTML — text fields must be plain text`);
  }
  if (focusNote && focusNote.includes("\n")) {
    warnings.push(`session.focus_note: is multiline — use a single line (aiteam/docs/beads-schema.md §6)`);
  }

  return { errors, warnings };
}
