// Pure helper shared by aiteam/src/beads-schema.ts (validation warnings) and
// panorama-model.mjs (dependency graph, Task 3) — single implementation of
// "which blockers[] entries point at no task" so the two call sites can't drift.
export function findDanglingBlockers(tasks) {
  const ids = new Set(tasks.map((t) => t.id));
  const out = [];
  for (const t of tasks) {
    for (const b of Array.isArray(t.blockers) ? t.blockers : []) {
      if (!ids.has(b)) out.push({ taskId: t.id, blockerId: b });
    }
  }
  return out;
}
