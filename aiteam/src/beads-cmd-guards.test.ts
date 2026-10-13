import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { load } from "js-yaml";
import { run } from "./beads-cmd.mjs";
import { beads, BEAD_A, entriesOf, noHooks, tasks, useKit, withBeadA as withBeadAIn } from "./beads-cmd-kit.js";
import { SLOW, T, type Sandbox } from "./beads-sandbox.js";

// O comando `beads` (fase 2 da #37), como subprocesso, num repo descartável SEM
// node_modules. C5 e C7: o comando recusa, e nada é escrito. Contrato: aiteam/docs/beads-schema.md §12.

const kit = useKit();
const withBeadA = (opts: { hooks?: boolean } = {}) => withBeadAIn(kit, opts);

describe("C5 — recusas: nada é escrito", () => {
  const nothing = (s: Sandbox) => expect(tasks(s)).toBe("");

  it("modo legado, HEAD destacado e branch fora do charset", SLOW, () => {
    const legacy = kit.repo({ legacy: true });
    legacy.write(".beads/active.yaml", 'version: "1.0"\nbranch: "main"\ntasks: []\n');
    legacy.git("add", "-A");
    legacy.git("commit", "-q", "--no-verify", "-m", "legado");
    const l = beads(legacy, ["new", "api-x", "--title", "X"]);
    expect(l.status).toBe(1);
    expect(l.stderr).toMatch(/modo legado/);
    expect(l.stderr).toMatch(/migrate-beads\.mjs --dry-run/);
    expect(legacy.exists(".beads/tasks")).toBe(false);
    // status é só informação: não recusa, e o board pode chamá-lo num consumidor legado
    const st = beads(legacy, ["status", "--json"]);
    expect(st.status, st.out).toBe(0);
    expect(JSON.parse(st.stdout)).toMatchObject({ ok: true, legacy: true });

    const s = withBeadA();
    s.git("checkout", "-q", "--detach");
    const d = beads(s, ["note", "api-a", "x"]);
    expect(d.status).toBe(1);
    expect(d.stderr).toMatch(/HEAD destacado/);
    nothing(s);

    s.git("checkout", "-q", "-b", "feat/ação");
    const c = beads(s, ["note", "api-a", "x"]);
    expect(c.status).toBe(1);
    expect(c.stderr).toMatch(/caractere fora de \[A-Za-z0-9\._\/-\]/);
    nothing(s);
  });

  it("id inválido ou que só difere em maiúsculas", SLOW, () => {
    const s = withBeadA();
    for (const id of ["a b", "con", "../x", "api..x", "-x"]) {
      const r = beads(s, ["new", id, "--title", "T"]);
      expect(r.status, `${id}: ${r.out}`).toBe(1);
    }
    const twin = beads(s, ["new", "API-A", "--title", "T"]);
    expect(twin.status).toBe(1);
    expect(twin.stderr).toMatch(/api-a já existe.*ignorando maiúsculas/);
    const note = beads(s, ["note", "API-A", "x"]);
    expect(note.status).toBe(1);
    expect(note.stderr).toMatch(/existe como "api-a"/);
    // num disco que ignora maiúsculas, exists("API-A") abriria a pasta api-a: os nomes vêm do readdir
    expect(fs.readdirSync(path.join(s.dir, ".beads", "tasks"))).toEqual(["api-a"]);
    nothing(s);
  });

  it("texto com mais de uma linha, com HTML ou com controle; done sem --summary", SLOW, () => {
    const s = withBeadA();
    const multi = beads(s, ["new", "api-m", "--title", "linha 1\nlinha 2"]);
    expect(multi.status).toBe(1);
    expect(multi.stderr).toMatch(/mais de uma linha/);
    expect(beads(s, ["new", "api-m", "--title", "T", "--desc", "<b>negrito</b>"]).stderr).toMatch(/contém HTML/);
    expect(beads(s, ["note", "api-a", "a\u0007b"]).status).toBe(1);
    const done = beads(s, ["done", "api-a"]);
    expect(done.status).toBe(1);
    expect(done.stderr).toMatch(/done exige --summary/);
    expect(beads(s, ["done", "api-a", "--summary", "  "]).status).toBe(1);
    nothing(s);
  });

  it("injeção de YAML: o valor entra escapado e não vira estrutura", SLOW, () => {
    const s = withBeadA();
    const evil = 'x"; status: "completed"; y: [';
    const r = beads(s, ["note", "api-a", evil]);
    expect(r.status, r.out).toBe(0);
    const last = entriesOf(s, ".beads/tasks/api-a/main.yaml").at(-1)!;
    expect(last["note"]).toBe(evil);
    expect(Object.keys(last).sort()).toEqual(["at", "note"]);
    expect((load(s.read(".beads/active.yaml")) as any)?.tasks?.[0]?.status ?? "in_progress").toBe("in_progress");
  });

  it("erros de uso saem com 2", SLOW, () => {
    const s = withBeadA();
    const codes = [
      [],
      ["frobnicate"],
      ["note"],
      ["note", "api-a", "x", "--nope"],
      ["new", "api-z"],
      ["new", "api-z", "--title", "T", "--effort", "X"],
      ["new", "api-z", "--title", "T", "--stage", "plan"],
      ["block", "api-a"],
      ["set", "api-a"],
      ["stage", "api-a"],
      ["status", "--since", "abc"],
    ].map((a) => beads(s, a).status);
    expect(codes).toEqual(Array(codes.length).fill(2));
    expect(beads(s, ["--help"]).status).toBe(0);
    nothing(s);
  });

  it("tag fora do índice gera aviso com as parecidas, sem recusar", SLOW, () => {
    const s = kit.repo();
    noHooks(s);
    expect(beads(s, ["new", "api-t", "--title", "T", "--tags", "auth,infra"]).status).toBe(0);
    const r = beads(s, ["done", "api-t", "--summary", "ok", "--tags", "auht"]);
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toMatch(/⚠ a tag "auht" não está no índice — parecidas: auth/);
    const novo = beads(s, ["note", "api-t", "x"]);
    expect(novo.status).toBe(0);
  });
});

