import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { gitCommit } from "./git_commit.js";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

// A message that executes a sentinel-creating command if (and only if) it is
// passed through a shell. cmd.exe breaks out of JSON.stringify's double-quotes
// because it doesn't honour backslash-escaping; POSIX sh expands $(...).
const sentinelPayload =
  os.platform() === "win32"
    ? 'safe" & echo pwned> injected.txt & echo "tail'
    : "safe $(touch injected.txt) tail";

describe("gitCommit — command injection (CWE-78)", () => {
  const originalCwd = process.cwd();
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "git-commit-test-"));
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    process.chdir(repo);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("does not execute shell metacharacters in the commit message", () => {
    fs.writeFileSync(path.join(repo, "file.txt"), "content", "utf8");

    gitCommit({ message: sentinelPayload, files: ["file.txt"] });

    expect(fs.existsSync(path.join(repo, "injected.txt"))).toBe(false);
  });

  it("commits the message verbatim", () => {
    fs.writeFileSync(path.join(repo, "file.txt"), "content", "utf8");
    const message = "fix: handle a & b, $(x), `y`";

    gitCommit({ message, files: ["file.txt"] });

    expect(git(repo, ["log", "-1", "--format=%s"]).trim()).toBe(message);
  });

  it("stages a path that looks like a flag without treating it as an option", () => {
    const flagLike = "-n.txt";
    fs.writeFileSync(path.join(repo, flagLike), "x", "utf8");

    gitCommit({ message: "add flag-like file", files: [flagLike] });

    expect(git(repo, ["ls-files"]).trim()).toBe(flagLike);
  });
});

// Issue 38: o servidor MCP roda no checkout principal; sem o caminho da worktree
// o git_commit de um implementador isolado commitaria lá. Com `worktree`, o git
// roda com esse cwd — validado contra `git worktree list` do repo do servidor.
describe("gitCommit — parâmetro worktree (issue 38)", () => {
  const originalCwd = process.cwd();
  let base: string;
  let main: string;
  let linked: string;

  const head = (dir: string) => git(dir, ["rev-parse", "HEAD"]).trim();
  const branchOf = (dir: string) => git(dir, ["branch", "--show-current"]).trim();

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "git-commit-wt-"));
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
    process.chdir(main);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("commita na worktree e deixa o checkout principal intacto", () => {
    const antesMain = head(main);
    fs.writeFileSync(path.join(linked, "novo.txt"), "x", "utf8");

    const r = gitCommit({ message: "feat: na worktree", files: ["novo.txt"], worktree: linked });

    expect(r.success).toBe(true);
    expect(branchOf(linked)).toBe("feat/isolada");
    expect(git(linked, ["log", "-1", "--format=%s"]).trim()).toBe("feat: na worktree");
    expect(git(linked, ["ls-tree", "--name-only", "HEAD"])).toContain("novo.txt");
    expect(head(main)).toBe(antesMain);
    expect(git(main, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("dryRun com worktree faz stage na worktree e não commita", () => {
    const antes = head(linked);
    fs.writeFileSync(path.join(linked, "novo.txt"), "x", "utf8");

    const r = gitCommit({ message: "x", files: ["novo.txt"], dryRun: true, worktree: linked });

    expect(r.success).toBe(true);
    expect(r.output).toMatch(/dry-run/);
    expect(git(linked, ["diff", "--cached", "--name-only"]).trim()).toBe("novo.txt");
    expect(head(linked)).toBe(antes);
  });

  it("aceita o checkout principal pelo caminho explícito", () => {
    fs.writeFileSync(path.join(main, "p.txt"), "x", "utf8");
    const r = gitCommit({ message: "no principal", files: ["p.txt"], worktree: main });
    expect(r.success).toBe(true);
    expect(git(main, ["log", "-1", "--format=%s"]).trim()).toBe("no principal");
  });

  it("omitido: commita no cwd do servidor, como antes", () => {
    fs.writeFileSync(path.join(main, "p.txt"), "x", "utf8");
    const antesLinked = head(linked);

    const r = gitCommit({ message: "sem worktree", files: ["p.txt"] });

    expect(r.success).toBe(true);
    expect(git(main, ["log", "-1", "--format=%s"]).trim()).toBe("sem worktree");
    expect(head(linked)).toBe(antesLinked);
  });

  it("recusa um repositório que não é o principal nem uma worktree dele, sem stage nem commit", () => {
    const outro = path.join(base, "outro");
    fs.mkdirSync(outro);
    git(outro, ["init", "-q", "-b", "main"]);
    git(outro, ["config", "user.email", "test@example.com"]);
    git(outro, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(outro, "f.txt"), "x", "utf8");
    fs.writeFileSync(path.join(main, "f.txt"), "y", "utf8");

    const r = gitCommit({ message: "invasão", files: ["f.txt"], worktree: outro });

    expect(r.success).toBe(false);
    expect(r.output).toMatch(/not the main checkout or a worktree/i);
    expect(git(outro, ["status", "--porcelain"])).toMatch(/\?\? f\.txt/);
    expect(git(main, ["diff", "--cached", "--name-only"]).trim()).toBe("");
  });

  it("recusa caminho relativo e subdiretório da worktree", () => {
    fs.mkdirSync(path.join(linked, "sub"));
    expect(gitCommit({ message: "x", files: ["a"], worktree: "../principal-wt" }).success).toBe(false);
    expect(gitCommit({ message: "x", files: ["a"], worktree: path.join(linked, "sub") }).success).toBe(false);
  });

  it("o caminho da worktree não é interpretado por um shell", () => {
    fs.writeFileSync(path.join(linked, "novo.txt"), "x", "utf8");
    const r = gitCommit({
      message: "x",
      files: ["novo.txt"],
      worktree: `${linked}" & echo pwned> injected.txt & echo "`,
    });
    expect(r.success).toBe(false);
    expect(fs.existsSync(path.join(main, "injected.txt"))).toBe(false);
    expect(fs.existsSync(path.join(linked, "injected.txt"))).toBe(false);
  });
});
