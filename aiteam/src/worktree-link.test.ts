import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GITIGNORE } from "./beads-migrate.mjs";
import { commitFramework, makeSandbox, SLOW, type RunResult, type Sandbox } from "./beads-sandbox.js";
import { removeLink } from "./worktree-link.mjs";

// Issue 38: uma worktree nova nasce sem aiteam/node_modules (é ignorado pelo
// git), e `npm ci` nela reescreveria o do checkout principal. O post-checkout
// liga o aiteam/node_modules do principal — junction no Windows, symlink nos
// demais — e NUNCA roda npm nem sobrescreve o que já existe.
//
// O risco medido (git 2.50.1 for Windows): `git worktree remove`, com ou sem
// --force, SEGUE a junction e apaga o conteúdo do alvo. Por isso o link tem o
// caminho de remoção que o desfaz primeiro (scripts/worktree-link.mjs unlink|remove).
//
// O alvo dos links nestes testes é sempre o aiteam/node_modules FALSO do
// sandbox, descartável — nunca o node_modules de verdade.

const AITEAM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = "aiteam/scripts/worktree-link.mjs";

const isLink = (p: string): boolean => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};
const exists = (p: string): boolean => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

describe("worktree-link — o node_modules compartilhado das worktrees vinculadas", () => {
  const sandboxes: Sandbox[] = [];
  const extras: string[] = [];
  afterEach(() => {
    for (const d of extras.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    for (const s of sandboxes.splice(0)) s.cleanup();
  });

  /** Repo com hooks ligados, .gitignore do node_modules e um aiteam/node_modules falso no principal. */
  const repo = (
    opts: { withModules?: boolean; env?: Record<string, string>; rootIgnore?: boolean; aiteamIgnore?: boolean } = {},
  ): Sandbox => {
    const s = makeSandbox({ hooks: true, ...(opts.env ? { env: opts.env } : {}) });
    sandboxes.push(s);
    if (opts.rootIgnore !== false) s.write(".gitignore", "node_modules/\n");
    commitFramework(s, GITIGNORE);
    if (opts.aiteamIgnore === false) {
      s.git("rm", "-q", "aiteam/.gitignore");
      s.git("commit", "-q", "--no-verify", "-m", "sem aiteam/.gitignore");
    }
    if (opts.withModules !== false) {
      s.write("aiteam/node_modules/fake-pkg/index.js", "module.exports = 'compartilhado';\n");
    }
    return s;
  };

  const sibling = (s: Sandbox, suffix: string): string => {
    const d = `${s.dir}-${suffix}`;
    extras.push(d);
    return d;
  };

  const cli = (s: Sandbox, cwd: string, args: string[]): RunResult => {
    const r = spawnSync(process.execPath, [path.join(s.dir, ...SCRIPT.split("/")), ...args], {
      cwd,
      env: s.env,
      encoding: "utf8",
      windowsHide: true,
    });
    const stdout = r.stdout ?? "";
    const stderr = r.stderr ?? "";
    return { status: r.status ?? 1, stdout, stderr, out: `${stdout}${stderr}` };
  };

  const modulesOf = (dir: string): string => path.join(dir, "aiteam", "node_modules");

  describe("o hook post-checkout", () => {
    it("git worktree add liga o aiteam/node_modules do principal e avisa em uma linha", SLOW, () => {
      const s = repo();
      const wt = sibling(s, "wt");

      const out = s.git("worktree", "add", "-b", "feat/iso", wt);

      expect(isLink(modulesOf(wt))).toBe(true);
      expect(fs.readFileSync(path.join(modulesOf(wt), "fake-pkg", "index.js"), "utf8")).toMatch(/compartilhado/);
      const avisos = out.split("\n").filter((l) => /aiteam\/node_modules/.test(l));
      expect(avisos).toHaveLength(1);
      expect(avisos[0]).toMatch(/principal/);
      expect(avisos[0]).toMatch(/npm/);
      expect(avisos[0]).toMatch(/worktree-link\.mjs remove/);
    });

    it("não toca no checkout principal nem em worktree sem principal com node_modules", SLOW, () => {
      const semModules = repo({ withModules: false });
      const wt = sibling(semModules, "wt");
      const out = semModules.git("worktree", "add", "-b", "feat/iso", wt);
      expect(exists(modulesOf(wt))).toBe(false);
      expect(out).not.toMatch(/aiteam\/node_modules/);

      const comModules = repo();
      comModules.git("switch", "-q", "-c", "outra");
      expect(isLink(modulesOf(comModules.dir))).toBe(false);
      expect(fs.statSync(modulesOf(comModules.dir)).isDirectory()).toBe(true);
    });

    it("nunca sobrescreve um aiteam/node_modules que já existe na worktree", SLOW, () => {
      const s = repo();
      const wt = sibling(s, "wt");
      s.git("-c", `core.hooksPath=${path.join(s.dir, "sem-hooks")}`, "worktree", "add", "-q", "-b", "feat/iso", wt);
      expect(exists(modulesOf(wt))).toBe(false);
      fs.mkdirSync(path.join(modulesOf(wt), "proprio"), { recursive: true });
      fs.writeFileSync(path.join(modulesOf(wt), "proprio", "x.js"), "meu");

      const r = spawnSync("git", ["switch", "-q", "-c", "outra"], { cwd: wt, env: s.env, encoding: "utf8" });

      expect(r.status).toBe(0);
      expect(isLink(modulesOf(wt))).toBe(false);
      expect(fs.readFileSync(path.join(modulesOf(wt), "proprio", "x.js"), "utf8")).toBe("meu");
      expect(`${r.stdout}${r.stderr}`).not.toMatch(/aiteam\/node_modules/);
    });

    it("é idempotente: a segunda troca de branch não avisa de novo nem muda o link", SLOW, () => {
      const s = repo();
      const wt = sibling(s, "wt");
      s.git("worktree", "add", "-q", "-b", "feat/iso", wt);
      const alvo = fs.realpathSync(modulesOf(wt));

      const r = spawnSync("git", ["switch", "-q", "-c", "outra"], { cwd: wt, env: s.env, encoding: "utf8" });

      expect(r.status).toBe(0);
      expect(`${r.stdout}${r.stderr}`).not.toMatch(/aiteam\/node_modules/);
      expect(isLink(modulesOf(wt))).toBe(true);
      expect(fs.realpathSync(modulesOf(wt))).toBe(alvo);
    });

    it("sem node o hook não quebra a criação da worktree e não liga nada", SLOW, () => {
      const s = repo({ env: { BEADS_NODE: "node-que-nao-existe" } });
      const wt = sibling(s, "wt");

      const r = s.gitTry("worktree", "add", "-b", "feat/iso", wt);

      expect(r.status).toBe(0);
      expect(exists(modulesOf(wt))).toBe(false);
    });
  });

  // R3: em Linux/macOS o link é um symlink, e um symlink para diretório NÃO é
  // um diretório para o git: `node_modules/` (barra final) não o casa, ele
  // aparece como `?? aiteam/node_modules` e o `git add -A` o commita como
  // conteúdo. A regra que o cobre é a de aiteam/.gitignore, `/node_modules` sem
  // barra final, versionada e vendorizada com o framework — não depende do
  // .gitignore do consumidor nem de estado local em .git/info/exclude.
  describe("o link nunca vira conteúdo commitável", () => {
    const ainda = (s: Sandbox, wt: string): { status: string; add: string } => {
      const run = (args: string[]): string =>
        spawnSync("git", args, { cwd: wt, env: s.env, encoding: "utf8" }).stdout ?? "";
      return { status: run(["status", "--porcelain"]), add: run(["add", "-A", "-n"]) };
    };

    it("com o .gitignore raiz típico (node_modules/), o status da worktree fica limpo e git add -A não o lista", SLOW, () => {
      const s = repo();
      const wt = sibling(s, "wt");
      s.git("worktree", "add", "-q", "-b", "feat/iso", wt);
      expect(isLink(modulesOf(wt))).toBe(true);

      const { status, add } = ainda(s, wt);

      expect(status).toBe("");
      expect(add).not.toMatch(/node_modules/);
    });

    it("sem nenhuma regra de node_modules no .gitignore raiz, a regra do aiteam/ basta: status limpo, nada para o add -A", SLOW, () => {
      const s = repo({ rootIgnore: false });
      const wt = sibling(s, "wt");
      s.git("worktree", "add", "-q", "-b", "feat/iso", wt);
      expect(isLink(modulesOf(wt))).toBe(true);

      const { status, add } = ainda(s, wt);

      expect(status).toBe("");
      expect(add).not.toMatch(/node_modules/);
      expect(ainda(s, s.dir).status).toBe("");
    });

    it("se o link não ficaria ignorado (sem aiteam/.gitignore nem regra raiz), o hook o desfaz e avisa", SLOW, () => {
      const s = repo({ rootIgnore: false, aiteamIgnore: false });
      const wt = sibling(s, "wt");

      const out = s.git("worktree", "add", "-b", "feat/iso", wt);

      expect(exists(modulesOf(wt))).toBe(false);
      expect(out).toMatch(/não seria ignorado/);
      expect(ainda(s, wt).status).toBe("");
    });

    it("o aiteam/.gitignore do framework ignora /node_modules sem barra final (symlink não é diretório)", () => {
      const rules = fs
        .readFileSync(path.join(AITEAM, ".gitignore"), "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== "" && !l.startsWith("#"));
      expect(rules).toContain("/node_modules");
      expect(rules).not.toContain("node_modules/");
    });
  });

  describe("o código só usa node:* e nunca roda npm", () => {
    it("worktree-link.mjs e o script importam só node:* e não invocam npm", () => {
      for (const rel of ["src/worktree-link.mjs", "scripts/worktree-link.mjs"]) {
        const src = fs.readFileSync(path.join(AITEAM, ...rel.split("/")), "utf8");
        const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]!);
        for (const spec of imports) {
          expect(spec.startsWith("node:") || spec.startsWith("."), `${rel}: ${spec}`).toBe(true);
        }
        expect(src, rel).not.toMatch(/["'](npm|npx)(\.cmd)?["']/);
      }
    });
  });

  describe("unlink — desfaz só o link", () => {
    it("remove o link e deixa o alvo (o node_modules do principal) intacto", SLOW, () => {
      const s = repo();
      const wt = sibling(s, "wt");
      s.git("worktree", "add", "-q", "-b", "feat/iso", wt);
      expect(isLink(modulesOf(wt))).toBe(true);

      const r = cli(s, wt, ["unlink"]);

      expect(r.status, r.out).toBe(0);
      expect(exists(modulesOf(wt))).toBe(false);
      expect(fs.readFileSync(path.join(modulesOf(s.dir), "fake-pkg", "index.js"), "utf8")).toMatch(/compartilhado/);
    });

    it("aceita o caminho da worktree como argumento", SLOW, () => {
      const s = repo();
      const wt = sibling(s, "wt");
      s.git("worktree", "add", "-q", "-b", "feat/iso", wt);

      const r = cli(s, s.dir, ["unlink", wt]);

      expect(r.status, r.out).toBe(0);
      expect(exists(modulesOf(wt))).toBe(false);
      expect(fs.existsSync(path.join(modulesOf(s.dir), "fake-pkg", "index.js"))).toBe(true);
    });

    it("recusa apagar um aiteam/node_modules que não é link", SLOW, () => {
      const s = repo();
      const wt = sibling(s, "wt");
      s.git("-c", `core.hooksPath=${path.join(s.dir, "sem-hooks")}`, "worktree", "add", "-q", "-b", "feat/iso", wt);
      fs.mkdirSync(path.join(modulesOf(wt), "proprio"), { recursive: true });
      fs.writeFileSync(path.join(modulesOf(wt), "proprio", "x.js"), "meu");

      const r = cli(s, wt, ["unlink"]);

      expect(r.status).not.toBe(0);
      expect(r.out).toMatch(/não é um link/);
      expect(fs.readFileSync(path.join(modulesOf(wt), "proprio", "x.js"), "utf8")).toBe("meu");
    });

    // A2: no checkout principal o aiteam/node_modules é o ALVO dos links, nunca
    // um link deste mecanismo. Se for um link (do próprio usuário, para um
    // cache), desfazê-lo seria apagar configuração dele.
    it("recusa o checkout principal, mesmo quando o node_modules dele é um link do usuário", SLOW, () => {
      const s = repo();
      const r = cli(s, s.dir, ["unlink"]);
      expect(r.status).not.toBe(0);
      expect(r.out).toMatch(/principal/);
      expect(fs.existsSync(path.join(modulesOf(s.dir), "fake-pkg", "index.js"))).toBe(true);

      const cache = sibling(s, "cache");
      fs.mkdirSync(path.join(cache, "pkg"), { recursive: true });
      fs.writeFileSync(path.join(cache, "pkg", "i.js"), "cache");
      fs.rmSync(modulesOf(s.dir), { recursive: true, force: true });
      fs.symlinkSync(cache, modulesOf(s.dir), "junction");

      const link = cli(s, s.dir, ["unlink"]);

      expect(link.status).not.toBe(0);
      expect(link.out).toMatch(/principal/);
      expect(isLink(modulesOf(s.dir))).toBe(true);
      expect(fs.readFileSync(path.join(cache, "pkg", "i.js"), "utf8")).toBe("cache");
    });

    it("com o caminho da worktree como argumento, também recusa o principal", SLOW, () => {
      const s = repo();
      const wt = sibling(s, "wt");
      s.git("worktree", "add", "-q", "-b", "feat/iso", wt);
      const r = cli(s, wt, ["unlink", s.dir]);
      expect(r.status).not.toBe(0);
      expect(r.out).toMatch(/principal/);
      expect(fs.existsSync(path.join(modulesOf(s.dir), "fake-pkg", "index.js"))).toBe(true);
      expect(isLink(modulesOf(wt))).toBe(true);
    });

    it("sem link nenhum, numa worktree, não faz nada e sai com 0", SLOW, () => {
      const s = repo({ withModules: false });
      const wt = sibling(s, "wt");
      s.git("worktree", "add", "-q", "-b", "feat/iso", wt);
      expect(cli(s, wt, ["unlink"]).status).toBe(0);
    });
  });

  // A2: o removeLink não pode lançar sem tratamento (um symlink de ARQUIVO faz o
  // rmdir falhar com ENOTDIR no Windows, e o unlink com EISDIR em alguns casos
  // de diretório). Tenta o outro jeito e, se nenhum servir, devolve o erro.
  describe("removeLink — nunca lança", () => {
    const enotdir = Object.assign(new Error("ENOTDIR: not a directory, rmdir"), { code: "ENOTDIR" });
    const eperm = Object.assign(new Error("EPERM: operation not permitted, unlink"), { code: "EPERM" });
    const ops = (impl: { rmdirSync?: () => void; unlinkSync?: () => void }) =>
      ({ rmdirSync: impl.rmdirSync ?? (() => {}), unlinkSync: impl.unlinkSync ?? (() => {}) }) as unknown as typeof fs;

    it("no Windows tenta o rmdir (junction) e cai para o unlink quando o link é um symlink de arquivo", () => {
      const chamadas: string[] = [];
      const r = removeLink(
        "x",
        ops({
          rmdirSync: () => {
            chamadas.push("rmdir");
            throw enotdir;
          },
          unlinkSync: () => {
            chamadas.push("unlink");
          },
        }),
        "win32",
      );
      expect(r).toEqual({ ok: true });
      expect(chamadas).toEqual(["rmdir", "unlink"]);
    });

    it("nos demais tenta o unlink primeiro e só usa o rmdir se ele falhar", () => {
      const chamadas: string[] = [];
      expect(removeLink("x", ops({ unlinkSync: () => void chamadas.push("unlink") }), "linux")).toEqual({ ok: true });
      expect(chamadas).toEqual(["unlink"]);
      const falha = removeLink(
        "x",
        ops({
          unlinkSync: () => {
            throw eperm;
          },
          rmdirSync: () => void chamadas.push("rmdir"),
        }),
        "linux",
      );
      expect(falha).toEqual({ ok: true });
      expect(chamadas).toEqual(["unlink", "rmdir"]);
    });

    it("se nenhum dos dois serve, devolve o erro em vez de lançar", () => {
      const r = removeLink(
        "x",
        ops({
          rmdirSync: () => {
            throw enotdir;
          },
          unlinkSync: () => {
            throw eperm;
          },
        }),
        "win32",
      );
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ message: expect.stringMatching(/EPERM/) });
    });
  });

  describe("remove — o caminho de remoção seguro (git worktree remove segue a junction no Windows)", () => {
    it("remove a worktree e preserva o alvo do link", SLOW, () => {
      const s = repo();
      const wt = sibling(s, "wt");
      s.git("worktree", "add", "-q", "-b", "feat/iso", wt);
      expect(isLink(modulesOf(wt))).toBe(true);

      const r = cli(s, s.dir, ["remove", wt]);

      expect(r.status, r.out).toBe(0);
      expect(fs.existsSync(wt)).toBe(false);
      expect(s.git("worktree", "list", "--porcelain")).not.toContain(path.basename(wt));
      expect(fs.readFileSync(path.join(modulesOf(s.dir), "fake-pkg", "index.js"), "utf8")).toMatch(/compartilhado/);
    });

    it("com --force remove também uma worktree suja, e o alvo continua inteiro", SLOW, () => {
      const s = repo();
      const wt = sibling(s, "wt");
      s.git("worktree", "add", "-q", "-b", "feat/iso", wt);
      fs.writeFileSync(path.join(wt, "sujo.txt"), "não commitado");

      const semForce = cli(s, s.dir, ["remove", wt]);
      expect(semForce.status).not.toBe(0);
      expect(fs.existsSync(wt)).toBe(true);
      expect(fs.existsSync(path.join(modulesOf(s.dir), "fake-pkg", "index.js"))).toBe(true);

      const comForce = cli(s, s.dir, ["remove", wt, "--force"]);
      expect(comForce.status, comForce.out).toBe(0);
      expect(fs.existsSync(wt)).toBe(false);
      expect(fs.readFileSync(path.join(modulesOf(s.dir), "fake-pkg", "index.js"), "utf8")).toMatch(/compartilhado/);
    });

    it("recusa remover o checkout principal", SLOW, () => {
      const s = repo();
      const r = cli(s, s.dir, ["remove", s.dir]);
      expect(r.status).not.toBe(0);
      expect(r.out).toMatch(/principal/);
      expect(fs.existsSync(path.join(modulesOf(s.dir), "fake-pkg", "index.js"))).toBe(true);
    });

    // A2: o remove desfaz QUALQUER link em aiteam/node_modules (no Windows o git
    // seguiria até o alvo, qualquer que fosse). Se o git recusar, o link volta
    // como estava: para o mesmo alvo, e não para o node_modules do principal.
    it("recusado pelo git, devolve o link do usuário ao alvo dele, não ao node_modules do principal", SLOW, () => {
      const s = repo();
      const wt = sibling(s, "wt");
      const cache = sibling(s, "cache");
      fs.mkdirSync(path.join(cache, "pkg"), { recursive: true });
      fs.writeFileSync(path.join(cache, "pkg", "i.js"), "cache");
      s.git("-c", `core.hooksPath=${path.join(s.dir, "sem-hooks")}`, "worktree", "add", "-q", "-b", "feat/iso", wt);
      fs.symlinkSync(cache, modulesOf(wt), "junction");
      fs.writeFileSync(path.join(wt, "sujo.txt"), "não commitado");

      const recusado = cli(s, s.dir, ["remove", wt]);

      expect(recusado.status).not.toBe(0);
      expect(fs.existsSync(wt)).toBe(true);
      expect(isLink(modulesOf(wt))).toBe(true);
      expect(fs.realpathSync(modulesOf(wt))).toBe(fs.realpathSync(cache));
      expect(fs.readFileSync(path.join(cache, "pkg", "i.js"), "utf8")).toBe("cache");

      const forcado = cli(s, s.dir, ["remove", wt, "--force"]);

      expect(forcado.status, forcado.out).toBe(0);
      expect(fs.existsSync(wt)).toBe(false);
      expect(fs.readFileSync(path.join(cache, "pkg", "i.js"), "utf8")).toBe("cache");
      expect(fs.readFileSync(path.join(modulesOf(s.dir), "fake-pkg", "index.js"), "utf8")).toMatch(/compartilhado/);
    });

    it("recusa um caminho que não é worktree deste repositório", SLOW, () => {
      const s = repo();
      const outro = sibling(s, "outro");
      fs.mkdirSync(outro);
      const r = cli(s, s.dir, ["remove", outro]);
      expect(r.status).not.toBe(0);
      expect(fs.existsSync(outro)).toBe(true);
    });
  });
});
