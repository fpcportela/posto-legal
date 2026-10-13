import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { load } from "js-yaml";
import { run } from "./beads-cmd.mjs";
import { beads, BEAD_A, entriesOf, noHooks, tasks, useKit, withBeadA as withBeadAIn } from "./beads-cmd-kit.js";
import { clean, commitAll, commitTry, entry, FLOW_NOW, SLOW, type RunResult, type Sandbox } from "./beads-sandbox.js";

// O comando `beads` (fase 2 da #37), como subprocesso, num repo descartável SEM
// node_modules. C1–C4 e C9: o comando escreve (new e as entradas, CRLF, horário, a entrada gerada). Contrato: aiteam/docs/beads-schema.md §12.

const kit = useKit();
const withBeadA = (opts: { hooks?: boolean } = {}) => withBeadAIn(kit, opts);

describe("C1 — new", () => {
  it("cria a pasta com a definição e a primeira entrada; o commit passa no pre-commit sem node_modules", SLOW, () => {
    const s = kit.repo();
    const r = beads(s, [
      "new", "api-login", "--title", "Login form", "--desc", "Formulário de login", "--effort", "m", "--model", "opus",
      "--tags", "auth,ui", "--files", "src/a.ts,src/b.ts", "--start", "--stage", "implement",
    ]);
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toContain("[beads] ✓ api-login: in_progress → .beads/tasks/api-login/main.yaml");
    expect(s.read(".beads/tasks/api-login/main.yaml")).toBe(
      [
        'title: "Login form"',
        'description: "Formulário de login"',
        'effort: "M"',
        'impl_model: "opus"',
        "related_files:",
        '  - "src/a.ts"',
        '  - "src/b.ts"',
        "tags:",
        '  - "auth"',
        '  - "ui"',
        `created_at: "${FLOW_NOW}"`,
        "entries:",
        `  - at: "${FLOW_NOW}"`,
        '    status: "in_progress"',
        '    stage: "implement"',
        "",
      ].join("\n")
    );
    // o comando regenera as visões, e o commit passa no pre-commit
    expect((load(s.read(".beads/active.yaml")) as any).tasks.map((t: any) => t.id)).toEqual(["api-login"]);
    const c = commitTry(s, "bead novo pelo comando");
    expect(c.status, c.out).toBe(0);
    expect(c.out).toMatch(/arquivo\(s\) de bead staged conferido/);
    expect(clean(s)).toBe("");
  });

  it("sem --start a primeira entrada é pending; --json devolve o resultado", SLOW, () => {
    const s = kit.repo();
    const r = beads(s, ["new", "orch-x", "--title", "X", "--json"]);
    expect(r.status, r.out).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, command: "new", id: "orch-x", status: "pending", path: ".beads/tasks/orch-x/main.yaml", at: FLOW_NOW });
    expect(entriesOf(s, ".beads/tasks/orch-x/main.yaml")).toEqual([{ at: FLOW_NOW, status: "pending" }]);
  });
});

