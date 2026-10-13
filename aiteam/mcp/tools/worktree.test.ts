import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { WorktreeRefused, isCheckoutRoot, listWorktrees, resolveWorktree } from "./worktree.js";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const realTmp = (): string => fs.realpathSync.native(os.tmpdir());

const mkRepo = (dir: string): void => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed", "utf8");
  git(dir, ["add", "seed.txt"]);
  git(dir, ["commit", "-q", "-m", "seed"]);
};

describe("resolveWorktree — o caminho da worktree que as tools MCP aceitam (issue 38)", () => {
  let base: string;
  let main: string;
  let linked: string;
  let outsider: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(realTmp(), "mcp-worktree-"));
    main = path.join(base, "principal");
    linked = path.join(base, "principal-wt");
    outsider = path.join(base, "outro-repo");
    mkRepo(main);
    git(main, ["worktree", "add", "-q", "-b", "feat/isolada", linked]);
    mkRepo(outsider);
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("omitido: devolve undefined, o comportamento de antes (cwd do servidor)", () => {
    expect(resolveWorktree(undefined, main)).toBeUndefined();
  });

  it("aceita o checkout principal e a worktree vinculada, vistos do checkout principal", () => {
    expect(resolveWorktree(main, main)).toBe(main);
    expect(resolveWorktree(linked, main)).toBe(linked);
  });

  it("o servidor rodando dentro de uma worktree vinculada também enxerga o principal e as irmãs", () => {
    expect(resolveWorktree(main, linked)).toBe(main);
    expect(resolveWorktree(linked, linked)).toBe(linked);
  });

  it("aceita o caminho escrito com barra invertida, barra normal e barra final", () => {
    expect(resolveWorktree(linked.replace(/[\\/]/g, "/"), main)).toBe(linked);
    expect(resolveWorktree(linked.replace(/[\\/]/g, path.sep) + path.sep, main)).toBe(linked);
  });

  it.runIf(process.platform === "win32")("no Windows, maiúsculas e minúsculas (inclusive a letra do drive) não importam", () => {
    expect(resolveWorktree(linked.toUpperCase(), main)).toBe(linked);
    expect(resolveWorktree(linked.toLowerCase(), main)).toBe(linked);
  });

  it("recusa um diretório que não é worktree deste repositório", () => {
    expect(() => resolveWorktree(outsider, main)).toThrow(WorktreeRefused);
    expect(() => resolveWorktree(outsider, main)).toThrow(/not the main checkout or a worktree/i);
  });

  it("recusa um subdiretório de uma worktree: só a raiz vale", () => {
    const sub = path.join(linked, "pasta");
    fs.mkdirSync(sub);
    expect(() => resolveWorktree(sub, main)).toThrow(WorktreeRefused);
  });

  it("recusa o pai do checkout principal e a raiz do disco", () => {
    expect(() => resolveWorktree(base, main)).toThrow(WorktreeRefused);
    expect(() => resolveWorktree(path.parse(base).root, main)).toThrow(WorktreeRefused);
  });

  it("recusa um caminho que sai da worktree por ..", () => {
    expect(() => resolveWorktree(path.join(linked, "..", "outro-repo"), main)).toThrow(WorktreeRefused);
  });

  it("recusa caminho relativo, vazio e inexistente com mensagem clara", () => {
    expect(() => resolveWorktree(".", main)).toThrow(/absolute/i);
    expect(() => resolveWorktree("../principal-wt", main)).toThrow(/absolute/i);
    expect(() => resolveWorktree("", main)).toThrow(/absolute/i);
    expect(() => resolveWorktree(path.join(base, "nao-existe"), main)).toThrow(WorktreeRefused);
  });

  it("uma worktree que o git já não conhece (removida) deixa de valer", () => {
    git(main, ["worktree", "remove", "--force", linked]);
    expect(() => resolveWorktree(linked, main)).toThrow(WorktreeRefused);
  });

  it("o texto do caminho nunca vai para um shell: aspas e metacaracteres só viram recusa", () => {
    expect(() => resolveWorktree(`${linked}" && echo pwned`, main)).toThrow(WorktreeRefused);
    expect(() => resolveWorktree("$(touch injected.txt)", main)).toThrow(/absolute/i);
    expect(fs.existsSync(path.join(main, "injected.txt"))).toBe(false);
  });

  it("listWorktrees traz o checkout principal primeiro", () => {
    const todas = listWorktrees(main).map((p) => fs.realpathSync.native(p));
    expect(todas).toEqual([main, linked]);
  });

  it("fora de um repositório git, recusa em vez de aceitar tudo", () => {
    const solto = path.join(base, "solto");
    fs.mkdirSync(solto);
    expect(() => resolveWorktree(linked, solto)).toThrow(WorktreeRefused);
  });
});

