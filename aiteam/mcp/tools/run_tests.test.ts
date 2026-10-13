import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { findVitestBin, runTests, type ExecFile } from "./run_tests.js";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const AITEAM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Um "vitest" de mentira (package.json com bin + o script) para o sandbox: o que
// se prova aqui é COMO o processo é lançado e ONDE, não o vitest em si.
function installFakeVitest(dir: string, script = "console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n") {
  const pkgDir = path.join(dir, "node_modules", "vitest");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "vitest", version: "0.0.0", bin: { vitest: "./vitest.mjs" } }));
  fs.writeFileSync(path.join(pkgDir, "vitest.mjs"), script);
  return path.join(pkgDir, "vitest.mjs");
}

// O vitest é o alvo da tool, mas o que se testa aqui é ONDE ele roda: um exec
// falso captura (arquivo, argv, opções) e devolve sem subir processo nenhum.
describe("runTests — parâmetro worktree (issue 38)", () => {
  const originalCwd = process.cwd();
  let base: string;
  let main: string;
  let linked: string;
  let vitestBin: string;
  let linkedBin: string;
  let chamadas: { file: string; args: readonly string[]; cwd: unknown; options: Record<string, unknown> }[];

  const fakeExec: ExecFile = (file, args, options) => {
    const o = (options ?? {}) as Record<string, unknown>;
    chamadas.push({ file, args: args ?? [], cwd: o["cwd"], options: o });
    return "ok";
  };

  beforeEach(() => {
    chamadas = [];
    base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "run-tests-wt-"));
    main = path.join(base, "principal");
    linked = path.join(base, "principal-wt");
    fs.mkdirSync(main);
    git(main, ["init", "-q", "-b", "main"]);
    git(main, ["config", "user.email", "test@example.com"]);
    git(main, ["config", "user.name", "Test"]);
    git(main, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(main, "seed.txt"), "seed", "utf8");
    git(main, ["add", "seed.txt"]);
    git(main, ["commit", "-q", "-m", "seed"]);
    git(main, ["worktree", "add", "-q", "-b", "feat/isolada", linked]);
    // Cada árvore tem o seu node_modules, como o worktree-link.mjs deixa a do subagente. O
    // vitest de fora do repo (um node_modules acima dele) não conta: ver "contenção".
    vitestBin = installFakeVitest(main);
    linkedBin = installFakeVitest(linked);
    process.chdir(main);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("omitido: roda no checkout do próprio servidor", () => {
    const r = runTests({ watch: false }, fakeExec);
    expect(r.success).toBe(true);
    expect(chamadas).toHaveLength(1);
    expect(fs.realpathSync.native(String(chamadas[0]!.cwd))).toBe(fs.realpathSync.native(main));
    expect(chamadas[0]!.args).toEqual([vitestBin, "run"]);
  });

  it("com a worktree, roda o vitest com esse cwd e o pattern como um único argv", () => {
    const r = runTests({ pattern: "src/auth/**", watch: false, worktree: linked }, fakeExec);
    expect(r.success).toBe(true);
    expect(chamadas[0]!.cwd).toBe(linked);
    expect(chamadas[0]!.args).toEqual([linkedBin, "run", "src/auth/**"]);
  });

  it("aceita o checkout principal pelo caminho explícito", () => {
    expect(runTests({ watch: false, worktree: main }, fakeExec).success).toBe(true);
    expect(chamadas[0]!.cwd).toBe(main);
  });

  it("recusa um caminho que não é o principal nem uma worktree dele, sem rodar nada", () => {
    const outro = path.join(base, "outro");
    fs.mkdirSync(outro);

    const r = runTests({ watch: false, worktree: outro }, fakeExec);

    expect(r.success).toBe(false);
    expect(r.output).toMatch(/not the main checkout or a worktree/i);
    expect(chamadas).toHaveLength(0);
  });

  it("recusa caminho relativo", () => {
    const r = runTests({ watch: false, worktree: "../principal-wt" }, fakeExec);
    expect(r.success).toBe(false);
    expect(r.output).toMatch(/absolute/i);
    expect(chamadas).toHaveLength(0);
  });
});

