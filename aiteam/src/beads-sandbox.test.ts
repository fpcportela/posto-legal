import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fastImport, makeSandbox, rmTree, type Sandbox } from "./beads-sandbox.js";

// O sandbox não pode deixar processo git para trás. Depois de commit/merge/
// fast-import o git dispara `git maintenance run --auto --detach` (ou `gc --auto`),
// que escreve em .git/objects fora do teste e briga com a limpeza do diretório:
// ENOTEMPTY na CI Linux do PR #47 (A-R1b).

const traces: string[] = [];
const sandboxes: Sandbox[] = [];

afterEach(() => {
  for (const s of sandboxes.splice(0)) s.cleanup();
  for (const t of traces.splice(0)) fs.rmSync(t, { force: true });
}, 60_000);

function traced(): { s: Sandbox; lines: () => string[] } {
  const trace = path.join(os.tmpdir(), `beads-sandbox-trace-${process.pid}-${Date.now()}-${traces.length}.log`);
  traces.push(trace);
  const s = makeSandbox({ env: { GIT_TRACE: trace } });
  sandboxes.push(s);
  return { s, lines: () => (fs.existsSync(trace) ? fs.readFileSync(trace, "utf8").split("\n") : []) };
}

// Linhas do trace em que o git roda `git maintenance ...` ou `git gc ...` (o que
// importa são os processos, não as linhas `git config gc.auto 0` do setup).
const background = (lines: string[]) => lines.filter((l) => /(built-in|run_command|start_command): git (maintenance|gc)\b|--detach/.test(l));

describe("sandbox sem git em segundo plano", () => {
  it("commit, fast-import e commit numa worktree não disparam maintenance nem gc", () => {
    const { s, lines } = traced();
    s.write("a.txt", "a\n");
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "a");
    fastImport(s, [{ branch: "feat/x", files: { "x.txt": "x\n" } }]);
    s.git("merge", "-q", "--no-ff", "-m", "merge", "feat/x");
    const wt = `${s.dir}-wt`;
    try {
      s.git("worktree", "add", "-q", "-b", "feat/wt", wt);
      s.git("-C", wt, "commit", "-q", "--allow-empty", "-m", "na worktree");
    } finally {
      rmTree(wt);
    }
    expect(lines().length).toBeGreaterThan(0); // o trace está de fato ligado
    expect(background(lines())).toEqual([]);
  });

  it("a config do repo e a global do sandbox desligam gc e maintenance", () => {
    const { s } = traced();
    const get = (key: string) => s.git("config", "--get", key).trim();
    expect(get("gc.auto")).toBe("0");
    expect(get("gc.autoDetach")).toBe("false");
    expect(get("maintenance.auto")).toBe("false");
    const global = (key: string) => s.git("config", "--file", s.env.GIT_CONFIG_GLOBAL!, "--get", key).trim();
    expect(global("gc.auto")).toBe("0");
    expect(global("gc.autoDetach")).toBe("false");
    expect(global("maintenance.auto")).toBe("false");
  });
});

describe("rmTree", () => {
  it("apaga a árvore inteira e não reclama de caminho que não existe", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "beads-rmtree-"));
    fs.mkdirSync(path.join(dir, "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(dir, "a", "b", "f.txt"), "x");
    rmTree(dir);
    expect(fs.existsSync(dir)).toBe(false);
    expect(() => rmTree(dir)).not.toThrow();
  });
});