describe("C2 — os subcomandos, e o commit passa no pre-commit", () => {
  it("new, start, stage, block, unblock, note, set, done: cada um acrescenta no fim, com o horário sempre à frente", SLOW, () => {
    const s = kit.repo();
    const step = (args: string[]) => {
      const r = beads(s, args);
      expect(r.status, `${args.join(" ")}\n${r.out}`).toBe(0);
      return r;
    };
    step(["new", "api-flow", "--title", "Flow", "--tags", "alfa"]);
    step(["start", "api-flow", "--stage", "plan"]);
    step(["stage", "api-flow", "implement"]);
    step(["block", "api-flow", "--on", "api-outro", "--note", "espera o endpoint"]);
    step(["unblock", "api-flow"]);
    step(["note", "api-flow", "rodei", "a", "migração", "local"]);
    step(["set", "api-flow", "--effort", "L", "--tags", "alfa,beta", "--phase", "2"]);
    const done = step(["done", "api-flow", "--summary", "Feito e testado.", "--tags", "alfa"]);
    expect(done.stdout).toContain("✓ api-flow: completed");

    const rel = ".beads/tasks/api-flow/main.yaml";
    const list = entriesOf(s, rel);
    expect(list.map((e) => e["status"] ?? e["stage"] ?? e["note"] ?? "set")).toEqual([
      "pending", "in_progress", "implement", "blocked", "in_progress", "rodei a migração local", "set", "completed",
    ]);
    expect(list[3]).toMatchObject({ blockers: ["api-outro"], note: "espera o endpoint" });
    expect(list[4]).toMatchObject({ blockers: [] });
    expect(list[6]).toMatchObject({ effort: "L", tags: ["alfa", "beta"], phase: 2 });
    expect(list[7]).toMatchObject({ context_summary: "Feito e testado.", tags: ["alfa"] });
    // o horário sempre vence o anterior (BEADS_NOW fixo: +1 s a cada entrada)
    const ats = list.map((e) => Date.parse(e.at));
    for (let i = 1; i < ats.length; i++) expect(ats[i]!).toBeGreaterThan(ats[i - 1]!);

    const c = commitTry(s, "tudo pelo comando");
    expect(c.status, c.out).toBe(0);
    const idx = (load(s.read(".beads/index.yaml")) as any[]).find((e) => e.id === "api-flow");
    expect(idx).toMatchObject({ status: "completed", effort: "L" });
  });

  it("show mostra o estado combinado e a linha do tempo; list e path respondem", SLOW, () => {
    const s = withBeadA();
    expect(beads(s, ["note", "api-a", "primeira"]).status).toBe(0);
    const show = beads(s, ["show", "api-a"]);
    expect(show.status, show.out).toBe(0);
    expect(show.stdout).toContain("api-a — Bead A");
    expect(show.stdout).toMatch(/status: in_progress/);
    expect(show.stdout).toMatch(/linha do tempo:/);
    expect(show.stdout).toMatch(/main\.yaml\s+entrada: note=primeira/);
    const j = JSON.parse(beads(s, ["show", "api-a", "--json"]).stdout);
    expect(j).toMatchObject({ ok: true, id: "api-a", status: "in_progress", branches: ["main"] });
    expect(j.timeline.map((t: any) => t.tipo)).toEqual(["definição", "entrada", "entrada"]);

    const list = beads(s, ["list"]);
    expect(list.stdout).toContain("api-a  in_progress  Bead A");
    expect(JSON.parse(beads(s, ["list", "--json", "--status", "pending"]).stdout).beads).toEqual([]);

    const p = beads(s, ["path", "api-novo"]);
    expect(p.status).toBe(0);
    expect(p.stdout.trim()).toBe(".beads/tasks/api-novo/main.yaml");
  });
});

// A-A10: start, unblock e block num bead concluído o reabrem — vale, mas avisa.
describe("A-A10 — reabrir um bead concluído", () => {
  it("start, unblock e block num bead concluído emitem o aviso de reabertura; note, stage e set não", SLOW, () => {
    const s = withBeadA();
    expect(beads(s, ["done", "api-a", "--summary", "Feito."]).status).toBe(0);
    for (const args of [["start", "api-a"], ["unblock", "api-a"], ["block", "api-a", "--on", "api-x"]]) {
      // volta a concluído entre as tentativas
      expect(beads(s, ["done", "api-a", "--summary", "Feito de novo."]).status).toBe(0);
      const r = beads(s, args);
      expect(r.status, `${args.join(" ")}\n${r.out}`).toBe(0);
      expect(r.stdout).toMatch(/⚠ o bead api-a está concluído \(em \d{4}-\d{2}-\d{2}T[\d:]+Z\) — esta entrada o reabre/);
    }
    expect(beads(s, ["done", "api-a", "--summary", "Fechado."]).status).toBe(0);
    for (const args of [["note", "api-a", "x"], ["stage", "api-a", "review"], ["set", "api-a", "--effort", "S"]]) {
      const r = beads(s, args);
      expect(r.status, `${args.join(" ")}\n${r.out}`).toBe(0);
      expect(r.stdout).not.toMatch(/reabre/);
    }
    // um bead em andamento não avisa nada
    const w = withBeadA();
    expect(beads(w, ["start", "api-a"]).stdout).not.toMatch(/reabre/);
  });
});