// O Windows não acha `npx` num execFileSync sem shell (é npx.cmd): ENOENT. O
// vitest sobe pelo node que já está rodando, com o script do pacote, e nunca
// por um shell (shell: true reabriria a injeção pelo pattern).
describe("runTests — como o vitest é lançado", () => {
  const originalCwd = process.cwd();
  let base: string;
  let main: string;
  let vitestBin: string;
  let chamadas: { file: string; args: readonly string[]; options: Record<string, unknown> }[];

  const fakeExec: ExecFile = (file, args, options) => {
    chamadas.push({ file, args: args ?? [], options: (options ?? {}) as Record<string, unknown> });
    return "ok";
  };

  beforeEach(() => {
    chamadas = [];
    base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "run-tests-launch-"));
    main = path.join(base, "principal");
    fs.mkdirSync(main);
    git(main, ["init", "-q", "-b", "main"]);
    vitestBin = installFakeVitest(main);
    process.chdir(main);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("usa o node em execução e o script do vitest, nunca o npx, e nunca um shell", () => {
    runTests({ pattern: "src/**", watch: false }, fakeExec);
    expect(chamadas[0]!.file).toBe(process.execPath);
    expect(chamadas[0]!.args[0]).toBe(vitestBin);
    expect(chamadas[0]!.options["shell"]).toBeUndefined();
  });

  it("o pattern com metacaracteres de shell segue como UM argv, sem interpretação", () => {
    const ataque = '"; calc.exe & $(whoami) `id` | tee x';
    runTests({ pattern: ataque, watch: false }, fakeExec);
    expect(chamadas[0]!.args).toEqual([vitestBin, "run", ataque]);
    expect(chamadas[0]!.options["shell"]).toBeUndefined();
  });

  it("sem vitest instalado, explica onde procurou, em vez de um ENOENT", () => {
    fs.rmSync(path.join(main, "node_modules"), { recursive: true, force: true });
    const r = runTests({ watch: false }, fakeExec);
    expect(r.success).toBe(false);
    expect(r.output).toMatch(/vitest/i);
    expect(r.output).toMatch(/node_modules/);
    expect(chamadas).toHaveLength(0);
  });

  // A busca sobe pelos pais como a do Node, mas PARA na raiz do checkout: um
  // node_modules/vitest acima do repo (o $HOME, um diretório de outro projeto) é
  // código de fora, e o servidor o executaria com node.
  it("um vitest ACIMA da raiz do repositório não é usado", () => {
    fs.rmSync(path.join(main, "node_modules"), { recursive: true, force: true });
    installFakeVitest(base, 'console.log("rodou o vitest de fora do repo");\n');
    const r = runTests({ watch: false }, fakeExec);
    expect(r.success).toBe(false);
    expect(r.output).toMatch(/vitest not found/);
    expect(chamadas).toHaveLength(0);
  });

  // Um pattern que começa com `-` chega ao vitest como OPÇÃO: `--config=<arquivo>`
  // carrega e executa esse arquivo como JS. O pattern é um filtro de arquivo.
  it.each(["--config=./evil.config.js", "-c", "--root=/", "--reporter=./x.js", "-", "--"])(
    "recusa o pattern %s, que o vitest leria como opção, sem rodar nada",
    (pattern) => {
      const r = runTests({ pattern, watch: false }, fakeExec);
      expect(r.success).toBe(false);
      expect(r.output).toMatch(/pattern.*option/i);
      expect(chamadas).toHaveLength(0);
    },
  );

  it("um pattern com hífen no meio, ou um caminho com ponto, continua valendo", () => {
    for (const pattern of ["src/a-b.test.ts", "./src/x", "src/auth/**", "a--b"]) {
      expect(runTests({ pattern, watch: false }, fakeExec).success, pattern).toBe(true);
    }
    expect(chamadas.map((c) => c.args[2])).toEqual(["src/a-b.test.ts", "./src/x", "src/auth/**", "a--b"]);
  });

  it("de verdade: um --config=<arquivo> nunca chega a executar esse arquivo", () => {
    // Um vitest que faz o que o de verdade faz com --config: carrega o arquivo como JS.
    installFakeVitest(
      main,
      'import { createRequire } from "node:module";\nimport { resolve } from "node:path";\n' +
        'const a = process.argv.slice(2).find((x) => x.startsWith("--config="));\n' +
        "if (a) createRequire(import.meta.url)(resolve(a.slice(9)));\n" +
        'console.log("ok");\n',
    );
    const marca = path.join(main, "executou.txt");
    fs.writeFileSync(path.join(main, "evil.config.js"), `require("fs").writeFileSync(${JSON.stringify(marca)}, "x");\nmodule.exports = {};\n`);
    const r = runTests({ pattern: "--config=./evil.config.js", watch: false });
    expect(r.success).toBe(false);
    expect(fs.existsSync(marca)).toBe(false);
  });

  it("um node_modules içado na raiz do repositório serve a um subdiretório", () => {
    fs.rmSync(path.join(main, "node_modules"), { recursive: true, force: true });
    const hoisted = installFakeVitest(main);
    fs.mkdirSync(path.join(main, "pacotes", "app"), { recursive: true });
    fs.writeFileSync(path.join(main, "SPEC.md"), "---\nproject: x\nci:\n  workdir: pacotes/app\n  test: npm run test\n---\n");
    expect(runTests({ watch: false }, fakeExec).success).toBe(true);
    expect(chamadas[0]!.args[0]).toBe(hoisted);
  });


  it("de verdade (sem exec falso): o processo sobe no cwd certo e recebe o pattern intacto", () => {
    const r = runTests({ pattern: "so um/arg & $(x)", watch: false });
    expect(r.success, r.output).toBe(true);
    const seen = JSON.parse(r.output.trim().split(/\r?\n/).pop() ?? "{}") as { argv: string[]; cwd: string };
    expect(seen.argv).toEqual(["run", "so um/arg & $(x)"]);
    expect(fs.realpathSync.native(seen.cwd)).toBe(fs.realpathSync.native(main));
  });

  it("a falha do vitest volta como success: false com a saída dele", () => {
    installFakeVitest(main, 'console.log("1 failed"); process.exit(1);\n');
    const r = runTests({ watch: false });
    expect(r.success).toBe(false);
    expect(r.output).toContain("1 failed");
  });
});

