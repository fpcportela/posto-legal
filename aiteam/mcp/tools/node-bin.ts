import * as fs from "fs";
import * as path from "path";
import { checkoutCeiling, isWithin } from "./worktree.js";

/**
 * The script a package's executable runs (`node_modules/<pkg>/package.json` →
 * `bin`), from the nearest `node_modules/<pkg>` at or above `startDir` — the
 * search Node does for a bare import, so a hoisted install and a linked worktree
 * (`worktree-link.mjs` junctions `node_modules`) both resolve. `undefined` when
 * none of them has it.
 *
 * The climb STOPS at `ceiling` (default: the repository — see `checkoutCeiling`):
 * a `node_modules/<pkg>` above the repo (the home directory, another project) is
 * code from outside it, and the MCP server would run it with node. A ceiling that
 * does not contain `startDir` is no licence to climb: the search then stays at
 * `startDir`.
 *
 * Done by hand instead of `require.resolve("<pkg>/package.json")`: a package may
 * not export its package.json (vitest does not), and the tools run the script
 * with `process.execPath` — never the `.bin` shim, which on Windows is a `.cmd`
 * that execFileSync cannot start without a shell.
 */
export function findPackageBin(startDir: string, pkgName: string, binName: string, ceiling?: string): string | undefined {
  const start = path.resolve(startDir);
  let top = ceiling ?? checkoutCeiling(start);
  if (!isWithin(top, start)) top = start;

  let dir = start;
  for (;;) {
    const pkgPath = path.join(dir, "node_modules", pkgName, "package.json");
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { bin?: string | Record<string, string> };
      const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[binName];
      if (rel) {
        const bin = path.join(path.dirname(pkgPath), rel);
        if (fs.existsSync(bin)) return bin;
      }
    } catch {
      // Not installed here (or an unreadable package.json): keep climbing.
    }
    // At the ceiling: never above it.
    if (isWithin(dir, top) && isWithin(top, dir)) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
