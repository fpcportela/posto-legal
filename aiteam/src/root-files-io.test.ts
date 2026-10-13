import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { load } from "js-yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkRootFilesUpstream, parseUpstreamMarker } from "./root-files-core.mjs";
import { gitRunner, measureRootChanges, readMarker, readRootFilesFacts, resolveUpstream, showAt } from "./root-files-io.mjs";
import {
  DAY,
  OLD_COPY,
  POINTER,
  WORKFLOW,
  buildFixture,
  commit,
  copyConsumer as copyOf,
  git,
  init,
  makeTmp,
  write,
  type Shas,
} from "./root-files-kit.js";

// A cola dos arquivos de raiz × upstream (rb-ai-team#39): o que o doctor lê do git e do disco. O
// doctor.mjs roda sobre o repo que contém aiteam/, então a leitura não se testa por ele; ela vive em
// root-files-io.mjs, e aqui roda de verdade, num repo "consumidor" temporário com um remote `upstream`
// que é outro repo temporário (root-files-kit.ts). O código sob teste nunca faz fetch.

const { tmp, cleanup } = makeTmp();
afterAll(cleanup);

let NOW = 0;
let upstreamDir = "";
let consumerDir = "";
let shas: Shas;
beforeAll(() => {
  NOW = Date.now();
  ({ upstreamDir, consumerDir, shas } = buildFixture(tmp, NOW));
}, 120_000);

const copyConsumer = (): string => copyOf(tmp, consumerDir);