// Uma worktree cujo diretório foi apagado continua na lista do git, marcada
// `prunable`, até um `git worktree prune`. Se alguém recria um diretório no mesmo
// caminho (vazio, ou parte de outro checkout), a entrada velha casava e o caminho
// era aceito — e um `git commit` com esse cwd cairia no repositório que contém o
// diretório, que pode ser o checkout principal.
describe("resolveWorktree — worktree apagada e diretório recriado no mesmo caminho", () => {
  let base: string;
  let main: string;
  let linked: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(realTmp(), "mcp-worktree-prunable-"));
    main = path.join(base, "principal");
    linked = path.join(base, "principal-wt");
    mkRepo(main);
    git(main, ["worktree", "add", "-q", "-b", "feat/apagada", linked]);
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const apagar = (dir: string) => fs.rmSync(dir, { recursive: true, force: true });

  it("o git marca a worktree apagada como prunable, e listWorktrees a pula", () => {
    apagar(linked);
    expect(git(main, ["worktree", "list", "--porcelain"])).toMatch(/^prunable /m);
    expect(listWorktrees(main).map((p) => fs.realpathSync.native(p))).toEqual([main]);
  });

  it("um diretório vazio recriado no caminho da worktree apagada é recusado", () => {
    apagar(linked);
    fs.mkdirSync(linked);
    expect(() => resolveWorktree(linked, main)).toThrow(WorktreeRefused);
  });

  it("um diretório recriado DENTRO do checkout principal (o commit cairia nele) é recusado", () => {
    const dentro = path.join(main, "wt-dentro");
    git(main, ["worktree", "add", "-q", "-b", "feat/dentro", dentro]);
    expect(resolveWorktree(dentro, main)).toBe(dentro);

    apagar(dentro);
    fs.mkdirSync(dentro);

    expect(() => resolveWorktree(dentro, main)).toThrow(WorktreeRefused);
  });

  it("depois do prune e com o diretório de volta, continua recusado", () => {
    apagar(linked);
    git(main, ["worktree", "prune"]);
    fs.mkdirSync(linked);
    expect(() => resolveWorktree(linked, main)).toThrow(WorktreeRefused);
  });

  it("uma worktree recriada de verdade (git worktree add de novo) volta a valer", () => {
    apagar(linked);
    git(main, ["worktree", "prune"]);
    git(main, ["worktree", "add", "-q", "-b", "feat/outra", linked]);
    expect(resolveWorktree(linked, main)).toBe(linked);
  });

  it("uma worktree trancada (locked) e presente continua valendo", () => {
    git(main, ["worktree", "lock", linked]);
    expect(resolveWorktree(linked, main)).toBe(linked);
  });
});

describe("isCheckoutRoot — o caminho é a raiz de um checkout, não um diretório dentro de um", () => {
  let base: string;
  let main: string;
  let linked: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(realTmp(), "mcp-checkout-root-"));
    main = path.join(base, "principal");
    linked = path.join(base, "principal-wt");
    mkRepo(main);
    git(main, ["worktree", "add", "-q", "-b", "feat/raiz", linked]);
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("a raiz do principal e a de uma worktree vinculada são raízes", () => {
    expect(isCheckoutRoot(main)).toBe(true);
    expect(isCheckoutRoot(linked)).toBe(true);
  });

  it("um subdiretório de qualquer um dos dois não é", () => {
    const sub = path.join(main, "pasta");
    fs.mkdirSync(sub);
    expect(isCheckoutRoot(sub)).toBe(false);
    const subWt = path.join(linked, "pasta");
    fs.mkdirSync(subWt);
    expect(isCheckoutRoot(subWt)).toBe(false);
  });

  it("um diretório fora de qualquer repositório, ou que não existe, não é", () => {
    const solto = path.join(base, "solto");
    fs.mkdirSync(solto);
    expect(isCheckoutRoot(solto)).toBe(false);
    expect(isCheckoutRoot(path.join(base, "nao-existe"))).toBe(false);
  });

  it("compara o caminho como o disco o grafa (barra, caixa no Windows)", () => {
    expect(isCheckoutRoot(main.replace(/[\\/]/g, "/"))).toBe(true);
    if (process.platform === "win32") expect(isCheckoutRoot(main.toUpperCase())).toBe(true);
  });
});