// ── Rodada de correção do QA (fase 2 da #37) ─────────────────────────────────

describe("C5b — valores de lista, vazios e o `--`", () => {
  const nothing = (s: Sandbox) => expect(tasks(s)).toBe("");

  // A-R3: o texto de cada item de uma lista passa pelas mesmas regras do texto livre.
  it("A-R3: tags, files, phase e blockers com quebra de linha, controle ou HTML são recusados", SLOW, () => {
    const s = withBeadA();
    const cases: string[][] = [
      ["new", "api-n", "--title", "T", "--tags", "bom,ru\nim"],
      ["new", "api-n", "--title", "T", "--files", "src/a.ts,<b>x</b>"],
      ["new", "api-n", "--title", "T", "--phase", "fase\n1"],
      ["set", "api-a", "--tags", "a,b\u0007c"],
      ["set", "api-a", "--files", "<script>x</script>"],
      ["block", "api-a", "--on", "api-b,api\nc"],
      ["done", "api-a", "--summary", "ok", "--tags", "a,<i>b</i>"],
    ];
    for (const args of cases) {
      const r = beads(s, args);
      expect(r.status, `${args.join(" ")}\n${r.out}`).toBe(1);
      expect(r.stderr).toMatch(/mais de uma linha|caractere de controle|contém HTML/);
    }
    nothing(s);
    expect(s.exists(".beads/tasks/api-n")).toBe(false);
  });

  // A-R4: valor vazio ou só com espaços não é valor.
  it("A-R4: --title \"\", stage x \"  \", --desc, --note, --tags \"\" e id vazio são recusados", SLOW, () => {
    const s = withBeadA();
    const cases: string[][] = [
      ["new", "api-v", "--title", ""],
      ["new", "api-v", "--title", "   "],
      ["new", "api-v", "--title", "T", "--desc", "  "],
      ["stage", "api-a", "  "],
      ["stage", "api-a", ""],
      ["start", "api-a", "--stage", " "],
      ["block", "api-a", "--on", "api-b", "--note", " "],
      ["block", "api-a", "--on", " , "],
      ["set", "api-a", "--title", ""],
      ["set", "api-a", "--tags", ""],
      ["note", "api-a", " "],
    ];
    for (const args of cases) {
      const r = beads(s, args);
      expect(r.status, `${JSON.stringify(args)}\n${r.out}`).toBe(1);
      expect(r.stderr).toMatch(/vazio|só com espaços|em branco/);
    }
    nothing(s);
  });

  // A-R5: texto que começa com `-` não é flag: o `--` o separa.
  it("A-R5: a mensagem de uso explica o `--`, e `note <id> -- --texto` grava o texto", SLOW, () => {
    const s = withBeadA();
    const bad = beads(s, ["note", "api-a", "--texto-que-parece-flag"]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/--texto-que-parece-flag/);
    expect(bad.stderr).toMatch(/texto que começa com "-".*"--"/);
    expect(beads(s, ["--help"]).stdout).toMatch(/começa com -.*use `--`/);

    const ok = beads(s, ["note", "api-a", "--", "--texto-que-parece-flag"]);
    expect(ok.status, ok.out).toBe(0);
    expect(entriesOf(s, ".beads/tasks/api-a/main.yaml").at(-1)!["note"]).toBe("--texto-que-parece-flag");
    // --flag=valor também serve para o valor de uma flag
    const eq = beads(s, ["stage", "api-a", "--", "-implementar"]);
    expect(eq.status, eq.out).toBe(0);
    expect(entriesOf(s, ".beads/tasks/api-a/main.yaml").at(-1)!["stage"]).toBe("-implementar");
  });
});