// O app que o contrato de CI declara em ci.workdir (o `aiteam` deste repo, a
// raiz na maioria dos consumidores) é onde a suíte mora: é ali que o vitest sobe.
describe("runTests — ci.workdir do SPEC.md", () => {
  const originalCwd = process.cwd();
  let base: string;
  let main: string;
  let chamadas: { args: readonly string[]; cwd: unknown }[];

  const fakeExec: ExecFile = (_file, args, options) => {
    chamadas.push({ args: args ?? [], cwd: (options as { cwd?: unknown } | undefined)?.cwd });
    return "ok";
  };

  beforeEach(() => {
    chamadas = [];
    base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "run-tests-workdir-"));
    main = path.join(base, "principal");
    fs.mkdirSync(path.join(main, "app"), { recursive: true });
    git(main, ["init", "-q", "-b", "main"]);
    process.chdir(main);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(base, { recursive: true, force: true });
  });

  const spec = (workdir: string) => `---\nproject: x\nci:\n  workdir: ${workdir}\n  test: npm run test\n---\n`;

  it("sobe o vitest no diretório da app e procura o binário a partir dele", () => {
    fs.writeFileSync(path.join(main, "SPEC.md"), spec("app"));
    const bin = installFakeVitest(path.join(main, "app"));
    expect(runTests({ watch: false }, fakeExec).success).toBe(true);
    expect(fs.realpathSync.native(String(chamadas[0]!.cwd))).toBe(fs.realpathSync.native(path.join(main, "app")));
    expect(chamadas[0]!.args[0]).toBe(bin);
  });

  it("workdir vazio (a raiz) mantém o cwd", () => {
    fs.writeFileSync(path.join(main, "SPEC.md"), spec(""));
    installFakeVitest(main);
    runTests({ watch: false }, fakeExec);
    expect(fs.realpathSync.native(String(chamadas[0]!.cwd))).toBe(fs.realpathSync.native(main));
  });

  it("workdir declarado mas inexistente cai no cwd", () => {
    fs.writeFileSync(path.join(main, "SPEC.md"), spec("nao-existe"));
    installFakeVitest(main);
    runTests({ watch: false }, fakeExec);
    expect(fs.realpathSync.native(String(chamadas[0]!.cwd))).toBe(fs.realpathSync.native(main));
  });

  // O SPEC.md é do repositório e o ci.workdir é texto dele: um symlink ou junction
  // com esse nome apontando para FORA do checkout faria o servidor rodar o vitest
  // (e a config e os testes) de outro diretório. Foi executado de fora do repo.
  describe("contenção: o workdir real tem de ficar dentro do checkout", () => {
    let fora: string;
    let link = "";

    const apontaPara = (alvo: string, nome: string): string => {
      const p = path.join(main, nome);
      fs.symlinkSync(alvo, p, "junction"); // junction no Windows (sem privilégio); symlink de pasta nos outros
      return p;
    };

    beforeEach(() => {
      fora = path.join(base, "fora-do-repo");
      fs.mkdirSync(path.join(fora, "node_modules"), { recursive: true });
      installFakeVitest(fora, 'console.log("rodou o vitest de fora do repo");\n');
    });

    afterEach(() => {
      // Desfaz o link ANTES de apagar a árvore: o rm recursivo de uma junction no
      // Windows pode seguir o link e apagar o alvo.
      if (link) {
        try {
          fs.unlinkSync(link);
        } catch {
          fs.rmdirSync(link);
        }
        link = "";
      }
    });

    it("um workdir que é um link para fora do repositório é recusado, sem rodar nada", () => {
      fs.rmSync(path.join(main, "app"), { recursive: true, force: true }); // o app/ criado no beforeEach dá lugar ao link
      link = apontaPara(fora, "app");
      fs.writeFileSync(path.join(main, "SPEC.md"), spec("app"));

      const r = runTests({ watch: false }, fakeExec);

      expect(r.success).toBe(false);
      expect(r.output).toMatch(/ci\.workdir/);
      expect(r.output).toMatch(/outside|fora/i);
      expect(chamadas).toHaveLength(0);
    });

    it("um link que sai e volta para dentro continua valendo", () => {
      const dentro = path.join(main, "real-app");
      fs.mkdirSync(dentro);
      const bin = installFakeVitest(dentro);
      fs.rmSync(path.join(main, "app"), { recursive: true, force: true });
      link = apontaPara(dentro, "app");
      fs.writeFileSync(path.join(main, "SPEC.md"), spec("app"));

      const r = runTests({ watch: false }, fakeExec);

      expect(r.success, r.output).toBe(true);
      expect(fs.realpathSync.native(String(chamadas[0]!.cwd))).toBe(fs.realpathSync.native(dentro));
      expect(fs.realpathSync.native(String(chamadas[0]!.args[0]))).toBe(fs.realpathSync.native(bin));
    });

    it(".. no workdir não escapa (o leitor do contrato já o recusa; o resultado é o cwd)", () => {
      fs.writeFileSync(path.join(main, "SPEC.md"), spec("../fora-do-repo"));
      installFakeVitest(main);
      runTests({ watch: false }, fakeExec);
      expect(fs.realpathSync.native(String(chamadas[0]!.cwd))).toBe(fs.realpathSync.native(main));
    });
  });
});

