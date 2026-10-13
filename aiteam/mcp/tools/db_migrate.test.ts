import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { dispatch } from "../registry.js";
import { dbMigrate, type ExecFile } from "./db_migrate.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// O `execFileSync("npx")` sem shell dá ENOENT no Windows (o executável é npx.cmd): a tool
// de migração nunca rodou lá. E `npx prisma` baixa o prisma da rede se ele não está
// instalado, o que numa tool Tier 3 é código de fora executado sem ninguém pedir. Agora ela
// roda o node em execução com o script do prisma achado em node_modules (como o run_tests
// faz com o vitest) e, sem ele, recusa. O gate de Tier 3 é do registry e não muda.

// Um "prisma" de mentira: package.json com bin e um script que registra o argv.
function installFakePrisma(dir: string, script?: string): string {
  const pkgDir = path.join(dir, "node_modules", "prisma");
  fs.mkdirSync(path.join(pkgDir, "build"), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "prisma", version: "0.0.0", bin: { prisma: "build/index.js" } }));
  fs.writeFileSync(
    path.join(pkgDir, "build", "index.js"),
    script ?? "console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n",
  );
  return path.join(pkgDir, "build", "index.js");
}

describe("dbMigrate — como o prisma é lançado", () => {
  const originalCwd = process.cwd();
  let base: string;
  let repo: string;
  let prismaBin: string;
  let chamadas: { file: string; args: readonly string[]; options: Record<string, unknown> }[];

  const fakeExec: ExecFile = (file, args, options) => {
    chamadas.push({ file, args: args ?? [], options: (options ?? {}) as Record<string, unknown> });
    return "ok";
  };

  beforeEach(() => {
    chamadas = [];
    base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "db-migrate-"));
    repo = path.join(base, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    prismaBin = installFakePrisma(repo);
    process.chdir(repo);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("up: o node em execução e o script do prisma, nunca o npx, e nunca um shell", () => {
    const r = dbMigrate({ direction: "up", dryRun: false, environment: "local" }, fakeExec);
    expect(r.success).toBe(true);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.file).toBe(process.execPath);
    expect(chamadas[0]!.args).toEqual([prismaBin, "migrate", "deploy"]);
    expect(chamadas[0]!.options["shell"]).toBeUndefined();
  });

  it("dry-run: migrate status, sem executar a migração", () => {
    const r = dbMigrate({ direction: "up", dryRun: true, environment: "staging" }, fakeExec);
    expect(r.success).toBe(true);
    expect(r.output).toContain("[dry-run]");
    expect(chamadas.map((c) => c.args)).toEqual([[prismaBin, "migrate", "status"]]);
  });

  it("down local: reset --force; as outras recusas continuam, sem rodar nada", () => {
    expect(dbMigrate({ direction: "down", dryRun: false, environment: "local" }, fakeExec).success).toBe(true);
    expect(chamadas[0]!.args).toEqual([prismaBin, "migrate", "reset", "--force"]);

    chamadas = [];
    const staging = dbMigrate({ direction: "down", dryRun: false, environment: "staging" }, fakeExec);
    const prod = dbMigrate({ direction: "down", dryRun: false, environment: "production" }, fakeExec);
    expect(staging.success).toBe(false);
    expect(staging.output).toMatch(/only supported for local/);
    expect(prod.success).toBe(false);
    expect(prod.output).toMatch(/blocked/);
    expect(chamadas).toHaveLength(0);
  });

  it("steps vai como argumentos separados", () => {
    dbMigrate({ direction: "up", steps: 2, dryRun: false, environment: "local" }, fakeExec);
    expect(chamadas[0]!.args).toEqual([prismaBin, "migrate", "deploy", "--steps", "2"]);
  });

  it("sem prisma instalado: recusa dizendo onde procurou, sem rodar nada e sem baixar da rede", () => {
    fs.rmSync(path.join(repo, "node_modules"), { recursive: true, force: true });
    const r = dbMigrate({ direction: "up", dryRun: false, environment: "local" }, fakeExec);
    expect(r.success).toBe(false);
    expect(r.output).toMatch(/prisma not found/);
    expect(r.output).toMatch(/node_modules/);
    expect(chamadas).toHaveLength(0);
  });

  it("um prisma ACIMA da raiz do repositório não é usado", () => {
    fs.rmSync(path.join(repo, "node_modules"), { recursive: true, force: true });
    installFakePrisma(base, 'console.log("rodou o prisma de fora do repo");\n');
    const r = dbMigrate({ direction: "up", dryRun: false, environment: "local" }, fakeExec);
    expect(r.success).toBe(false);
    expect(r.output).toMatch(/prisma not found/);
    expect(chamadas).toHaveLength(0);
  });

  it("de verdade (sem exec falso): sobe no Windows e recebe os argumentos intactos", () => {
    const r = dbMigrate({ direction: "up", steps: 3, dryRun: false, environment: "local" });
    expect(r.success, r.output).toBe(true);
    const seen = JSON.parse(r.output.trim().split(/\r?\n/).pop() ?? "{}") as { argv: string[] };
    expect(seen.argv).toEqual(["migrate", "deploy", "--steps", "3"]);
  });

  it("de verdade: a falha do prisma volta como success: false com a saída dele", () => {
    installFakePrisma(repo, 'console.log("P3009 migrate found failed migrations"); process.exit(1);\n');
    const r = dbMigrate({ direction: "up", dryRun: false, environment: "local" });
    expect(r.success).toBe(false);
    expect(r.output).toContain("P3009");
  });
});

// O gate é do registry: o que muda aqui é só como a tool lança o prisma.
describe("db_migrate continua Tier 3: o gate do registry não mudou", () => {
  const originalCwd = process.cwd();
  let base: string;
  let marca: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "db-migrate-gate-"));
    const repo = path.join(base, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    marca = path.join(repo, "migrou.txt");
    installFakePrisma(repo, `require("fs").writeFileSync(${JSON.stringify(marca)}, "x");\nconsole.log("migrated");\n`);
    process.chdir(repo);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("sem allow_tier3: approval required, e o prisma nem sobe", () => {
    const r = dispatch("db_migrate", { direction: "up" }, { allowTier3: false });
    expect(r.ok).toBe(false);
    expect(r.approvalRequired).toBe(true);
    expect(fs.existsSync(marca)).toBe(false);
  });

  it("com allow_tier3 (a aprovação humana): roda de verdade", () => {
    const r = dispatch("db_migrate", { direction: "up" }, { allowTier3: true });
    expect(r.ok, r.output).toBe(true);
    expect(fs.existsSync(marca)).toBe(true);
  });
});
