// Repo git descartável com o framework mínimo do .beads — e SEM node_modules.
//
// Os testes de CLI, de migração e de fluxo git rodam os scripts e hooks de
// verdade, como subprocesso, numa cópia isolada: é o único jeito de provar que
// os gates funcionam numa worktree recém-criada, onde aiteam/node_modules não
// existe. Nada aqui toca o repo hospedeiro nem o .git/config dele.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";

const AITEAM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Arquivos do framework que os gates do .beads precisam, relativos a aiteam/. */
export const BEADS_FRAMEWORK = [
  "githooks/_beads.sh",
  "githooks/post-checkout",
  "githooks/post-merge",
  "githooks/post-commit",
  "githooks/post-rewrite",
  "githooks/pre-commit",
  "scripts/beads-views.mjs",
  "scripts/beads-check.mjs",
  "scripts/migrate-beads.mjs",
  "scripts/beads.mjs",
  "src/beads-core.mjs",
  "src/beads-io.mjs",
  "src/beads-aggregate.mjs",
  "src/beads-cmd.mjs",
  "src/beads-migrate.mjs",
  "src/frontmatter.mjs",
  "vendor/js-yaml.mjs",
  "hooks/session-brief.mjs",
  "src/session-brief-core.mjs",
  "src/infra-kb-core.mjs",
  "hooks/beads-guard.mjs",
  "src/beads-guard-core.mjs",
  "install.mjs",
  "src/install-core.mjs",
  "templates/tier-rules.json",
  "src/tier-rules-loader.mjs",
  "src/tier-core.mjs",
  // F13: o hook que pede confirmação na edição dos arquivos do gate, e o núcleo dele.
  "hooks/gate-edit-guard.mjs",
  "src/gate-files-core.mjs",
  ".gitignore",
  "scripts/worktree-link.mjs",
  "src/worktree-link.mjs",
];

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  out: string;
}

export interface Sandbox {
  dir: string;
  git(...args: string[]): string;
  gitTry(...args: string[]): RunResult;
  write(rel: string, text: string): void;
  read(rel: string): string;
  exists(rel: string): boolean;
  remove(rel: string): void;
  node(script: string, args?: string[], env?: Record<string, string>): RunResult;
  env: Record<string, string>;
  cleanup(): void;
}

function result(r: SpawnSyncReturns<string>): RunResult {
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  return { status: r.status ?? 1, stdout, stderr, out: `${stdout}${stderr}` };
}

export interface SandboxOptions {
  /** Liga core.hooksPath (relativo) nos githooks copiados. */
  hooks?: boolean;
  /** Variáveis extras para todo git/node rodado no sandbox (ex.: BEADS_NOW). */
  env?: Record<string, string>;
  /** Branch inicial. */
  branch?: string;
}

/**
 * Apaga um diretório de teste. As retentativas são a rede de segurança: no
 * Linux o rmdir de `.git/objects` pode dar ENOTEMPTY se algo ainda escreveu ali
 * no meio da limpeza, e no Windows o antivírus segura arquivos recém-criados.
 */