describe("findVitestBin", () => {
  it("acha o vitest deste repo, subindo a partir de um subdiretório", () => {
    const bin = findVitestBin(path.join(AITEAM, "mcp", "tools"));
    expect(bin).toBeDefined();
    expect(path.isAbsolute(bin!)).toBe(true);
    expect(bin!.endsWith(".mjs")).toBe(true);
    expect(fs.existsSync(bin!)).toBe(true);
  });

  describe("a subida para no teto", () => {
    let tmp: string;
    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "no-vitest-"));
    });
    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("volta undefined quando nenhum node_modules do caminho até o teto tem vitest", () => {
      expect(findVitestBin(tmp, tmp)).toBeUndefined();
    });

    it("não passa do teto: o vitest do pai do teto não vale", () => {
      installFakeVitest(tmp);
      const teto = path.join(tmp, "repo");
      const fundo = path.join(teto, "a", "b");
      fs.mkdirSync(fundo, { recursive: true });
      expect(findVitestBin(fundo, teto)).toBeUndefined();
    });

    it("acha o vitest no próprio teto e em qualquer degrau entre o início e ele", () => {
      const teto = path.join(tmp, "repo");
      const fundo = path.join(teto, "a", "b");
      fs.mkdirSync(fundo, { recursive: true });
      const bin = installFakeVitest(teto);
      expect(findVitestBin(fundo, teto)).toBe(bin);
      const meio = installFakeVitest(path.join(teto, "a"));
      expect(findVitestBin(fundo, teto)).toBe(meio);
    });

    it("um teto que não contém o início não vira licença para subir até a raiz do disco", () => {
      installFakeVitest(tmp);
      const outro = path.join(tmp, "outro");
      const inicio = path.join(tmp, "repo", "a");
      fs.mkdirSync(outro, { recursive: true });
      fs.mkdirSync(inicio, { recursive: true });
      expect(findVitestBin(inicio, outro)).toBeUndefined();
    });

    it("sem o teto explícito, o do repositório (aqui, nenhum: fora de um git) é o próprio início", () => {
      installFakeVitest(tmp);
      const inicio = path.join(tmp, "a");
      fs.mkdirSync(inicio);
      expect(findVitestBin(inicio)).toBeUndefined();
    });
  });
});
