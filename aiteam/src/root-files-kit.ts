import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Os repos temporários dos testes dos arquivos de raiz × upstream (rb-ai-team#39): um "rb-ai-team" com
// seis commits e um consumidor com o remote `upstream` apontando para ele. O git no Windows leva segundos
// por chamada, então cada arquivo de teste monta o par UMA vez (buildFixture) e cada teste trabalha numa
// cópia da pasta do consumidor (copyConsumer): refs e arquivos à vontade, sem refazer o histórico.

export const DAY = 86_400_000;
export const POINTER = "# .beads — contrato\n> Em [`aiteam/docs/beads-schema.md`](../aiteam/docs/beads-schema.md).\n";
export const OLD_COPY = "# .beads — contrato\n## 1. Visão geral\n## 9. Arquivamento\n";
export const CI_TEMPLATE = [
  "name: CI",
  "on:",
  "  pull_request:",
  "jobs:",
  "  framework:",
  "    steps:",
  "      - run: npm run typecheck",
  "      - run: npm run validate:beads",
  "      - run: npm run validate:agents",
  "      - run: npm run test",
  "  app:",
  "    steps:",
  "      - run: npm run lint",
  "",
].join("\n");

export const WORKFLOW = (...scripts: string[]): string =>
  ["name: CI", "on: [pull_request]", "jobs:", "  t:", "    steps:", ...scripts.map((s) => `      - run: ${s}`), ""].join("\n");

export function git(dir: string, args: string[], env: Record<string, string> = {}): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

export function init(dir: string): void {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["config", "core.autocrlf", "false"]);
}

export function write(dir: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

/** Um commit com a data do committer fixada (a idade da ponta do upstream é o que o doctor mede). */
export function commit(dir: string, message: string, when: Date): string {
  git(dir, ["add", "-A"]);
  const iso = when.toISOString();
  git(dir, ["commit", "-q", "-m", message], { GIT_COMMITTER_DATE: iso, GIT_AUTHOR_DATE: iso });
  return git(dir, ["rev-parse", "HEAD"]);
}

/** As pastas temporárias de um arquivo de teste; `cleanup` as apaga (afterAll). */
export function makeTmp() {
  const dirs: string[] = [];
  return {
    tmp(prefix: string): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `root-files-${prefix}-`));
      dirs.push(dir);
      return dir;
    },
    cleanup(): void {
      for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    },
  };
}

export type Shas = Record<"c1" | "c2" | "c3" | "c4" | "c5" | "c6", string>;

/**
 * O "rb-ai-team": seis commits.
 *   c1 estado inicial · c2 só docs/ · c3 SCHEMA.md vira apontador · c4 AGENTS.md + o modelo do ci.yml ·
 *   c5 só aiteam/src · c6 shims, GEMINI.md e .gitattributes
 * e o consumidor, que já buscou o upstream.
 */
export function buildFixture(tmp: (prefix: string) => string, now: number): { upstreamDir: string; consumerDir: string; shas: Shas } {
  const when = (daysAgo: number) => new Date(now - daysAgo * DAY);
  const upstreamDir = tmp("upstream");
  init(upstreamDir);
  write(upstreamDir, ".beads/SCHEMA.md", OLD_COPY);
  write(upstreamDir, "AGENTS.md", "# AGENTS\n");
  write(upstreamDir, "docs/a.md", "a\n");
  const c1 = commit(upstreamDir, "c1: estado inicial", when(60));
  write(upstreamDir, "docs/b.md", "b\n");
  const c2 = commit(upstreamDir, "c2: só docs", when(50));
  write(upstreamDir, ".beads/SCHEMA.md", POINTER);
  const c3 = commit(upstreamDir, "c3: SCHEMA.md vira apontador", when(40));
  write(upstreamDir, "AGENTS.md", "# AGENTS\n@aiteam/AGENTS.md\n");
  write(upstreamDir, "aiteam/templates/ci.yml.example", CI_TEMPLATE);
  const c4 = commit(upstreamDir, "c4: import no AGENTS.md e modelo do ci.yml", when(30));
  write(upstreamDir, "aiteam/src/x.mjs", "export {};\n");
  const c5 = commit(upstreamDir, "c5: só aiteam/src", when(20));
  write(upstreamDir, "GEMINI.md", "@aiteam/GEMINI.md\n");
  write(upstreamDir, "CLAUDE.md", "@aiteam/CLAUDE.md\n");
  write(upstreamDir, ".gitattributes", "*.mjs text eol=lf\nSPEC.md text eol=lf\n");
  const c6 = commit(upstreamDir, "c6: shims e .gitattributes", when(5));

  // o consumidor: um repo próprio, com o remote `upstream` apontando para o repo acima (o fetch é do TESTE:
  // o código sob teste nunca faz fetch)
  const consumerDir = tmp("consumer");
  init(consumerDir);
  write(consumerDir, "app/main.txt", "o produto\n");
  commit(consumerDir, "consumidor", when(0));
  git(consumerDir, ["remote", "add", "upstream", upstreamDir]);
  git(consumerDir, ["fetch", "-q", "upstream"]);
  return { upstreamDir, consumerDir, shas: { c1, c2, c3, c4, c5, c6 } };
}

/** Uma cópia do consumidor (refs e arquivos à vontade), no estado em que acabou de buscar o upstream. */
export function copyConsumer(tmp: (prefix: string) => string, consumerDir: string): string {
  const dir = tmp("copy");
  fs.cpSync(consumerDir, dir, { recursive: true });
  return dir;
}