describe("resolveUpstream — qual ref do upstream este clone tem", () => {
  it("sem o remote upstream → no-remote (um clone que só tem origin não ganha aviso)", () => {
    const dir = tmp("plain");
    init(dir);
    expect(resolveUpstream(gitRunner(dir))).toEqual({ state: "no-remote" });
  });

  it("o remote existe e nunca foi buscado → no-ref", () => {
    const dir = tmp("nofetch");
    init(dir);
    git(dir, ["remote", "add", "upstream", upstreamDir]);
    expect(resolveUpstream(gitRunner(dir))).toEqual({ state: "no-ref" });
  });

  it("remote com outro nome (o vigacapital chama o seu de rb-ai-team) → no-remote: o guia manda `upstream`", () => {
    const dir = copyConsumer();
    git(dir, ["remote", "rename", "upstream", "rb-ai-team"]);
    expect(resolveUpstream(gitRunner(dir))).toEqual({ state: "no-remote" });
  });

  // QA da #39 (A11): o vigacapital chama o remote de `rb-ai-team`. O doctor só procura `upstream` (o guia manda esse
  // nome), mas em vez de calar diz qual remote parece ser o do framework e como renomeá-lo.
  describe("remote com outro nome que aponta para o rb-ai-team", () => {
    const withRemote = (name: string, url: string): string => {
      const dir = copyConsumer();
      git(dir, ["remote", "rename", "upstream", name]);
      git(dir, ["remote", "set-url", name, url]);
      return dir;
    };

    it.each([
      ["ssh", "git@github.com:thiagoriosbraz/rb-ai-team.git"],
      ["https com .git", "https://github.com/thiagoriosbraz/rb-ai-team.git"],
      ["https sem .git", "https://github.com/thiagoriosbraz/rb-ai-team"],
      ["barra no fim", "https://github.com/thiagoriosbraz/rb-ai-team/"],
      ["caminho local", "C:/devops/source/rb-ai-team"],
      ["caminho local do Windows", "C:\\devops\\source\\rb-ai-team"],
    ])("%s: acha o remote e devolve o nome em `alias`", (_nome, url) => {
      expect(resolveUpstream(gitRunner(withRemote("rb-ai-team", url)))).toEqual({ state: "no-remote", alias: "rb-ai-team" });
    });

    it("o nome do remote não importa: o URL é que diz (framework, fw...)", () => {
      expect(resolveUpstream(gitRunner(withRemote("fw", "git@github.com:thiagoriosbraz/rb-ai-team.git")))).toEqual({ state: "no-remote", alias: "fw" });
    });

    it("o origin nunca é sugerido (no clone do próprio framework o origin é o rb-ai-team)", () => {
      expect(resolveUpstream(gitRunner(withRemote("origin", "git@github.com:thiagoriosbraz/rb-ai-team.git")))).toEqual({ state: "no-remote" });
    });

    it.each([
      "git@github.com:thiagoriosbraz/outro-repo.git",
      "https://github.com/thiagoriosbraz/rb-ai-team-fork.git",
      "https://github.com/thiagoriosbraz/my-rb-ai-team",
      "https://github.com/thiagoriosbraz/vps-infra.git",
    ])("%s não é o rb-ai-team: sem alias", (url) => {
      expect(resolveUpstream(gitRunner(withRemote("outro", url)))).toEqual({ state: "no-remote" });
    });

    it("o remote upstream existindo vale: o alias só aparece quando falta o `upstream`", () => {
      const dir = copyConsumer();
      git(dir, ["remote", "add", "rb-ai-team", "git@github.com:thiagoriosbraz/rb-ai-team.git"]);
      expect(resolveUpstream(gitRunner(dir), { now: NOW })).toMatchObject({ state: "ok", ref: "upstream/main" });
    });

    it("o doctor, ponta a ponta: WARN com o git remote rename (e nada mais é comparado)", () => {
      const lines = checkRootFilesUpstream(readRootFilesFacts(withRemote("rb-ai-team", "git@github.com:thiagoriosbraz/rb-ai-team.git"), { yamlLoad: load }));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ pass: true, warn: true });
      expect(lines[0]?.detail).toContain("git remote rename rb-ai-team upstream");
    });
  });

  it("achou upstream/main, o sha da ponta e a idade do commit em dias", () => {
    expect(resolveUpstream(gitRunner(consumerDir), { now: NOW })).toEqual({ state: "ok", ref: "upstream/main", sha: shas.c6, ageDays: 5 });
  });

  it("a idade vem do commit, não do relógio de quem roda: `now` mais tarde, ref mais velha", () => {
    expect(resolveUpstream(gitRunner(consumerDir), { now: NOW + 100 * DAY })).toMatchObject({ state: "ok", ageDays: 105 });
  });

  it("só tem upstream/master → usa a master (o robo-pb-raspagem e o vigacapital são master)", () => {
    const dir = copyConsumer();
    git(dir, ["update-ref", "refs/remotes/upstream/master", shas.c6]);
    git(dir, ["update-ref", "-d", "refs/remotes/upstream/main"]);
    git(dir, ["symbolic-ref", "--delete", "refs/remotes/upstream/HEAD"]);
    expect(resolveUpstream(gitRunner(dir), { now: NOW })).toMatchObject({ state: "ok", ref: "upstream/master", sha: shas.c6 });
  });

  it("o HEAD simbólico do remote vale mais que main: a default do remote é a dele", () => {
    const dir = copyConsumer();
    git(dir, ["update-ref", "refs/remotes/upstream/trunk", shas.c3]);
    git(dir, ["symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/trunk"]);
    expect(resolveUpstream(gitRunner(dir), { now: NOW })).toMatchObject({ state: "ok", ref: "upstream/trunk", sha: shas.c3 });
  });

  it("sem HEAD simbólico e com a default fora de main/master → no-ref, nunca um chute", () => {
    const dir = copyConsumer();
    git(dir, ["update-ref", "refs/remotes/upstream/trunk", shas.c6]);
    git(dir, ["update-ref", "-d", "refs/remotes/upstream/main"]);
    git(dir, ["symbolic-ref", "--delete", "refs/remotes/upstream/HEAD"]);
    expect(resolveUpstream(gitRunner(dir))).toEqual({ state: "no-ref" });
  });

  it("não é um repo git → no-git, sem lançar", () => {
    expect(resolveUpstream(gitRunner(tmp("nogit")))).toEqual({ state: "no-git" });
  });
});