describe("C3 — a quebra de linha do arquivo", () => {
  it("CRLF continua CRLF e só o fim cresce", SLOW, () => {
    const s = kit.repo();
    noHooks(s);
    const crlf = BEAD_A.replace(/\n/g, "\r\n");
    s.write(".beads/tasks/api-a/main.yaml", crlf);
    commitAll(s, "bead A em CRLF");
    const r = beads(s, ["note", "api-a", "ação Tier 2"]);
    expect(r.status, r.out).toBe(0);
    const after = fs.readFileSync(path.join(s.dir, ".beads/tasks/api-a/main.yaml"), "utf8");
    expect(after.startsWith(crlf)).toBe(true);
    expect(after.slice(crlf.length)).toBe(`  - at: "2026-10-09T12:00:00Z"\r\n    note: "ação Tier 2"\r\n`);
    // LF continua LF
    const lf = kit.repo();
    noHooks(lf);
    lf.write(".beads/tasks/api-a/main.yaml", BEAD_A);
    commitAll(lf, "bead A");
    expect(beads(lf, ["note", "api-a", "x"]).status).toBe(0);
    expect(fs.readFileSync(path.join(lf.dir, ".beads/tasks/api-a/main.yaml"), "utf8")).not.toContain("\r");
  });
});

describe("C4 — o horário vence as asserções anteriores", () => {
  it("relógio atrasado: o at fica 1 s depois da maior asserção, com aviso acima de 5 min", SLOW, () => {
    const s = withBeadA();
    // o bead tem uma asserção 10 min à frente do "agora" desta chamada
    const future = "2026-10-09T12:10:00Z";
    s.write(".beads/tasks/api-a/main.yaml", `${BEAD_A}${entry(future, { note: "de um relógio adiantado" })}`);
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "relógio adiantado");
    const r = beads(s, ["note", "api-a", "depois"]);
    expect(r.status, r.out).toBe(0);
    expect(entriesOf(s, ".beads/tasks/api-a/main.yaml").at(-1)!.at).toBe("2026-10-09T12:10:01Z");
    expect(r.stdout).toMatch(/⚠ .*à frente do relógio/);
  });

  it("asserção a mais de 24 h no futuro: não há horário válido que a vença, e nada é escrito", SLOW, () => {
    const s = withBeadA();
    // exatamente agora + 24 h: ainda vale, mas 1 s depois já passaria do limite
    s.write(".beads/tasks/api-a/main.yaml", `${BEAD_A}${entry("2026-10-10T12:00:00Z", { note: "24 h à frente" })}`);
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "24 h à frente");
    const before = s.read(".beads/tasks/api-a/main.yaml");
    const r = beads(s, ["note", "api-a", "x"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/24 h no futuro/);
    expect(s.read(".beads/tasks/api-a/main.yaml")).toBe(before);
  });
});

describe("C9 — a entrada gerada", () => {
  it("done: a entrada exata no fim do arquivo", SLOW, () => {
    const s = withBeadA();
    expect(beads(s, ["done", "api-a", "--summary", "Feito: com \"aspas\" e dois-pontos."]).status).toBe(0);
    const text = s.read(".beads/tasks/api-a/main.yaml");
    expect(text.startsWith(BEAD_A)).toBe(true);
    expect(text.slice(BEAD_A.length)).toBe(
      `  - at: "${FLOW_NOW}"\n    status: "completed"\n    context_summary: "Feito: com \\"aspas\\" e dois-pontos."\n`
    );
  });

  it("um adendo (o bead veio de outra branch): o arquivo novo começa por entries", SLOW, () => {
    const s = withBeadA();
    s.git("checkout", "-q", "-b", "feat/x");
    const r = beads(s, ["block", "api-a", "--on", "api-b,api-c"]);
    expect(r.status, r.out).toBe(0);
    expect(s.read(".beads/tasks/api-a/feat-x.yaml")).toBe(
      `entries:\n  - at: "${FLOW_NOW}"\n    status: "blocked"\n    blockers:\n      - "api-b"\n      - "api-c"\n`
    );
    expect(r.stdout).toMatch(/⚠ o blocker "api-b" não casa/);
  });
});

