import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { beadsGuardDecision, normalizeInputPath, relativeToRoot } from "./beads-guard-core.mjs";
import { definition, makeSandbox, type Sandbox } from "./beads-sandbox.js";

// O beads-guard é o acelerador opcional do Claude Code (aiteam/docs/beads-schema.md
// §9): nega o Write/Edit que o pre-commit recusaria depois, já com o caminho
// certo na mensagem. O gate de verdade continua sendo o pre-commit.

const decide = (rel: string, branch: string | null = "feat/x", legacy = false) =>
  beadsGuardDecision({ rel, branch, legacy });

describe("beadsGuardDecision", () => {
  it("nega Write/Edit nas visões geradas, com o arquivo certo na mensagem", () => {
    for (const rel of [".beads/active.yaml", ".beads/index.yaml"]) {
      const d = decide(rel);
      expect(d.deny, rel).toBe(true);
      expect(d.reason).toMatch(/visão gerada/);
      expect(d.reason).toContain(".beads/tasks/<id>/feat-x.yaml");
    }
  });

  it("nega backup de visão, archive/ e espelho do modelo antigo", () => {
    expect(decide(".beads/active.yaml.editado-20261005T120000Z").deny).toBe(true);
    expect(decide(".beads/archive/completed.yaml").reason).toMatch(/archive/);
    expect(decide(".beads/main.yaml").reason).toMatch(/espelho/);
    // a cópia que o FileCostStore guarda de um session.local.json ilegível
    expect(decide(".beads/session.local.json.corrupt-20261005T120000Z").reason).toMatch(/estado local/);
  });

  it("nega o arquivo de outra branch e aponta o da branch atual", () => {
    const d = decide(".beads/tasks/api-a/main.yaml");
    expect(d.deny).toBe(true);
    expect(d.reason).toContain('é da branch "main"; você está em "feat/x"');
    expect(d.reason).toContain(".beads/tasks/api-a/feat-x.yaml");
    expect(decide(".beads/project/main.yaml").reason).toContain(".beads/project/feat-x.yaml");
  });

  it("permite o arquivo da própria branch e o que não é do .beads", () => {
    expect(decide(".beads/tasks/api-a/feat-x.yaml").deny).toBe(false);
    expect(decide(".beads/project/feat-x.yaml").deny).toBe(false);
    expect(decide(".beads/SCHEMA.md").deny).toBe(false);
    expect(decide("src/app.ts").deny).toBe(false);
  });

  it("HEAD destacado não escreve bead", () => {
    const d = decide(".beads/tasks/api-a/HEAD.yaml", null);
    expect(d.deny).toBe(true);
    expect(d.reason).toMatch(/crie uma branch/);
  });

  it("em modo legado o active.yaml fica livre e o modelo novo é negado até migrar", () => {
    expect(decide(".beads/active.yaml", "main", true).deny).toBe(false);
    expect(decide(".beads/main.yaml", "main", true).deny).toBe(false);
    const d = decide(".beads/tasks/api-a/main.yaml", "main", true);
    expect(d.deny).toBe(true);
    expect(d.reason).toMatch(/modo legado.*migrate-beads/);
    expect(decide(".beads/project/main.yaml", "main", true).deny).toBe(true);
  });

  it("o prefixo .beads/ vale ignorando maiúsculas (disco do Windows e do macOS)", () => {
    expect(decide(".BEADS/Active.yaml").deny).toBe(true);
  });

  // Num disco que ignora maiúsculas, .beads/TASKS/ é .beads/tasks/ e main.YAML
  // é main.yaml: a estrutura se compara em minúsculas; o id e a branch, não.
  it("em disco que ignora maiúsculas, TASKS, ARCHIVE e .YAML são a estrutura de sempre", () => {
    const ci = (rel: string) => beadsGuardDecision({ rel, branch: "feat/x", legacy: false, caseInsensitive: true });
    expect(ci(".beads/TASKS/api-a/main.yaml").reason).toContain('é da branch "main"');
    expect(ci(".beads/tasks/api-a/main.YAML").reason).toContain('é da branch "main"');
    expect(ci(".BEADS/ARCHIVE/completed.yaml").reason).toMatch(/archive/);
    expect(ci(".beads/Session.Local.JSON").reason).toMatch(/estado local/);
    expect(ci(".beads/tasks/api-a/feat-x.YAML").deny).toBe(false);
    // num disco que diferencia, .beads/TASKS/ é outra pasta — não é bead
    expect(decide(".beads/TASKS/api-a/main.yaml").deny).toBe(false);
  });
});

