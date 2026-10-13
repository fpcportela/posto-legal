import { describe, it, expect } from "vitest";
import { rollupPhases, partitionReadiness, buildDependencyGraph, danglingBlockers, computeCriticalPath } from "../tools/bead_board/panorama-model.mjs";

const DOC = {
  phases: [
    { key: "fase-0", name: "Fase 0", subtitle: "fundação" },
    { key: "fase-1", name: "Fase 1" },
  ],
  tasks: [
    { id: "a", status: "completed", phase: "fase-0" },
    { id: "b", status: "pending", phase: "fase-0" },
    { id: "c", status: "in_progress", phase: "fase-1" },
    { id: "d", status: "pending", phase: "fase-1", blockers: ["c"] },
    { id: "e", status: "blocked", phase: "fase-9" }, // unmatched phase -> sem fase
    { id: "f", status: "pending" }, // no phase -> sem fase
  ],
};

describe("rollupPhases", () => {
  it("rolls up counts per phase in declaration order, with a trailing 'sem fase'", () => {
    const r = rollupPhases(DOC);
    expect(r.map((g) => g.key)).toEqual(["fase-0", "fase-1", null]);
    const f0 = r[0]!;
    expect(f0).toMatchObject({ total: 2, completed: 1, pending: 1, in_progress: 0, blocked: 0 });
    expect(f0.taskIds).toEqual(["a", "b"]);
    const sem = r[2]!;
    expect(sem.name).toBe("Sem fase");
    expect(sem.taskIds.sort()).toEqual(["e", "f"]);
    expect(sem.blocked).toBe(1);
  });

  it("omits the 'sem fase' group when every task has a matching phase", () => {
    const doc = { phases: [{ key: "p", name: "P" }], tasks: [{ id: "x", status: "pending", phase: "p" }] };
    expect(rollupPhases(doc).map((g) => g.key)).toEqual(["p"]);
  });

  it("handles an absent phases block (everything is 'sem fase')", () => {
    const r = rollupPhases({ tasks: [{ id: "x", status: "pending" }] });
    expect(r).toHaveLength(1);
    expect(r[0]!.key).toBeNull();
  });

  it("routes a numeric phase to 'sem fase' (only string phase matches a declared key)", () => {
    const doc = { phases: [{ key: "1", name: "Fase 1" }], tasks: [{ id: "x", status: "pending", phase: 1 }] };
    const r = rollupPhases(doc);
    expect(r.map((g) => g.key)).toEqual(["1", null]);
    expect(r[1]!.taskIds).toEqual(["x"]);
  });

  it("handles an empty tasks list (no groups beyond declared phases, no 'sem fase')", () => {
    const r = rollupPhases({ phases: [{ key: "p", name: "P" }], tasks: [] });
    expect(r).toEqual([{ key: "p", name: "P", subtitle: undefined, total: 0, completed: 0, pending: 0, in_progress: 0, blocked: 0, taskIds: [] }]);
  });
});

describe("partitionReadiness", () => {
  it("ready = pending with all blockers complete; blocked = pending w/ incomplete blocker or status blocked", () => {
    const r = partitionReadiness(DOC);
    expect(r.ready.sort()).toEqual(["b", "f"]); // pending, no incomplete blocker
    expect(r.blocked.sort()).toEqual(["d", "e"]); // d blocked by in_progress c; e is status blocked
  });

  it("treats a dangling blocker as NOT blocking (archived-and-done)", () => {
    const doc = { tasks: [{ id: "x", status: "pending", blockers: ["ghost"] }] };
    expect(partitionReadiness(doc)).toEqual({ ready: ["x"], blocked: [] });
  });
});

// gates -> deploy -> dashboard -> admin (blocker -> blocked)
const CHAIN_DOC = {
  tasks: [
    { id: "gate1", status: "pending" },
    { id: "gate2", status: "completed" },
    { id: "deploy", status: "pending", blockers: ["gate1", "gate2"] },
    { id: "dashboard", status: "pending", blockers: ["deploy"] },
    { id: "admin", status: "pending", blockers: ["dashboard"] },
    { id: "orphan", status: "pending", blockers: ["ghost"] },
  ],
};

describe("buildDependencyGraph", () => {
  it("builds edges blocker->blocked and records missing refs", () => {
    const g = buildDependencyGraph(CHAIN_DOC);
    expect(g.edges).toContainEqual({ from: "deploy", to: "dashboard" });
    expect(g.edges).toContainEqual({ from: "gate1", to: "deploy" });
    expect(g.missing).toContainEqual({ to: "orphan", blockerId: "ghost" });
  });
});

describe("danglingBlockers", () => {
  it("flags a blocker id with no matching task", () => {
    expect(danglingBlockers(CHAIN_DOC)).toContainEqual({ taskId: "orphan", blockerId: "ghost" });
  });
});

describe("computeCriticalPath", () => {
  it("finds the longest incomplete chain and the biggest bottleneck", () => {
    const cp = computeCriticalPath(buildDependencyGraph(CHAIN_DOC));
    // longest incomplete path: gate1 -> deploy -> dashboard -> admin (gate2 is completed, excluded)
    expect(cp.chain).toEqual(["gate1", "deploy", "dashboard", "admin"]);
    // gate1 transitively unblocks deploy, dashboard, admin = 3
    expect(cp.bottleneck).toBe("gate1");
    expect(cp.unblocks).toBe(3);
  });

  it("is cycle-safe (a<->b does not loop) and returns an acyclic result", () => {
    const g = buildDependencyGraph({
      tasks: [
        { id: "a", status: "pending", blockers: ["b"] },
        { id: "b", status: "pending", blockers: ["a"] },
      ],
    });
    const cp = computeCriticalPath(g); // must return, not hang
    expect(cp.chain.length).toBeGreaterThanOrEqual(1);
    // Verify no id appears twice in a single path (chain must be acyclic)
    expect(new Set(cp.chain).size).toBe(cp.chain.length);
  });

  it("returns empty chain / null bottleneck when there are no incomplete edges", () => {
    const cp = computeCriticalPath(buildDependencyGraph({ tasks: [{ id: "x", status: "completed" }] }));
    expect(cp).toEqual({ bottleneck: null, chain: [], unblocks: 0 });
  });
});