describe("showAt — um arquivo como o upstream o tem", () => {
  it("devolve o conteúdo na ref, e null para o que a ref não tem", () => {
    const run = gitRunner(consumerDir);
    expect(showAt(run, "upstream/main", ".beads/SCHEMA.md")).toBe(POINTER);
    expect(showAt(run, "upstream/main", "nao-existe.md")).toBeNull();
    expect(showAt(run, "upstream/nao-existe", "AGENTS.md")).toBeNull();
  });
});

describe("measureRootChanges — o que mudou na raiz desde o último sync", () => {
  const run = () => gitRunner(consumerDir);
  const marker = (commit: string) => parseUpstreamMarker(`commit: ${commit}\ndate: 2026-01-01\n`);

  it("lista só os commits que tocaram arquivos de raiz, do mais novo ao mais velho, com os arquivos", () => {
    const m = measureRootChanges(run(), { marker: marker(shas.c1), ref: "upstream/main" });
    expect(m.status).toBe("changes");
    expect(m.entries.map((e) => e.subject)).toEqual([
      "c6: shims e .gitattributes",
      "c4: import no AGENTS.md e modelo do ci.yml",
      "c3: SCHEMA.md vira apontador",
    ]);
    expect(m.entries[0]?.files.sort()).toEqual([".gitattributes", "CLAUDE.md", "GEMINI.md"]);
    expect(m.entries[1]?.files.sort()).toEqual(["AGENTS.md", "aiteam/templates/ci.yml.example"]);
    expect(m.entries[2]?.files).toEqual([".beads/SCHEMA.md"]);
    expect(m.entries[0]?.hash).toMatch(/^[0-9a-f]{7,}$/);
    expect(m.entries[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("c2 (só docs/) e c5 (só aiteam/src) não aparecem: não são arquivo de raiz distribuído", () => {
    const m = measureRootChanges(run(), { marker: marker(shas.c1), ref: "upstream/main" });
    expect(m.entries.map((e) => e.subject).join("|")).not.toMatch(/c2|c5/);
  });

  it("o intervalo começa DEPOIS do marcador: o commit do próprio marcador não conta", () => {
    const m = measureRootChanges(run(), { marker: marker(shas.c3), ref: "upstream/main" });
    expect(m.entries.map((e) => e.subject)).toEqual(["c6: shims e .gitattributes", "c4: import no AGENTS.md e modelo do ci.yml"]);
  });

  it("marcador no commit atual → same; num commit sem nada de raiz depois dele → changes sem entradas", () => {
    expect(measureRootChanges(run(), { marker: marker(shas.c6), ref: "upstream/main" }).status).toBe("same");
    const after = measureRootChanges(run(), { marker: marker(shas.c6.slice(0, 7)), ref: "upstream/main" });
    expect(after.status).toBe("same"); // o sha abreviado que alguém gravou à mão também resolve
    const none = measureRootChanges(run(), { marker: marker(shas.c5), ref: "upstream/main" });
    expect(none.status).toBe("changes");
    expect(none.entries.map((e) => e.subject)).toEqual(["c6: shims e .gitattributes"]);
  });

  // QA da #39 (A8): um commit de merge que toca a raiz entrava na lista "Arquivos de raiz" sem arquivo nenhum (o
  // --name-only não lista arquivo de merge), como "- `abc1234` data Merge pull request #5 — ": linha vazia e contagem inflada.
  it("commits de merge não entram na lista (sem arquivos, inflavam a contagem)", () => {
    const dir = copyConsumer();
    git(dir, ["checkout", "-q", "--detach", shas.c6]);
    const base = shas.c6;
    write(dir, ".gitattributes", "*.mjs text eol=lf\nSPEC.md text eol=lf\n*.png binary\n");
    const lado = commit(dir, "lado: .gitattributes", new Date(NOW));
    git(dir, ["checkout", "-q", "--detach", base]);
    write(dir, "AGENTS.md", "# AGENTS\n@aiteam/AGENTS.md\n\nmais uma linha\n");
    commit(dir, "principal: AGENTS.md", new Date(NOW));
    git(dir, ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "merge", "--no-ff", "-q", "-m", "Merge do lado", lado]);
    const merge = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["update-ref", "refs/remotes/upstream/main", merge]);

    const m = measureRootChanges(gitRunner(dir), { marker: parseUpstreamMarker(`commit: ${base}\n`), ref: "upstream/main" });
    const subjects = m.entries.map((e) => e.subject).sort();
    expect(subjects).toEqual(["lado: .gitattributes", "principal: AGENTS.md"]);
    expect(m.entries.every((e) => e.files.length > 0)).toBe(true);
    expect(m.entries.map((e) => e.subject).join("|")).not.toMatch(/Merge/);
  });

  it("devolve o marcador anterior e o commit atual, para o corpo do PR", () => {
    const m = measureRootChanges(run(), { marker: marker(shas.c1), ref: "upstream/main" });
    expect(m.previous).toEqual({ commit: shas.c1, date: "2026-01-01" });
    expect(m.current?.commit).toBe(shas.c6);
    expect(m.current?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("sem marcador → no-marker (e ainda diz o commit atual); marcador sem commit → malformed", () => {
    const none = measureRootChanges(run(), { marker: parseUpstreamMarker(null), ref: "upstream/main" });
    expect(none).toMatchObject({ status: "no-marker", previous: null, entries: [] });
    expect(none.current?.commit).toBe(shas.c6);
    expect(measureRootChanges(run(), { marker: parseUpstreamMarker("lixo\n"), ref: "upstream/main" }).status).toBe("malformed");
  });

  it("marcador cujo commit o clone não tem → unknown-commit (o log mentiria sobre um intervalo que não existe)", () => {
    const ghost = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const m = measureRootChanges(run(), { marker: marker(ghost), ref: "upstream/main" });
    expect(m).toMatchObject({ status: "unknown-commit", entries: [] });
    expect(m.previous?.commit).toBe(ghost);
  });

  it("marcador num commit que existe mas NÃO é ancestral da ref (outro ramo) → unknown-commit", () => {
    const dir = copyConsumer();
    git(dir, ["checkout", "-q", "--detach", shas.c1]);
    write(dir, "lado.txt", "só neste ramo\n");
    const side = commit(dir, "só no ramo lateral", new Date(NOW));
    git(dir, ["update-ref", "refs/remotes/upstream/side", side]);
    expect(measureRootChanges(gitRunner(dir), { marker: marker(side), ref: "upstream/main" }).status).toBe("unknown-commit");
  });

  it("os caminhos que o git log examina são os que se passam (o sync e a CLI usam ROOT_SOURCES)", () => {
    const m = measureRootChanges(run(), { marker: marker(shas.c1), ref: "upstream/main", paths: ["docs/b.md"] });
    expect(m.entries.map((e) => e.subject)).toEqual(["c2: só docs"]);
  });
});

describe("readMarker — aiteam/UPSTREAM no disco", () => {
  it("ausente, malformado e válido", () => {
    const dir = tmp("marker");
    expect(readMarker(dir)).toEqual({ state: "absent" });
    write(dir, "aiteam/UPSTREAM", "sem sha\n");
    expect(readMarker(dir)).toEqual({ state: "malformed" });
    write(dir, "aiteam/UPSTREAM", "commit: a9d862f\r\ndate: 2026-10-06\r\n");
    expect(readMarker(dir)).toEqual({ state: "ok", commit: "a9d862f", date: "2026-10-06" });
    // QA da #39 (A5): UTF-8 com BOM, como o Out-File do PowerShell 5 grava
    write(dir, "aiteam/UPSTREAM", "\uFEFFcommit: a9d862f\r\ndate: 2026-10-06\r\n");
    expect(readMarker(dir)).toEqual({ state: "ok", commit: "a9d862f", date: "2026-10-06" });
  });
});

describe("readRootFilesFacts + checkRootFilesUpstream — o doctor de ponta a ponta", () => {
  /** O consumidor atrasado: SCHEMA.md é a cópia velha, o AGENTS.md não tem o import, não há GEMINI.md, o .gitattributes não tem regra, o CI não roda validate:agents. */
  function laggingConsumer(): string {
    const dir = copyConsumer();
    write(dir, ".beads/SCHEMA.md", OLD_COPY);
    write(dir, "AGENTS.md", "# meu AGENTS\n");
    write(dir, "CLAUDE.md", "@aiteam/CLAUDE.md\n");
    write(dir, ".gitattributes", "*.png binary\n");
    write(dir, ".github/workflows/ci.yml", WORKFLOW("npm run typecheck", "npm run validate:beads", "npm run test"));
    return dir;
  }
  const facts = (dir: string, now = NOW) => readRootFilesFacts(dir, { yamlLoad: load, now });
  const lineOf = (lines: ReturnType<typeof checkRootFilesUpstream>, needle: string) => lines.find((l) => l.name.includes(needle));

  it("o consumidor atrasado ganha um WARN em cada arquivo de raiz que o upstream tem e ele não", () => {
    const lines = checkRootFilesUpstream(facts(laggingConsumer()));

    expect(lineOf(lines, "upstream do rb-ai-team")).toMatchObject({ pass: true });
    expect(lineOf(lines, "SCHEMA.md")).toMatchObject({ warn: true });
    expect(lineOf(lines, "SCHEMA.md")?.detail).toMatch(/não aponta para aiteam\/docs\/beads-schema\.md/);
    expect(lineOf(lines, "AGENTS.md /")).toMatchObject({ warn: true });
    expect(lineOf(lines, "AGENTS.md /")?.detail).toMatch(/AGENTS\.md sem a linha @aiteam\/AGENTS\.md/);
    expect(lineOf(lines, "AGENTS.md /")?.detail).toMatch(/GEMINI\.md não existe/);
    expect(lineOf(lines, "AGENTS.md /")?.detail).not.toMatch(/CLAUDE\.md (sem|não)/);
    expect(lineOf(lines, ".gitattributes")).toMatchObject({ warn: true });
    expect(lineOf(lines, ".gitattributes")?.detail).toMatch(/SPEC\.md text eol=lf/);
    expect(lineOf(lines, "CI de PR")).toMatchObject({ warn: true });
    expect(lineOf(lines, "CI de PR")?.detail).toContain("npm run validate:agents");
    for (const l of lines) expect(l.pass, l.name).toBe(true); // WARN, nunca FAIL
  });

  it("depois de reconciliar, tudo passa", () => {
    const dir = laggingConsumer();
    write(dir, ".beads/SCHEMA.md", `${POINTER}\n## Convenções locais\n- trello: algo\n`);
    write(dir, "AGENTS.md", "# meu AGENTS\n@aiteam/AGENTS.md\n");
    write(dir, "GEMINI.md", "@aiteam/GEMINI.md\n");
    write(dir, ".gitattributes", "*.mjs text eol=lf\nSPEC.md text eol=lf\n");
    write(dir, ".github/workflows/ci.yml", WORKFLOW("npm run typecheck", "npm run validate:beads", "npm --prefix aiteam run validate:agents", "npm run test"));
    const lines = checkRootFilesUpstream(facts(dir));
    // "sem aiteam/UPSTREAM" é informação na linha do upstream, não um aviso: ela só vira WARN se a ref estiver velha
    expect(lines.filter((l) => l.warn || !l.pass).map((l) => `${l.name}: ${l.detail}`)).toEqual([]);
  });

  // QA da #39 (R1): em modo legado a cópia local do SCHEMA.md é o contrato em vigor até migrar.
  it("o consumidor em modo legado (active.yaml do modelo antigo rastreado): a cópia do SCHEMA.md passa, e o doctor diz por quê", () => {
    const dir = laggingConsumer();
    write(dir, ".beads/active.yaml", "tasks: []\n");
    commit(dir, "modelo antigo de .beads", new Date(NOW));
    const f = facts(dir);
    expect(f.legacy).toBe(true);
    const line = lineOf(checkRootFilesUpstream(f), "SCHEMA.md");
    expect(line?.warn).toBeUndefined();
    expect(line?.detail).toMatch(/modo legado/);
    // o resto da comparação segue como antes: o legado só poupa o SCHEMA.md
    expect(lineOf(checkRootFilesUpstream(f), ".gitattributes")?.warn).toBe(true);
  });

  it("o consumidor migrado (sem o active.yaml rastreado) não é legado, e a cópia do SCHEMA.md é WARN", () => {
    const f = facts(laggingConsumer());
    expect(f.legacy).toBe(false);
    expect(lineOf(checkRootFilesUpstream(f), "SCHEMA.md")?.warn).toBe(true);
  });

  it("com o marcador, a linha do upstream conta os commits de raiz desde o último sync", () => {
    const dir = laggingConsumer();
    write(dir, "aiteam/UPSTREAM", `commit: ${shas.c1}\ndate: 2026-01-01\n`);
    const f = facts(dir);
    expect(f.since?.status).toBe("changes");
    const header = checkRootFilesUpstream(f)[0];
    expect(header?.detail).toContain(`último sync: ${shas.c1.slice(0, 7)}`);
    expect(header?.detail).toMatch(/3 commit\(s\) do upstream tocaram arquivos de raiz desde então/);
  });

  it("a ponta do upstream velha → a linha do upstream vira WARN (a medida é a idade do commit)", () => {
    const header = checkRootFilesUpstream(facts(consumerDir, NOW + 30 * DAY))[0];
    expect(header).toMatchObject({ pass: true, warn: true });
    expect(header?.detail).toMatch(/git fetch upstream/);
  });

  it("sem js-yaml o CI de PR degrada para 'não comparado' e o resto segue", () => {
    const f = readRootFilesFacts(laggingConsumer(), { yamlLoad: null, now: NOW });
    expect(f.workflowsUnavailable).toMatch(/js-yaml/);
    const lines = checkRootFilesUpstream(f);
    expect(lineOf(lines, "CI de PR")).toMatchObject({ pass: true });
    expect(lineOf(lines, "CI de PR")?.warn).toBeUndefined();
    expect(lineOf(lines, "SCHEMA.md")).toMatchObject({ warn: true });
  });

  it("workflow com YAML quebrado não derruba a leitura", () => {
    const dir = laggingConsumer();
    write(dir, ".github/workflows/quebrado.yml", "a: [\n  b: : :\n");
    const f = facts(dir);
    expect(f.workflows?.find((w) => w.file === "quebrado.yml")?.error).toBeTruthy();
    expect(() => checkRootFilesUpstream(f)).not.toThrow();
  });

  it("sem o remote upstream a leitura devolve só o estado, e o doctor imprime uma linha", () => {
    const dir = tmp("plain2");
    init(dir);
    const lines = checkRootFilesUpstream(readRootFilesFacts(dir, { yamlLoad: load }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ pass: true });
    expect(lines[0]?.warn).toBeUndefined();
  });
});

// QA da #39 (A2): num clone PARCIAL do upstream (--filter=blob:none, o remote é promisor) o `git show ref:arquivo` de um
// blob que falta dispara um lazy fetch: rede e packs novos. É um fetch que o doctor não pode fazer. O gitRunner põe
// GIT_NO_LAZY_FETCH=1 (git >= 2.44), o `git show` falha, e o resultado degrada para "não comparado".
describe("clone parcial do upstream (promisor): a leitura não dispara lazy fetch", () => {
  const gitMinor = (() => {
    const m = /git version (\d+)\.(\d+)/.exec(spawnSync("git", ["--version"], { encoding: "utf8" }).stdout);
    return m ? Number(m[1]) * 1000 + Number(m[2]) : 0;
  })();
  const SUPPORTED = gitMinor >= 2 * 1000 + 44; // GIT_NO_LAZY_FETCH existe desde o git 2.44

  const packs = (dir: string): string[] => {
    const d = path.join(dir, ".git", "objects", "pack");
    return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".pack")).sort() : [];
  };
  const partialClone = (): string => {
    git(upstreamDir, ["config", "uploadpack.allowFilter", "true"]);
    git(upstreamDir, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
    const dir = tmp("partial");
    fs.rmSync(dir, { recursive: true, force: true });
    const url = `file:///${upstreamDir.replace(/\\/g, "/").replace(/^\//, "")}`;
    git(path.dirname(dir), ["clone", "-q", "--filter=blob:none", "--no-checkout", "--origin", "upstream", url, dir]);
    return dir;
  };

  it.skipIf(!SUPPORTED)("controle: sem a variável, o git show de um blob que falta BUSCA o blob no remote (é o furo)", () => {
    const dir = partialClone();
    const before = packs(dir);
    expect(git(dir, ["config", "remote.upstream.promisor"])).toBe("true");
    expect(git(dir, ["show", "upstream/main:.beads/SCHEMA.md"])).toContain("beads-schema.md");
    expect(packs(dir).length).toBeGreaterThan(before.length);
  });

  it.skipIf(!SUPPORTED)("showAt devolve null, sem rede e sem pack novo: o resultado degrada para 'não comparado'", () => {
    const dir = partialClone();
    const before = packs(dir);
    expect(showAt(gitRunner(dir), "upstream/main", ".beads/SCHEMA.md")).toBeNull();
    expect(packs(dir)).toEqual(before);
  });

  it.skipIf(!SUPPORTED)("o doctor inteiro (readRootFilesFacts) num clone parcial: a ref é achada, os arquivos do upstream não, e nada é buscado", () => {
    const dir = partialClone();
    const before = packs(dir);
    const f = readRootFilesFacts(dir, { yamlLoad: load, now: NOW });
    expect(f.upstream.state).toBe("ok");
    expect(f.remote[".beads/SCHEMA.md"]).toBeNull();
    expect(f.template).toBeNull();
    const lines = checkRootFilesUpstream(f);
    for (const l of lines) expect(l.pass, l.name).toBe(true);
    expect(lines.find((l) => l.name.startsWith(".beads/SCHEMA.md"))?.detail).toMatch(/não comparado/);
    expect(packs(dir)).toEqual(before);
  });

  it("o runner põe GIT_NO_LAZY_FETCH=1 no ambiente do git, sem perder o ambiente do processo", () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "root-files-io.mjs"), "utf8");
    expect(src).toMatch(/GIT_NO_LAZY_FETCH:\s*"1"/);
    expect(src).toMatch(/\.\.\.process\.env/);
  });
});

describe("só leitura e sem rede", () => {
  it("ler os fatos não muda o repo: nem o índice, nem as refs, nem cria FETCH_HEAD", () => {
    const dir = copyConsumer();
    // o remote aponta para um lugar que NÃO existe: qualquer fetch falharia (e o teste, com ele)
    git(dir, ["remote", "set-url", "upstream", path.join(dir, "nao-existe")]);
    fs.rmSync(path.join(dir, ".git", "FETCH_HEAD"), { force: true });
    const snapshot = () => ({
      refs: git(dir, ["for-each-ref"]),
      status: git(dir, ["status", "--porcelain"]),
      fetchHead: fs.existsSync(path.join(dir, ".git", "FETCH_HEAD")),
    });
    const before = snapshot();
    const f = readRootFilesFacts(dir, { yamlLoad: load, now: NOW });
    expect(f.upstream.state).toBe("ok");
    expect(snapshot()).toEqual(before);
    expect(before.fetchHead).toBe(false);
  });

  it("o código não chama fetch, pull, ls-remote, clone nem push (o doctor só diz para o usuário rodar o fetch)", () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "root-files-io.mjs"), "utf8");
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    expect(code).not.toMatch(/["'](fetch|pull|ls-remote|update|clone|push)["']/);
  });
});
