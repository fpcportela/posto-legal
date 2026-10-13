import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { defaultTargetDir, isUpstream, repoRoot } from "./repo-root.js";

// `npm --prefix aiteam run <script>` roda o script com cwd = aiteam/. Os
// scripts que escrevem NO repo (generate-spec, bootstrap-beads) não podem usar
// esse cwd como padrão: gravariam SPEC.md e .beads/ dentro do framework.
describe("defaultTargetDir", () => {
  const real = (p: string) => fs.realpathSync(p);
  let tmp: string;
  let repo: string;

  function setup(): void {
    tmp = real(fs.mkdtempSync(path.join(os.tmpdir(), "rr-target-")));
    repo = path.join(tmp, "app");
    fs.mkdirSync(path.join(repo, "aiteam"), { recursive: true });
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
  }

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("o argumento explícito vence tudo, resolvido contra o cwd", () => {
    setup();
    const env = { INIT_CWD: repo, RB_REPO_ROOT: "/ignorado" };
    expect(defaultTargetDir("alvo", env, repo)).toBe(path.resolve("alvo"));
    expect(defaultTargetDir(path.join(tmp, "outro"), env, repo)).toBe(path.join(tmp, "outro"));
  });

  it("sem argumento, o cwd aiteam/ (npm --prefix aiteam run) vira a raiz do repo", () => {
    setup();
    expect(real(defaultTargetDir(undefined, {}, path.join(repo, "aiteam")))).toBe(repo);
  });

  it("com INIT_CWD, vale a raiz do repo de onde o npm foi iniciado, mesmo de um subdiretório", () => {
    setup();
    // cwd = aiteam/ (onde o npm roda o script); INIT_CWD = src/ (de onde o usuário digitou)
    const target = defaultTargetDir(undefined, { INIT_CWD: path.join(repo, "src") }, path.join(repo, "aiteam"));
    expect(real(target)).toBe(repo);
  });

  it("INIT_CWD fora de qualquer repo vale como está", () => {
    setup();
    const loose = path.join(tmp, "solto");
    fs.mkdirSync(loose);
    expect(real(defaultTargetDir(undefined, { INIT_CWD: loose }, path.join(repo, "aiteam")))).toBe(loose);
  });

  it("RB_REPO_ROOT vale acima do INIT_CWD", () => {
    setup();
    const target = defaultTargetDir(undefined, { RB_REPO_ROOT: tmp, INIT_CWD: repo }, repo);
    expect(target).toBe(path.resolve(tmp));
  });
});

describe("repoRoot", () => {
  const originalCwd = process.cwd();
  const originalOverride = process.env["RB_REPO_ROOT"];

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalOverride === undefined) delete process.env["RB_REPO_ROOT"];
    else process.env["RB_REPO_ROOT"] = originalOverride;
  });

  it("honors the RB_REPO_ROOT override above everything else", () => {
    process.env["RB_REPO_ROOT"] = path.join(os.tmpdir(), "explicit-root");
    expect(repoRoot()).toBe(path.join(os.tmpdir(), "explicit-root"));
  });

  it("returns the git toplevel when run inside the repository", () => {
    delete process.env["RB_REPO_ROOT"];
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    expect(path.resolve(repoRoot())).toBe(path.resolve(top));
  });

  it("falls back to cwd when not in a git repo", () => {
    delete process.env["RB_REPO_ROOT"];
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rr-nogit-")));
    try {
      process.chdir(tmp);
      expect(path.resolve(repoRoot())).toBe(path.resolve(tmp));
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// O marcador do upstream (rb-ai-team) é o manifesto do aiteam-sync: tools/ fica na
// raiz, fora de aiteam/, e o vendor não o leva. Os testes que afirmam uma
// propriedade do repo HOSPEDEIRO (o SPEC.md do framework, o .claude/tier-rules.json
// igual ao template) só valem onde esse marcador existe; num consumidor a raiz é
// dele e a suíte do aiteam/ roda lá também (rb-ai-team#27, #36, #60, #62).
describe("isUpstream", () => {
  let tmp: string;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("é verdadeiro quando a raiz tem tools/aiteam-sync/manifest.json", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rr-upstream-"));
    fs.mkdirSync(path.join(tmp, "tools", "aiteam-sync"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "tools", "aiteam-sync", "manifest.json"), "{}");
    expect(isUpstream(tmp)).toBe(true);
  });

  it("é falso num consumidor: aiteam/ vendorizado, sem o manifesto do sync", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rr-consumer-"));
    fs.mkdirSync(path.join(tmp, "aiteam"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "tools", "dashboard"), { recursive: true }); // o tools/ do consumidor não é o marcador
    expect(isUpstream(tmp)).toBe(false);
  });

  it("sem argumento, olha a raiz do repo (repoRoot)", () => {
    const original = process.env["RB_REPO_ROOT"];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rr-default-"));
    process.env["RB_REPO_ROOT"] = tmp;
    try {
      expect(isUpstream()).toBe(false);
      fs.mkdirSync(path.join(tmp, "tools", "aiteam-sync"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "tools", "aiteam-sync", "manifest.json"), "{}");
      expect(isUpstream()).toBe(true);
    } finally {
      if (original === undefined) delete process.env["RB_REPO_ROOT"];
      else process.env["RB_REPO_ROOT"] = original;
    }
  });
});