describe("C5c — confinamento e erros do disco", () => {
  // A-A2: uma pasta de bead que é junção (Windows) ou link (Linux) para fora do repo
  // não é lida pelo listBeadIds, mas o mkdir recursivo a atravessava e o `wx` gravava lá.
  it("A-A2: junção em .beads/tasks/<id> apontando para fora: new recusa e nada é escrito fora", SLOW, () => {
    const s = withBeadA();
    const outside = `${s.dir}-fora`;
    fs.mkdirSync(outside, { recursive: true });
    try {
      let linked = true;
      try {
        fs.symlinkSync(outside, path.join(s.dir, ".beads", "tasks", "orch-link"), "junction");
      } catch {
        linked = false; // sem permissão para link: não há o que provar aqui
      }
      if (!linked) {
        // Junção no Windows não pede permissão: lá o teste tem de ter rodado de verdade.
        expect(process.platform).not.toBe("win32");
        return;
      }
      const r = beads(s, ["new", "orch-link", "--title", "Fora"]);
      expect(r.status, r.out).toBe(1);
      expect(r.stderr).toMatch(/link|junção|fora de \.beads\/tasks/);
      expect(fs.readdirSync(outside)).toEqual([]);
      const n = beads(s, ["note", "orch-link", "x"]);
      expect(n.status).toBe(1);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(path.join(s.dir, ".beads", "tasks", "orch-link"), { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // A-novo: o confine() só olhava `.beads/tasks` e a pasta do id. Com o próprio `.beads` virando
  // junção (ou link) para fora e sem `tasks/` lá, não havia nada a conferir e o `new` gravava fora.
  it("A-novo: .beads virando junção para fora do repo, sem tasks/: new recusa e nada é escrito fora", SLOW, () => {
    const s = kit.repo();
    noHooks(s);
    const outside = `${s.dir}-fora2`;
    fs.mkdirSync(outside, { recursive: true });
    const beadsDir = path.join(s.dir, ".beads");
    try {
      fs.rmSync(beadsDir, { recursive: true, force: true });
      let linked = true;
      try {
        fs.symlinkSync(outside, beadsDir, "junction");
      } catch {
        linked = false;
      }
      if (!linked) {
        expect(process.platform).not.toBe("win32");
        return;
      }
      const r = beads(s, ["new", "orch-fora", "--title", "Fora"]);
      expect(r.status, r.out).toBe(1);
      expect(r.stderr).toMatch(/\.beads é um link|junção|fora do repositório/);
      expect(fs.readdirSync(outside)).toEqual([]);
      for (const args of [["note", "orch-fora", "x"], ["path", "orch-fora"]]) {
        const n = beads(s, args);
        expect(n.status, args.join(" ")).toBe(args[0] === "path" ? 0 : 1);
      }
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(beadsDir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // A-A6: um id de 300 caracteres dava ENOENT do mkdir, sem tratamento.
  it("A-A6: id longo demais é recusado com mensagem, e erro de disco vira recusa (não uma pilha)", SLOW, () => {
    const s = withBeadA();
    const long = `api-${"x".repeat(300)}`;
    const r = beads(s, ["new", long, "--title", "T"]);
    expect(r.status, r.out).toBe(1);
    expect(r.stderr).toMatch(/passa de \d+ caracteres/);
    expect(r.stderr).not.toMatch(/at .*\.mjs|ENOENT/);
    // o limite vale também para os outros subcomandos e para o path
    expect(beads(s, ["note", long, "x"]).status).toBe(1);
    expect(beads(s, ["path", long]).status).toBe(1);
    // o caminho todo (id + arquivo da branch) também tem teto
    s.git("checkout", "-q", "-b", `feat/${"b".repeat(150)}`);
    const wide = beads(s, ["new", `api-${"y".repeat(90)}`, "--title", "T"]);
    expect(wide.status, wide.out).toBe(1);
    expect(wide.stderr).toMatch(/caminho .* passa de \d+ caracteres/);
    expect(tasks(s)).toBe("");
  });
});

describe("C7 — edição no meio do próprio arquivo", () => {
  it("o arquivo editado no meio em relação a HEAD recusa o acréscimo, sem mexer nele", SLOW, () => {
    const s = withBeadA();
    const edited = BEAD_A.replace('"in_progress"', '"blocked"');
    s.write(".beads/tasks/api-a/main.yaml", edited);
    const r = beads(s, ["note", "api-a", "x"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/main\.yaml: o arquivo já foi editado no meio em relação a HEAD/);
    expect(s.read(".beads/tasks/api-a/main.yaml")).toBe(edited);
  });

  it("um campo anexado à última entrada (R6) também é visto como edição", SLOW, () => {
    const s = withBeadA();
    const anexado = `${BEAD_A}    stage: "review"\n`;
    s.write(".beads/tasks/api-a/main.yaml", anexado);
    const r = beads(s, ["note", "api-a", "x"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/stage acrescentado à entrada 1/);
    expect(s.read(".beads/tasks/api-a/main.yaml")).toBe(anexado);
  });
});
