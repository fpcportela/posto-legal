// SUPORTE SÓ AO MODO LEGADO — remover depois da fase 3 da rb-ai-team#37.
// O modelo por bead não usa merge driver (aiteam/docs/beads-schema.md §11).
// O sync manda o consumidor TIRAR o mapeamento `merge=beads-yaml` do
// .gitattributes, também em modo legado: ninguém deve mapear este driver de
// novo. Este arquivo fica só para o intervalo entre o sync e esse hand-merge: um
// consumidor que ainda mapeia .beads/*.yaml, com o merge.beads-yaml no
// .git/config apontando para cá, falharia em todo merge local se o script
// sumisse. O doctor reprova esse caso (e só ele), e só em modo legado: migrado
// + mapeia + script ausente dá WARN.

import * as fs from "fs";
import * as yaml from "js-yaml";

/**
 * Conflict-free merge for `.beads/*.yaml` (Blueprint 8.1).
 *
 * The task list is keyed by unique `id`, so concurrent edits to *different*
 * tasks never conflict — the merge is a union by id. When the same `id` is
 * edited on both sides, the node with the newest `updated_at` wins. Session
 * cost takes the larger value (never undercount the budget) and the circuit is
 * open if either side tripped it.
 */
export interface BeadsTask {
  id: string;
  updated_at?: string;
  [k: string]: unknown;
}

export interface BeadsDoc {
  version: string;
  branch: string;
  project: string;
  last_updated: string;
  session: {
    active_spec_hash: string;
    budget_usd: number;
    cost_accumulated_usd: number;
    circuit_open?: boolean;
    [k: string]: unknown;
  };
  tasks: BeadsTask[];
  [k: string]: unknown;
}

const ts = (t: BeadsTask): number => {
  const ms = Date.parse(t.updated_at ?? "");
  return Number.isNaN(ms) ? 0 : ms;
};

export function mergeBeadsState(ours: BeadsDoc, theirs: BeadsDoc): BeadsDoc {
  const byId = new Map<string, BeadsTask>();

  for (const task of [...ours.tasks, ...theirs.tasks]) {
    const existing = byId.get(task.id);
    // Keep the newest by updated_at; ties keep the first seen (ours).
    if (!existing || ts(task) > ts(existing)) {
      byId.set(task.id, task);
    }
  }

  // Preserve first-seen order (ours, then any new theirs) for a stable board.
  const order: string[] = [];
  for (const task of [...ours.tasks, ...theirs.tasks]) {
    if (!order.includes(task.id)) order.push(task.id);
  }

  return {
    ...ours,
    last_updated: new Date().toISOString(),
    session: {
      ...ours.session,
      ...theirs.session,
      cost_accumulated_usd: Math.max(
        ours.session.cost_accumulated_usd,
        theirs.session.cost_accumulated_usd
      ),
      circuit_open: ours.session.circuit_open === true || theirs.session.circuit_open === true,
    },
    tasks: order.map((id) => byId.get(id)!),
  };
}

export function mergeBeadsYaml(oursYaml: string, theirsYaml: string): string {
  const ours = yaml.load(oursYaml) as BeadsDoc;
  const theirs = yaml.load(theirsYaml) as BeadsDoc;
  return yaml.dump(mergeBeadsState(ours, theirs), { lineWidth: 120 });
}

/**
 * Git merge-driver entry point: `beads-merge <ours> <base> <theirs>`. Writes the
 * merged result back to the <ours> path (git's `%A`) and exits 0. `base` (`%O`)
 * is accepted for the standard driver signature but the union/newest-wins merge
 * does not need it.
 */
export function runMergeDriver(argv: string[]): number {
  const [oursPath, , theirsPath] = argv;
  if (!oursPath || !theirsPath) {
    console.error("usage: beads-merge <ours> <base> <theirs>");
    return 2;
  }
  try {
    const merged = mergeBeadsYaml(
      fs.readFileSync(oursPath, "utf8"),
      fs.readFileSync(theirsPath, "utf8")
    );
    fs.writeFileSync(oursPath, merged, "utf8");
    return 0;
  } catch (err) {
    console.error(`[beads-merge] failed: ${(err as Error).message}`);
    return 1;
  }
}