describe("normalizeInputPath — o caminho como o disco o entende", () => {
  it("win32: \\\\?\\, /c/..., /cygdrive/c/, stream alternado e ponto ou espaço no fim", () => {
    const n = (p: string) => normalizeInputPath(p, "win32");
    expect(n("\\\\?\\C:\\r\\.beads\\active.yaml")).toBe("C:\\r\\.beads\\active.yaml");
    expect(n("\\\\?\\UNC\\srv\\share\\.beads\\active.yaml")).toBe("\\\\srv\\share\\.beads\\active.yaml");
    expect(n("/c/r/.beads/active.yaml")).toBe("C:/r/.beads/active.yaml");
    expect(n("/cygdrive/d/r/x")).toBe("D:/r/x");
    expect(n(".beads/active.yaml::$DATA")).toBe(".beads/active.yaml");
    expect(n("C:\\r\\.beads\\active.yaml:stream")).toBe("C:\\r\\.beads\\active.yaml");
    expect(n(".beads/active.yaml.")).toBe(".beads/active.yaml");
    expect(n(".beads/active.yaml . ")).toBe(".beads/active.yaml");
    expect(n(".beads./tasks /x/main.yaml")).toBe(".beads/tasks/x/main.yaml");
    expect(n("../.beads/./active.yaml")).toBe("../.beads/./active.yaml");
  });

  it("posix: nada muda — dois-pontos e ponto no fim são nomes válidos", () => {
    for (const p of ["/c/r/.beads/active.yaml", ".beads/a.yaml:x", ".beads/active.yaml."]) {
      expect(normalizeInputPath(p, "linux")).toBe(p);
    }
  });
});

describe("relativeToRoot — confina o caminho à raiz", () => {
  const root = path.resolve("/repo");
  it("relativo ao cwd, absoluto e com .. no meio", () => {
    expect(relativeToRoot(root, ".beads/active.yaml", root)).toBe(".beads/active.yaml");
    expect(relativeToRoot(root, path.join(root, ".beads", "index.yaml"), root)).toBe(".beads/index.yaml");
    expect(relativeToRoot(root, path.join(root, "aiteam", "..", ".beads", "active.yaml"), root)).toBe(".beads/active.yaml");
  });
  it("fora da raiz não é assunto do guard", () => {
    expect(relativeToRoot(root, path.resolve("/outro/.beads/active.yaml"), root)).toBeNull();
    expect(relativeToRoot(root, path.join(root, "..", ".beads", "active.yaml"), root)).toBeNull();
  });
});

