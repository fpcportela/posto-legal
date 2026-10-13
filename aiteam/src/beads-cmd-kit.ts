import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { load } from "js-yaml";
import { GITIGNORE } from "./beads-migrate.mjs";
import { commitAll, definition, entry, T, useFlowSandboxes, type RunResult, type Sandbox } from "./beads-sandbox.js";

// Kit dos testes do comando `beads` (beads-cmd*.test.ts): o repo descartável
// sem node_modules, o comando como subprocesso e os helpers comuns. Os arquivos
// de teste são separados para rodarem em paralelo.

export const useKit = () => useFlowSandboxes(GITIGNORE);
export type Kit = ReturnType<typeof useKit>;

export const beads = (s: Sandbox, args: string[], env: Record<string, string> = {}): RunResult => s.node("scripts/beads.mjs", args, env);

/** Roda o comando da cópia do framework que a worktree tem, de dentro dela. */
export function beadsIn(s: Sandbox, dir: string, args: string[]): RunResult {
  const r = spawnSync(process.execPath, [path.join(dir, "aiteam", "scripts", "beads.mjs"), ...args], { cwd: dir, env: s.env, encoding: "utf8", windowsHide: true });
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}${r.stderr}` };
}

/** Sem hooks: core.hooksPath no .git/hooks, que só tem os .sample. */
export const noHooks = (s: Sandbox) => s.git("config", "core.hooksPath", ".git/hooks");
export const tasks = (s: Sandbox) => s.git("status", "--porcelain", "--untracked-files=all", "--", ".beads/tasks").trim();
export const entriesOf = (s: Sandbox, rel: string) => (load(s.read(rel)) as any).entries as { at: string; [k: string]: unknown }[];

export const BEAD_A = `${definition("Bead A", T(1))}entries:\n${entry(T(1, 11), { status: "in_progress" })}`;

/** O repo com o bead A na main; sem hooks, que custam um bash e um node por commit. */
export function withBeadA(kit: Kit, opts: { hooks?: boolean } = {}): Sandbox {
  const s = kit.repo();
  if (!opts.hooks) noHooks(s);
  s.write(".beads/tasks/api-a/main.yaml", BEAD_A);
  commitAll(s, "bead A");
  return s;
}
