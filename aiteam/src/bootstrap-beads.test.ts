import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildState, viewIntegrity } from "./beads-core.mjs";
import { makeSandbox, type Sandbox } from "./beads-sandbox.js";

// bootstrap-beads gera o .beads inicial de um repo legado direto no modelo por
// bead (aiteam/docs/beads-schema.md) — nunca mais um active.yaml rastreado
// nem espelho por branch.

const AITEAM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(AITEAM, "scripts", "bootstrap-beads.ts");

let sb: Sandbox | undefined;
afterEach(() => sb?.cleanup());

function run(dir: string) {
  const r = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, dir], { cwd: AITEAM, encoding: "utf8" });
  return { status: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

function repoWithHistory(): Sandbox {
  sb = makeSandbox({ branch: "feat/legado" });
  const s = sb;
  s.write("src/auth.ts", "export {};\n");
  s.git("add", "-A");
  s.git("commit", "-q", "-m", "feat(auth): login com jwt");
  s.write("src/page.tsx", "export {};\n");
  s.git("add", "-A");
  s.git("commit", "-q", "-m", "fix: page component quebrado");
  return s;
}

describe("bootstrap-beads — .beads inicial no modelo por bead", () => {
  it("escreve um bead concluído por escopo, válido, com .gitignore e visões", { timeout: 60_000 }, () => {
    const s = repoWithHistory();
    const r = run(s.dir);
    expect(r.status, r.out).toBe(0);

    const tasks = path.join(s.dir, ".beads", "tasks");
    const ids = fs.readdirSync(tasks).sort();
    // git log vem do mais novo: o commit de página (ui) é o grupo 001.
    expect(ids).toEqual(["api-history-002", "ui-history-001"]);
    const inputs = ids.map((id) => ({
      bead: id,
      branchFile: "feat-legado",
      text: fs.readFileSync(path.join(tasks, id, "feat-legado.yaml"), "utf8"),
    }));
    const state = buildState(inputs, [], {});
    expect(state.errors).toEqual([]);
    expect(state.beads.every((b) => b.status === "completed")).toBe(true);

    expect(s.read(".beads/.gitignore")).toMatch(/\/active\.yaml/);
    expect(viewIntegrity(s.read(".beads/active.yaml"))).toBe("intact");
    expect(s.exists(".beads/feat-legado.yaml")).toBe(false);
  });

  it("não sobrescreve um .beads que já tem beads", { timeout: 60_000 }, () => {
    const s = repoWithHistory();
    expect(run(s.dir).status).toBe(0);
    const again = run(s.dir);
    expect(again.status).toBe(1);
    expect(again.out).toMatch(/já tem beads/);
  });
});

describe("bootstrap-beads — padrão é a raiz do repo", () => {
  // `npm --prefix aiteam run bootstrap-beads` roda com cwd = aiteam/. O tsx é
  // chamado pelo caminho absoluto porque, com esse cwd, `--import tsx` não resolve.
  const TSX_CLI = path.join(AITEAM, "node_modules", "tsx", "dist", "cli.mjs");

  function runNoArg(cwd: string, extraEnv: Record<string, string> = {}) {
    const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
    delete env["RB_REPO_ROOT"];
    if (!("INIT_CWD" in extraEnv)) delete env["INIT_CWD"];
    const r = spawnSync(process.execPath, [TSX_CLI, SCRIPT], { cwd, env, encoding: "utf8" });
    return { status: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
  }

  it("sem argumento, com cwd em aiteam/, grava o .beads na raiz e não dentro do aiteam/", { timeout: 60_000 }, () => {
    const s = repoWithHistory();
    const r = runNoArg(path.join(s.dir, "aiteam"));
    expect(r.status, r.out).toBe(0);
    expect(fs.readdirSync(path.join(s.dir, ".beads", "tasks")).sort()).toEqual(["api-history-002", "ui-history-001"]);
    expect(s.exists("aiteam/.beads")).toBe(false);
  });

  it("sem argumento, o INIT_CWD do npm aponta o repo onde o comando foi digitado", { timeout: 60_000 }, () => {
    const s = repoWithHistory();
    const r = runNoArg(AITEAM, { INIT_CWD: path.join(s.dir, "src") });
    expect(r.status, r.out).toBe(0);
    expect(s.exists(".beads/tasks/ui-history-001")).toBe(true);
  });

  it("o argumento explícito continua valendo (e o `-- ..` antigo também)", { timeout: 60_000 }, () => {
    const s = repoWithHistory();
    const r = spawnSync(process.execPath, [TSX_CLI, SCRIPT, ".."], {
      cwd: path.join(s.dir, "aiteam"),
      encoding: "utf8",
    });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(s.exists(".beads/tasks/ui-history-001")).toBe(true);
    expect(s.exists("aiteam/.beads")).toBe(false);
  });
});
