// SUPORTE SÓ AO MODO LEGADO — remover depois da fase 3 da rb-ai-team#37.
// O modelo por bead não usa merge driver (aiteam/docs/beads-schema.md §11).
// O sync manda o consumidor TIRAR o mapeamento `merge=beads-yaml` do
// .gitattributes, também em modo legado: ninguém deve mapear este driver de
// novo. Este arquivo fica só para o intervalo entre o sync e esse hand-merge: um
// consumidor que ainda mapeia .beads/*.yaml, com o merge.beads-yaml no
// .git/config apontando para cá, falharia em todo merge local se o script
// sumisse. O doctor reprova esse caso (e só ele), e só em modo legado: migrado
// + mapeia + script ausente dá WARN.

import { describe, expect, it } from "vitest";
import { mergeBeadsState, type BeadsDoc } from "./beads-merge.js";

const doc = (tasks: Array<{ id: string; status: string; updated_at: string }>, cost = 0): BeadsDoc => ({
  version: "1.0",
  branch: "main",
  project: "t",
  last_updated: "2026-06-10T00:00:00Z",
  session: { active_spec_hash: "", budget_usd: 2, cost_accumulated_usd: cost },
  tasks,
});

describe("mergeBeadsState — union by task id", () => {
  it("keeps tasks that two branches added independently", () => {
    const ours = doc([{ id: "api-a", status: "completed", updated_at: "2026-06-10T01:00:00Z" }]);
    const theirs = doc([{ id: "ui-b", status: "in_progress", updated_at: "2026-06-10T02:00:00Z" }]);

    const merged = mergeBeadsState(ours, theirs);
    const ids = merged.tasks.map((t) => t.id).sort();
    expect(ids).toEqual(["api-a", "ui-b"]);
  });

  it("resolves a same-id edit by newest updated_at", () => {
    const ours = doc([{ id: "api-a", status: "in_progress", updated_at: "2026-06-10T01:00:00Z" }]);
    const theirs = doc([{ id: "api-a", status: "completed", updated_at: "2026-06-10T05:00:00Z" }]);

    const merged = mergeBeadsState(ours, theirs);
    expect(merged.tasks).toHaveLength(1);
    expect(merged.tasks[0]!.status).toBe("completed");
  });

  it("keeps the local node when its timestamp is newer", () => {
    const ours = doc([{ id: "api-a", status: "completed", updated_at: "2026-06-10T09:00:00Z" }]);
    const theirs = doc([{ id: "api-a", status: "blocked", updated_at: "2026-06-10T03:00:00Z" }]);

    const merged = mergeBeadsState(ours, theirs);
    expect(merged.tasks[0]!.status).toBe("completed");
  });
});

describe("mergeBeadsState — session reconciliation", () => {
  it("takes the larger accumulated cost (never undercount)", () => {
    const ours = doc([], 0.4);
    const theirs = doc([], 0.9);
    expect(mergeBeadsState(ours, theirs).session.cost_accumulated_usd).toBeCloseTo(0.9, 10);
  });

  it("treats the circuit as open if either side tripped it", () => {
    const ours = doc([], 0.4);
    const theirs = { ...doc([], 0.4), session: { ...doc([], 0.4).session, circuit_open: true } };
    expect(mergeBeadsState(ours, theirs).session.circuit_open).toBe(true);
  });
});