describe("hook beads-guard.mjs de ponta a ponta (sem node_modules)", () => {
  let sb: Sandbox | undefined;
  afterEach(() => sb?.cleanup());

  function run(s: Sandbox, toolName: string, filePath: string, cwd = s.dir) {
    const r = spawnSync(process.execPath, [path.join(s.dir, "aiteam", "hooks", "beads-guard.mjs")], {
      input: JSON.stringify({ tool_name: toolName, tool_input: { file_path: filePath }, cwd }),
      cwd: s.dir,
      env: s.env,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(r.status).toBe(0);
    const out = r.stdout.trim();
    return out ? JSON.parse(out) : {};
  }

  it("nega a visão e o arquivo de outra branch; permite o próprio", { timeout: 60_000 }, () => {
    sb = makeSandbox({ branch: "main" });
    const s = sb;
    s.write(".beads/tasks/api-a/main.yaml", definition("A", "2026-10-01T10:00:00Z"));
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "a");
    s.git("checkout", "-q", "-b", "feat/x");

    const view = run(s, "Write", path.join(s.dir, ".beads", "active.yaml"));
    expect(view.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(view.hookSpecificOutput?.permissionDecisionReason).toContain(".beads/tasks/<id>/feat-x.yaml");

    const other = run(s, "Edit", ".beads/tasks/api-a/main.yaml");
    expect(other.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(other.hookSpecificOutput?.permissionDecisionReason).toContain(".beads/tasks/api-a/feat-x.yaml");

    expect(run(s, "Write", ".beads/tasks/api-a/feat-x.yaml").hookSpecificOutput).toBeUndefined();
    expect(run(s, "Write", "src/qualquer.ts").hookSpecificOutput).toBeUndefined();
    expect(run(s, "Bash", ".beads/active.yaml").hookSpecificOutput).toBeUndefined();
  });

  // Em legado, o active.yaml rastreado ainda é a fonte: o guard o deixa em paz,
  // mas nega escrever no modelo novo antes da migração.
  it("em modo legado: active.yaml livre, .beads/tasks negado com o comando da migração", { timeout: 60_000 }, () => {
    sb = makeSandbox();
    const s = sb;
    s.write(".beads/active.yaml", 'version: "1.0"\ntasks: []\n');
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "legado");
    expect(run(s, "Write", ".beads/active.yaml").hookSpecificOutput).toBeUndefined();
    const tasks = run(s, "Write", ".beads/tasks/api-x/main.yaml");
    expect(tasks.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(tasks.hookSpecificOutput?.permissionDecisionReason).toMatch(/modo legado.*migrate-beads/);
  });

  const denied = (o: any) => o.hookSpecificOutput?.permissionDecision === "deny";

  // A raiz, a branch e o modo legado vêm do ALVO, não do cwd da sessão: um
  // agente com cwd no checkout principal que edita outra worktree (ou um repo
  // aninhado) é julgado pela branch de lá.
  it("a raiz vem do alvo: outra worktree, repo aninhado e junção/symlink", { timeout: 90_000 }, () => {
    sb = makeSandbox({ branch: "main" });
    const s = sb;
    s.write(".beads/tasks/api-a/main.yaml", definition("A", "2026-10-01T10:00:00Z"));
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "a");
    const wt = `${s.dir}-wt`;
    const link = `${s.dir}-link`;
    try {
      s.git("worktree", "add", "-q", "-b", "feat/y", wt);
      // cwd no principal (main), alvo na worktree (feat/y): main.yaml é de outra branch
      const there = run(s, "Edit", path.join(wt, ".beads", "tasks", "api-a", "main.yaml"));
      expect(denied(there)).toBe(true);
      expect(there.hookSpecificOutput.permissionDecisionReason).toContain(".beads/tasks/api-a/feat-y.yaml");
      expect(denied(run(s, "Edit", path.join(wt, ".beads", "tasks", "api-a", "feat-y.yaml")))).toBe(false);
      // cwd na worktree, alvo no principal (main): o arquivo da main é livre lá
      expect(denied(run(s, "Edit", path.join(s.dir, ".beads", "tasks", "api-a", "main.yaml"), wt))).toBe(false);
      // relativo ao cwd do principal, apontando para dentro da worktree
      expect(denied(run(s, "Write", path.relative(s.dir, path.join(wt, ".beads", "active.yaml"))))).toBe(true);

      // repo aninhado no modelo antigo: o active.yaml dele é livre; o do de fora, não
      const sub = path.join(s.dir, "sub");
      fs.mkdirSync(path.join(sub, ".beads"), { recursive: true });
      fs.writeFileSync(path.join(sub, ".beads", "active.yaml"), 'version: "1.0"\ntasks: []\n');
      const inSub = (...a: string[]) => s.git("-C", sub, ...a);
      inSub("init", "-q", "-b", "main");
      inSub("add", "-A");
      inSub("-c", "user.email=b@example.com", "-c", "user.name=b", "commit", "-q", "-m", "legado");
      expect(denied(run(s, "Write", "sub/.beads/active.yaml"))).toBe(false);
      expect(denied(run(s, "Write", ".beads/active.yaml"))).toBe(true);

      // junção (Windows) ou symlink de diretório para a raiz
      fs.symlinkSync(s.dir, link, "junction");
      expect(denied(run(s, "Write", path.join(link, ".beads", "active.yaml"), os.tmpdir()))).toBe(true);
      expect(denied(run(s, "Edit", path.join(link, ".beads", "tasks", "api-a", "main.yaml"), os.tmpdir()))).toBe(false);
    } finally {
      try {
        fs.rmdirSync(link);
      } catch {
        try {
          fs.unlinkSync(link);
        } catch {
          /* não chegou a ser criada */
        }
      }
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")("Windows: /c/..., \\\\?\\, stream, ponto no fim e maiúsculas", { timeout: 60_000 }, () => {
    sb = makeSandbox({ branch: "main" });
    const s = sb;
    s.write(".beads/tasks/api-a/main.yaml", definition("A", "2026-10-01T10:00:00Z"));
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "a");
    s.git("checkout", "-q", "-b", "feat/x");
    const view = path.join(s.dir, ".beads", "active.yaml");
    const msys = `/${view[0]!.toLowerCase()}${view.slice(2).replace(/\\/g, "/")}`;
    for (const p of [
      msys,
      `\\\\?\\${view}`,
      ".beads/active.yaml.",
      ".beads/active.yaml ",
      ".beads/active.yaml::$DATA",
      ".BEADS\\TASKS\\api-a\\main.yaml",
      ".beads/TASKS/novo/main.yaml",
      ".beads/tasks/api-a/MAIN.yaml",
      ".beads/ARCHIVE/completed.yaml",
      view.toUpperCase(),
    ]) {
      expect(denied(run(s, "Write", p)), p).toBe(true);
    }
    expect(denied(run(s, "Write", ".beads/tasks/api-a/feat-x.yaml."))).toBe(false);
  });
});