export function rmTree(target: string): void {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * Sem manutenção automática do git. Depois de um commit, de um merge ou de um
 * fast-import com muitos objetos soltos, o git roda `git maintenance run --auto
 * --detach` (ou `gc --auto`): um processo que sai do pai e continua escrevendo em
 * `.git/objects` depois que o teste acabou, e briga com a limpeza do sandbox
 * (ENOTEMPTY na CI do PR #47, A-R1b). Com isso nenhum processo git sobrevive ao teste.
 */
const QUIET_GIT_CONFIG = "[gc]\n\tauto = 0\n\tautoDetach = false\n[maintenance]\n\tauto = false\n";

export function makeSandbox(opts: SandboxOptions = {}): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "beads-sandbox-"));
  // Config global sem a do sistema: o sandbox não herda autocrlf, hooksPath nem
  // nada da máquina, só o gc/maintenance desligado (vale para todo git rodado com
  // este env: o repo, as worktrees, os clones). E nenhuma GIT_* do processo pai:
  // rodando dentro de um hook, um GIT_DIR herdado apontaria o git do teste para o
  // repo de verdade.
  const globalConfig = `${dir}.gitconfig`;
  fs.writeFileSync(globalConfig, QUIET_GIT_CONFIG);
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => !k.toUpperCase().startsWith("GIT_") && v !== undefined)
  ) as Record<string, string>;
  const env: Record<string, string> = {
    ...inherited,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_TERMINAL_PROMPT: "0",
    BEADS_NODE: process.execPath,
    ...(opts.env ?? {}),
  };

  const gitTry = (...args: string[]): RunResult =>
    result(spawnSync("git", args, { cwd: dir, env, encoding: "utf8", windowsHide: true }));
  const git = (...args: string[]): string => {
    const r = gitTry(...args);
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} falhou (${r.status}):\n${r.out}`);
    return r.out;
  };

  for (const rel of BEADS_FRAMEWORK) {
    const src = path.join(AITEAM, ...rel.split("/"));
    if (!fs.existsSync(src)) continue;
    const dst = path.join(dir, "aiteam", ...rel.split("/"));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, fs.readFileSync(src, "utf8").replace(/\r\n/g, "\n"));
    if (rel.startsWith("githooks/")) fs.chmodSync(dst, 0o755);
  }

  git("init", "-q", "-b", opts.branch ?? "main");
  git("config", "user.email", "beads@example.com");
  git("config", "user.name", "beads");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  // Também no repo: um git rodado sem o env do sandbox (ex.: um spawnSync direto
  // no cwd dele) obedece ao mesmo.
  git("config", "gc.auto", "0");
  git("config", "gc.autoDetach", "false");
  git("config", "maintenance.auto", "false");
  if (opts.hooks) git("config", "core.hooksPath", "aiteam/githooks");

  const abs = (rel: string) => path.join(dir, ...rel.split("/"));
  return {
    dir,
    env,
    git,
    gitTry,
    write(rel, text) {
      fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
      fs.writeFileSync(abs(rel), text);
    },
    read: (rel) => fs.readFileSync(abs(rel), "utf8"),
    exists: (rel) => fs.existsSync(abs(rel)),
    remove: (rel) => fs.rmSync(abs(rel), { recursive: true, force: true }),
    node(script, args = [], extra = {}) {
      return result(
        spawnSync(process.execPath, [path.join(dir, "aiteam", ...script.split("/")), ...args], {
          cwd: dir,
          env: { ...env, ...extra },
          encoding: "utf8",
          windowsHide: true,
        })
      );
    },
    cleanup() {
      rmTree(dir);
      fs.rmSync(globalConfig, { force: true });
    },
  };
}

/**
 * Commita o framework copiado (hooks em 100755), sem passar pelos hooks: é o
 * andaime do teste, não o que se testa. `gitignore` cria o .beads/.gitignore
 * do modelo novo; sem ele, o repo pode simular o modelo antigo.
 */
export function commitFramework(s: Sandbox, gitignore?: string): void {
  if (gitignore !== undefined) s.write(".beads/.gitignore", gitignore);
  s.git("add", "--chmod=+x", "aiteam/githooks");
  s.git("add", "-A");
  s.git("commit", "-q", "--no-verify", "-m", "framework");
}

// ── Kit dos testes de fluxo git (beads-git-flow*.test.ts) ────────────────────

export const FLOW_NOW = "2026-10-09T12:00:00Z";
/** Um instante fixo em outubro de 2026, antes do FLOW_NOW. */
export const T = (day: number, hour = 10): string => `2026-10-0${day}T${String(hour).padStart(2, "0")}:00:00Z`;
export const SLOW = { timeout: 180_000 };

/**
 * Registra a limpeza dos sandboxes do arquivo de teste. A folga de event loop
 * entre os testes (os cenários são cheios de spawnSync) vem do setup global,
 * src/vitest-setup.ts, que vale para todo arquivo.
 */
export function useFlowSandboxes(gitignore: string) {
  const sandboxes: Sandbox[] = [];
  const extraDirs: string[] = [];
  // Folga no hook (padrão: 10 s): apagar um repo com centenas de arquivos e
  // várias worktrees, com a máquina carregada, passa disso.
  afterEach(() => {
    for (const s of sandboxes.splice(0)) s.cleanup();
    for (const d of extraDirs.splice(0)) rmTree(d);
  }, 60_000);
  return {
    repo(opts: { legacy?: boolean; env?: Record<string, string>; autocrlf?: boolean } = {}): Sandbox {
      const s = makeSandbox({ hooks: true, env: { BEADS_NOW: FLOW_NOW, ...(opts.env ?? {}) } });
      sandboxes.push(s);
      if (opts.autocrlf) s.git("config", "core.autocrlf", "true");
      commitFramework(s, opts.legacy ? undefined : gitignore);
      return s;
    },
    /** Diretório irmão do sandbox (worktree, clone) apagado no fim do teste. */
    sibling(s: Sandbox, suffix: string): string {
      const d = `${s.dir}-${suffix}`;
      extraDirs.push(d);
      return d;
    },
  };
}

export interface FastCommit {
  branch: string;
  /** caminho → conteúdo, sobre o commit `from`. */
  files: Record<string, string>;
  /** Padrão: refs/heads/main. */
  from?: string;
  /** Segundos desde a época; padrão: agora. */
  at?: number;
}

/**
 * Cria branches por `git fast-import`, num processo só: sem checkout e sem
 * hooks. É como os testes montam dezenas de branches com beads de outra mão.
 */
export function fastImport(s: Sandbox, commits: FastCommit[]): void {
  let stream = "";
  for (const c of commits) {
    const msg = `branch ${c.branch}`;
    stream += `commit refs/heads/${c.branch}\ncommitter beads <beads@example.com> ${c.at ?? Math.floor(Date.now() / 1000)} +0000\n`;
    stream += `data ${Buffer.byteLength(msg)}\n${msg}\nfrom ${c.from ?? "refs/heads/main"}\n`;
    for (const [p, content] of Object.entries(c.files)) stream += `M 100644 inline ${p}\ndata ${Buffer.byteLength(content)}\n${content}\n`;
    stream += "\n";
  }
  const r = spawnSync("git", ["fast-import", "--quiet"], { cwd: s.dir, env: s.env, input: stream, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git fast-import falhou (${r.status}): ${r.stderr}`);
}

export const commitAll = (s: Sandbox, msg: string): string => {
  s.git("add", "-A");
  return s.git("commit", "-q", "-m", msg);
};
export const commitTry = (s: Sandbox, msg: string): RunResult => {
  s.git("add", "-A");
  return s.gitTry("commit", "-q", "-m", msg);
};
export const clean = (s: Sandbox): string => s.git("status", "--porcelain").trim();

/** Um arquivo de definição mínimo e válido. */
export function definition(title: string, createdAt: string, extra = ""): string {
  return `title: "${title}"\ncreated_at: "${createdAt}"\n${extra}`;
}

/** Uma entrada para acrescentar no fim de um arquivo de bead. */
export function entry(at: string, fields: Record<string, string>): string {
  const lines = Object.entries(fields).map(([k, v]) => `    ${k}: ${v.startsWith("[") ? v : JSON.stringify(v)}`);
  return `  - at: "${at}"\n${lines.join("\n")}\n`;
}
