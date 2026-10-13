// Pure, framework-agnostic model for the Bead Board panorama view.
// NO document/window/fetch at module scope — imported by both panorama.html
// (browser) and aiteam/src/panorama-model.test.ts (vitest).

import { findDanglingBlockers } from "./blocker-refs.mjs";

const STATUSES = ["completed", "pending", "in_progress", "blocked"];

function taskList(doc) {
  return Array.isArray(doc?.tasks) ? doc.tasks : [];
}

/**
 * Roll up progress per declared phase, in declaration order. Tasks whose phase
 * (string) matches no declared key — or whose phase is numeric/absent — fall
 * into a trailing synthetic { key: null, name: "Sem fase" } group.
 */
export function rollupPhases(doc) {
  const phases = Array.isArray(doc?.phases) ? doc.phases : [];
  const mk = (key, name, subtitle) => ({
    key, name, subtitle, total: 0, completed: 0, pending: 0, in_progress: 0, blocked: 0, taskIds: [],
  });
  const groups = phases.map((p) => mk(p.key, p.name, p.subtitle));
  const byKey = new Map(groups.map((g) => [g.key, g]));
  const semFase = mk(null, "Sem fase", undefined);

  for (const t of taskList(doc)) {
    const g = typeof t.phase === "string" && byKey.has(t.phase) ? byKey.get(t.phase) : semFase;
    g.total++;
    if (STATUSES.includes(t.status)) g[t.status]++;
    g.taskIds.push(t.id);
  }
  return semFase.total > 0 ? [...groups, semFase] : groups;
}

/**
 * Partition tasks by readiness (independent of phase). A task is:
 *  - "ready":   status pending AND every blocker is completed (or no blockers).
 *  - "blocked": status literally "blocked", OR status pending with >=1 incomplete
 *               blocker. A dangling blocker (no matching task) is treated as NOT
 *               blocking, since it's likely archived-and-done.
 * completed / in_progress tasks are in neither set.
 */
export function partitionReadiness(doc) {
  const tasks = taskList(doc);
  const statusById = new Map(tasks.map((t) => [t.id, t.status]));
  const ready = [];
  const blocked = [];
  for (const t of tasks) {
    if (t.status === "blocked") { blocked.push(t.id); continue; }
    if (t.status !== "pending") continue;
    const blockers = Array.isArray(t.blockers) ? t.blockers : [];
    const hasIncompleteBlocker = blockers.some(
      (b) => statusById.has(b) && statusById.get(b) !== "completed"
    );
    (hasIncompleteBlocker ? blocked : ready).push(t.id);
  }
  return { ready, blocked };
}

/**
 * Dependency graph from blockers[]: edge { from: blockerId, to: blockedId }
 * (from blocks to). missing = blocker ids with no matching task.
 */
export function buildDependencyGraph(doc) {
  const tasks = taskList(doc);
  const nodes = new Map(tasks.map((t) => [t.id, t]));
  const edges = [];
  const missing = [];
  for (const t of tasks) {
    for (const b of Array.isArray(t.blockers) ? t.blockers : []) {
      if (nodes.has(b)) edges.push({ from: b, to: t.id });
      else missing.push({ to: t.id, blockerId: b });
    }
  }
  return { nodes, edges, missing };
}

/** Blocker ids that match no task — powers the board hint (and mirrors the validator warning). */
export function danglingBlockers(doc) {
  return findDanglingBlockers(taskList(doc));
}

/**
 * Critical path over INCOMPLETE tasks (status !== "completed"):
 *  - bottleneck: incomplete task that transitively unblocks the most others.
 *  - chain: longest path of incomplete tasks in the DAG.
 *  - unblocks: how many incomplete tasks the bottleneck unblocks.
 * Cycle-safe: a back-edge is skipped (no infinite recursion).
 */
export function computeCriticalPath(graph) {
  const { nodes, edges } = graph;
  const incomplete = (id) => nodes.has(id) && nodes.get(id).status !== "completed";

  const adj = new Map();
  for (const id of nodes.keys()) if (incomplete(id)) adj.set(id, []);
  for (const { from, to } of edges) if (incomplete(from) && incomplete(to)) adj.get(from).push(to);

  const memoDesc = new Map();
  const descendants = (id, stack) => {
    if (memoDesc.has(id)) return memoDesc.get(id);
    if (stack.has(id)) return new Set(); // cycle guard
    stack.add(id);
    const acc = new Set();
    for (const nxt of adj.get(id) ?? []) {
      acc.add(nxt);
      for (const d of descendants(nxt, stack)) acc.add(d);
    }
    stack.delete(id);
    memoDesc.set(id, acc);
    return acc;
  };

  let bottleneck = null;
  let unblocks = 0;
  for (const id of adj.keys()) {
    const c = descendants(id, new Set()).size;
    if (c > unblocks) {
      unblocks = c;
      bottleneck = id;
    }
  }

  const memoPath = new Map();
  const longestFrom = (id, stack) => {
    if (memoPath.has(id)) return memoPath.get(id);
    if (stack.has(id)) return []; // cycle guard — do not re-append the ancestor; there is no safe extension past a back-edge
    stack.add(id);
    let best = [];
    for (const nxt of adj.get(id) ?? []) {
      const p = longestFrom(nxt, stack);
      if (p.length > best.length) best = p;
    }
    stack.delete(id);
    const path = [id, ...best];
    memoPath.set(id, path);
    return path;
  };

  let chain = [];
  for (const id of adj.keys()) {
    const p = longestFrom(id, new Set());
    if (p.length > chain.length) chain = p;
  }

  return { bottleneck: chain.length ? bottleneck : null, chain, unblocks };
}
