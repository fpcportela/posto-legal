import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseUpstreamMarker } from "./root-files-core.mjs";
import { buildFixture, copyConsumer as copyOf, git, init, makeTmp, type Shas } from "./root-files-kit.js";
import { runMarkerCommand } from "./upstream-marker-cli.mjs";

// aiteam/scripts/upstream-marker.mjs (rb-ai-team#39): o aiteam/ é um checkout do upstream, então o
// consumidor não compartilha histórico com ele e "o que mudou desde o último sync" só se mede se o sync
// registrar de que commit veio. `write` grava aiteam/UPSTREAM; `changes` mede a partir dele.

const { tmp, cleanup } = makeTmp();
afterAll(cleanup);

let consumerDir = "";
let shas: Shas;
beforeAll(() => {
  ({ consumerDir, shas } = buildFixture(tmp, Date.now()));
}, 120_000);

const copyConsumer = (): string => copyOf(tmp, consumerDir);
const markerFile = (dir: string): string => path.join(dir, "aiteam", "UPSTREAM");

describe("upstream-marker write", () => {
  it("grava aiteam/UPSTREAM com o commit e a data da ponta do upstream, no formato que o doctor e o sync leem", () => {
    const dir = copyConsumer();
    const r = runMarkerCommand(dir, ["write"]);
    expect(r).toMatchObject({ code: 0, err: "" });
    expect(r.out).toContain(`aiteam/UPSTREAM: ${shas.c6.slice(0, 7)} (upstream/main)`);
    const parsed = parseUpstreamMarker(fs.readFileSync(markerFile(dir), "utf8"));
    expect(parsed).toMatchObject({ state: "ok", commit: shas.c6 });
    expect(parsed.state === "ok" && parsed.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("grava com LF e termina em nova linha (um arquivo que o git não vai reclamar de normalizar)", () => {
    const dir = copyConsumer();
    runMarkerCommand(dir, ["write"]);
    const text = fs.readFileSync(markerFile(dir), "utf8");
    expect(text).not.toContain("\r");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("rodar de novo é idempotente: o mesmo conteúdo", () => {
    const dir = copyConsumer();
    runMarkerCommand(dir, ["write"]);
    const first = fs.readFileSync(markerFile(dir), "utf8");
    runMarkerCommand(dir, ["write"]);
    expect(fs.readFileSync(markerFile(dir), "utf8")).toBe(first);
  });

  it("--ref grava o commit de outra ref (um sync que parou antes da ponta)", () => {
    const dir = copyConsumer();
    git(dir, ["update-ref", "refs/remotes/upstream/release", shas.c3]);
    const r = runMarkerCommand(dir, ["write", "--ref", "upstream/release"]);
    expect(r.code).toBe(0);
    expect(parseUpstreamMarker(fs.readFileSync(markerFile(dir), "utf8"))).toMatchObject({ state: "ok", commit: shas.c3 });
  });

  it("--ref que o clone não tem → erro e nenhum arquivo escrito", () => {
    const dir = copyConsumer();
    const r = runMarkerCommand(dir, ["write", "--ref", "upstream/nao-existe"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/upstream\/nao-existe não existe neste clone/);
    expect(fs.existsSync(markerFile(dir))).toBe(false);
  });

  it("sem o remote upstream → erro que diz como criá-lo, sem escrever nada", () => {
    const dir = tmp("plain");
    init(dir);
    const r = runMarkerCommand(dir, ["write"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/git remote add upstream/);
    expect(fs.existsSync(markerFile(dir))).toBe(false);
  });

  it("o remote do rb-ai-team tem outro nome → o erro diz qual e sugere o git remote rename", () => {
    const dir = copyConsumer();
    git(dir, ["remote", "rename", "upstream", "rb-ai-team"]);
    git(dir, ["remote", "set-url", "rb-ai-team", "git@github.com:thiagoriosbraz/rb-ai-team.git"]);
    const r = runMarkerCommand(dir, ["write"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("git remote rename rb-ai-team upstream");
    expect(fs.existsSync(markerFile(dir))).toBe(false);
  });

  it("o remote existe, mas nada foi buscado → erro que manda o git fetch upstream (quem roda é o usuário)", () => {
    const dir = tmp("nofetch");
    init(dir);
    git(dir, ["remote", "add", "upstream", consumerDir]);
    const r = runMarkerCommand(dir, ["write"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/git fetch upstream/);
    expect(fs.existsSync(markerFile(dir))).toBe(false);
  });
});

describe("upstream-marker changes", () => {
  it("sem aiteam/UPSTREAM: diz que não dá para medir, manda conferir tudo e como gravar o marcador", () => {
    const dir = copyConsumer();
    const r = runMarkerCommand(dir, ["changes"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/não dá para medir/);
    expect(r.out).toMatch(/todos/);
    expect(r.out).toContain("node aiteam/scripts/upstream-marker.mjs write");
  });

  it("com o marcador de um sync antigo: lista os commits que tocaram a raiz desde então", () => {
    const dir = copyConsumer();
    fs.mkdirSync(path.join(dir, "aiteam"), { recursive: true });
    fs.writeFileSync(markerFile(dir), `commit: ${shas.c1}\ndate: 2026-01-01\n`);
    const r = runMarkerCommand(dir, ["changes"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/3 commit\(s\) do upstream tocaram arquivos de raiz/);
    expect(r.out).toContain("c3: SCHEMA.md vira apontador");
    expect(r.out).toContain("`.beads/SCHEMA.md`");
    expect(r.out).not.toContain("c2: só docs");
    expect(r.out).not.toContain("c5: só aiteam/src");
  });

  it("o marcador gravado com BOM (Out-File do PowerShell 5) é lido: mede em vez de dizer que está malformado", () => {
    const dir = copyConsumer();
    fs.mkdirSync(path.join(dir, "aiteam"), { recursive: true });
    fs.writeFileSync(markerFile(dir), `\uFEFFcommit: ${shas.c1}\r\ndate: 2026-01-01\r\n`);
    const r = runMarkerCommand(dir, ["changes"]);
    expect(r.out).toMatch(/3 commit\(s\) do upstream tocaram arquivos de raiz/);
    expect(r.out).not.toMatch(/não tem uma linha `commit: <sha>`/);
  });

  it("o marcador no commit atual: nada mudou", () => {
    const dir = copyConsumer();
    runMarkerCommand(dir, ["write"]);
    expect(runMarkerCommand(dir, ["changes"]).out).toMatch(/Nada mudou/);
  });

  it("o marcador aponta para um commit que o clone não tem: não dá para medir, e manda o fetch", () => {
    const dir = copyConsumer();
    fs.mkdirSync(path.join(dir, "aiteam"), { recursive: true });
    fs.writeFileSync(markerFile(dir), "commit: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n");
    const r = runMarkerCommand(dir, ["changes"]);
    expect(r.out).toMatch(/não dá para medir/);
    expect(r.out).toMatch(/git fetch upstream/);
  });

  it("não escreve nada: o marcador e o repo ficam como estavam", () => {
    const dir = copyConsumer();
    const before = git(dir, ["status", "--porcelain"]);
    runMarkerCommand(dir, ["changes"]);
    expect(git(dir, ["status", "--porcelain"])).toBe(before);
    expect(fs.existsSync(markerFile(dir))).toBe(false);
  });
});

describe("uso", () => {
  it("comando desconhecido ou ausente → status 2 e o uso", () => {
    for (const argv of [[], ["sync"], ["write", "--nada"], ["changes", "--ref"]]) {
      const r = runMarkerCommand(copyConsumer(), argv);
      expect(r.code, JSON.stringify(argv)).toBe(2);
      expect(r.err, JSON.stringify(argv)).toMatch(/uso: node aiteam\/scripts\/upstream-marker\.mjs/);
    }
  });
});

describe("o script e a regra de rede", () => {
  const script = path.resolve(import.meta.dirname, "..", "scripts", "upstream-marker.mjs");

  it("o script roda (os imports resolvem) e sem argumento sai com 2 e o uso", () => {
    const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/uso: node aiteam\/scripts\/upstream-marker\.mjs/);
  });

  it("o código da CLI não chama fetch, pull, ls-remote, clone nem push", () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "upstream-marker-cli.mjs"), "utf8");
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    expect(code).not.toMatch(/["'](fetch|pull|ls-remote|update|clone|push)["']/);
  });
});
