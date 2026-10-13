import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { load } from "js-yaml";
import { viewIntegrity } from "./beads-core.mjs";
import { GITIGNORE } from "./beads-migrate.mjs";
import { clean, commitAll, commitTry, definition, entry, SLOW, T, useFlowSandboxes, type Sandbox } from "./beads-sandbox.js";

// O fluxo git de verdade, com os hooks de aiteam/githooks rodando num repo
// descartável SEM node_modules (core.hooksPath relativo, hooks em 100755).
// Cada cenário é um item B do plano da fase 1 de rb-ai-team#37; o contrato é
// aiteam/docs/beads-schema.md. Este arquivo: B1–B5, worktree e merge. As
// recusas (B6–B10) e o modo legado (B11–B15) moram nos irmãos
// beads-git-flow-*.test.ts — separados para rodarem em paralelo.

const kit = useFlowSandboxes(GITIGNORE);

const view = (s: Sandbox) => load(s.read(".beads/active.yaml")) as any;
const liveIds = (s: Sandbox) => view(s).tasks.map((t: any) => t.id);
const indexed = (s: Sandbox, id: string) => (load(s.read(".beads/index.yaml")) as any[]).find((e) => e.id === id);

const BEAD_A = `${definition("Bead A", T(1))}entries:\n${entry(T(1, 11), { status: "in_progress" })}`;

function withBeadA(): Sandbox {
  const s = kit.repo();
  s.write(".beads/tasks/api-a/main.yaml", BEAD_A);
  commitAll(s, "bead A");
  return s;
}

describe("B1 — worktree nova herda os beads, gera as visões e fica limpa", () => {
  it("git worktree add -b; commit só de código não toca em .beads/", SLOW, () => {
    const s = withBeadA();
    expect(viewIntegrity(s.read(".beads/active.yaml"))).toBe("intact");
    expect(clean(s)).toBe("");

    const wt = kit.sibling(s, "wt");
    s.git("worktree", "add", "-q", "-b", "x", wt);
    const active = fs.readFileSync(path.join(wt, ".beads", "active.yaml"), "utf8");
    expect(viewIntegrity(active)).toBe("intact");
    expect((load(active) as any).tasks.map((t: any) => t.id)).toEqual(["api-a"]);
    const gitWt = (...a: string[]) => s.git("-C", wt, ...a);
    expect(gitWt("status", "--porcelain").trim()).toBe("");

    fs.writeFileSync(path.join(wt, "codigo.txt"), "só código\n");
    gitWt("add", "codigo.txt");
    gitWt("commit", "-q", "-m", "código");
    expect(gitWt("show", "--name-only", "--format=", "HEAD").trim()).toBe("codigo.txt");
    expect(gitWt("status", "--porcelain").trim()).toBe("");
  });
});

describe("B2/B3 — merge sem driver, mesmo bead nas duas branches", () => {
  function diverge(): Sandbox {
    const s = withBeadA();
    s.git("checkout", "-q", "-b", "feat");
    s.write(".beads/tasks/api-a/feat.yaml", `entries:\n${entry(T(2), { status: "blocked", blockers: '["api-b"]' })}`);
    commitAll(s, "feat: bloqueia A");
    s.git("checkout", "-q", "main");
    s.write(".beads/tasks/api-a/main.yaml", `${BEAD_A}${entry(T(3), { status: "completed", context_summary: "Feito." })}`);
    commitAll(s, "main: conclui A");
    return s;
  }

  it("B2: feat entra na main sem conflito e o mais recente vence", SLOW, () => {
    const s = diverge();
    // Sem driver nenhum registrado, como no merge do GitHub.
    expect(s.gitTry("config", "--get-regexp", "^merge\\.").out.trim()).toBe("");
    const out = s.git("merge", "--no-edit", "-q", "feat");
    expect(out).not.toMatch(/CONFLICT/);
    expect(s.exists(".beads/tasks/api-a/feat.yaml")).toBe(true);
    expect(indexed(s, "api-a")).toMatchObject({ status: "completed", done: "2026-10-03" });
    expect(liveIds(s)).toEqual([]);
    expect(clean(s)).toBe("");
  });

  it("B3: no sentido inverso o resultado é o mesmo", SLOW, () => {
    const s = diverge();
    s.git("checkout", "-q", "feat");
    expect(indexed(s, "api-a").status).toBe("blocked");
    s.git("merge", "--no-edit", "-q", "main");
    expect(indexed(s, "api-a")).toMatchObject({ status: "completed", done: "2026-10-03" });
    expect(clean(s)).toBe("");
  });
});

describe("B4/B5 — beads criados em branches diferentes", () => {
  it("B4: duas branches criando beads diferentes", SLOW, () => {
    const s = withBeadA();
    s.git("checkout", "-q", "-b", "feat-a");
    s.write(".beads/tasks/api-x/feat-a.yaml", definition("X", T(2)));
    commitAll(s, "x");
    s.git("checkout", "-q", "main");
    s.git("checkout", "-q", "-b", "feat-b");
    s.write(".beads/tasks/ui-y/feat-b.yaml", definition("Y", T(3)));
    commitAll(s, "y");
    s.git("checkout", "-q", "main");
    s.git("merge", "--no-edit", "-q", "feat-a");
    s.git("merge", "--no-edit", "-q", "feat-b");
    expect(liveIds(s).sort()).toEqual(["api-a", "api-x", "ui-y"]);
    expect(clean(s)).toBe("");
  });

  it("B5: o mesmo id criado nas duas: as duas definições valem, com aviso", SLOW, () => {
    const s = withBeadA();
    s.git("checkout", "-q", "-b", "feat");
    s.write(".beads/tasks/api-z/feat.yaml", definition("Z da feat", T(3)));
    commitAll(s, "z feat");
    s.git("checkout", "-q", "main");
    s.write(".beads/tasks/api-z/main.yaml", definition("Z da main", T(2)));
    commitAll(s, "z main");
    const out = s.git("merge", "--no-edit", "feat");
    expect(out).toMatch(/definido por feat e main/);
    const z = view(s).tasks.find((t: any) => t.id === "api-z");
    expect(z).toMatchObject({ title: "Z da feat", created_at: T(2), branches: ["feat", "main"] });
  });
});

// Com MSYS_NO_PATHCONV=1 o bash do Git for Windows não converte mais "/c/…"
// em "C:/…" nos argumentos de um programa nativo: o node.exe recebia
// "/c/devops/…/beads-check.mjs" e não achava o script. O hook então falhava (ou,
// no post-commit, deixava de regenerar a visão calado). BEADS_AITEAM vem de
// `pwd -W` no Windows e de `pwd` no resto.
describe("MSYS_NO_PATHCONV=1 — os hooks acham os scripts node no Windows", () => {
  it.skipIf(process.platform !== "win32")("o pre-commit confere o bead e o post-commit regenera a visão", SLOW, () => {
    const s = kit.repo({ env: { MSYS_NO_PATHCONV: "1" } });
    s.write(".beads/tasks/api-a/main.yaml", BEAD_A);
    const r = commitTry(s, "bead A");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("1 arquivo(s) de bead staged conferido(s)");
    expect(viewIntegrity(s.read(".beads/active.yaml"))).toBe("intact");
    expect(liveIds(s)).toEqual(["api-a"]);
  });
});