// §3.5: o card de origem entra na definição pelo comando — `--trello` (um shortLink, ou vários
// separados por vírgula) e `--trello-scope partial` —, e o valor passa pelo mesmo validador do núcleo.
describe("C10 — trello e trello_scope na definição", () => {
  const REL = ".beads/tasks/orch-card/main.yaml";

  it("new grava o shortLink, a lista e a marca na ordem do contrato", SLOW, () => {
    const one = kit.repo();
    expect(beads(one, ["new", "orch-card", "--title", "Card", "--trello", "97e1Chex"]).status).toBe(0);
    expect(one.read(REL)).toBe(
      ['title: "Card"', 'trello: "97e1Chex"', `created_at: "${FLOW_NOW}"`, "entries:", `  - at: "${FLOW_NOW}"`, '    status: "pending"', ""].join("\n")
    );

    const many = kit.repo();
    const r = beads(many, ["new", "orch-card", "--title", "Card", "--trello", "0nU0fBM1,68wGTstW", "--trello-scope", "partial"]);
    expect(r.status, r.out).toBe(0);
    expect(many.read(REL)).toBe(
      [
        'title: "Card"',
        "trello:",
        '  - "0nU0fBM1"',
        '  - "68wGTstW"',
        'trello_scope: "partial"',
        `created_at: "${FLOW_NOW}"`,
        "entries:",
        `  - at: "${FLOW_NOW}"`,
        '    status: "pending"',
        "",
      ].join("\n")
    );
  });

  it("new recusa a URL, o valor fora do enum e a marca sem o card — e não escreve nada", SLOW, () => {
    const s = kit.repo();
    const url = beads(s, ["new", "orch-card", "--title", "Card", "--trello", "https://trello.com/c/97e1Chex"]);
    expect(url.status).toBe(1);
    expect(url.stderr).toMatch(/trello.*shortLink/);
    const full = beads(s, ["new", "orch-card", "--title", "Card", "--trello", "97e1Chex", "--trello-scope", "full"]);
    expect(full.status).toBe(1);
    expect(full.stderr).toMatch(/trello_scope.*partial/);
    const orphan = beads(s, ["new", "orch-card", "--title", "Card", "--trello-scope", "partial"]);
    expect(orphan.status).toBe(1);
    expect(orphan.stderr).toMatch(/trello_scope.*trello/);
    expect(s.exists(REL)).toBe(false);
  });

  it("set acrescenta o card como entrada; uma lista nova substitui a antiga inteira", SLOW, () => {
    const s = withBeadA();
    const rel = ".beads/tasks/api-a/main.yaml";
    expect(beads(s, ["set", "api-a", "--trello-scope", "partial"]).status).toBe(1); // sem card ainda
    expect(beads(s, ["set", "api-a", "--trello", "97e1Chex"]).status).toBe(0);
    expect(beads(s, ["set", "api-a", "--trello-scope", "partial"]).status).toBe(0);
    expect(beads(s, ["set", "api-a", "--trello", "97e1Chex,68wGTstW"]).status).toBe(0);
    const list = entriesOf(s, rel);
    expect(list.slice(-3).map(({ at: _at, ...campos }) => campos)).toEqual([
      { trello: "97e1Chex" },
      { trello_scope: "partial" },
      { trello: ["97e1Chex", "68wGTstW"] },
    ]);
    const shown = JSON.parse(beads(s, ["show", "api-a", "--json"]).stdout);
    expect(shown.fields).toMatchObject({ trello: ["97e1Chex", "68wGTstW"], trello_scope: "partial" });
    expect(beads(s, ["show", "api-a"]).stdout).toMatch(/trello: 97e1Chex, 68wGTstW \(partial\)/);
  });
});

describe("run() em processo — o mesmo contrato de saída", () => {
  it("código 2 para uso errado, 0 para ajuda; a saída por linha", SLOW, () => {
    const s = withBeadA();
    const ctx = { cwd: s.dir, env: { ...s.env } };
    expect(run([], ctx).code).toBe(2);
    expect(run(["--help"], ctx).code).toBe(0);
    expect(run(["note", "api-a"], ctx).code).toBe(2);
    const ok = run(["note", "api-a", "em processo", "--no-views"], ctx);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toEqual(["[beads] ✓ api-a: in_progress → .beads/tasks/api-a/main.yaml"]);
    expect(run(["note", "api-a", "x", "--quiet", "--no-views"], ctx)).toMatchObject({ code: 0, stdout: [] });
  });
});
