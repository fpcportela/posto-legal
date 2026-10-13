import { spawnSync } from "node:child_process";
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { CHAINED_HOOKS } from "./install-core.mjs";
import { repoRoot } from "./repo-root.js";

// O contrato dos arquivos de aiteam/githooks. O comportamento é provado nos
// beads-git-flow*.test.ts, que rodam os hooks de verdade; aqui ficam as
// propriedades que uma regressão quebraria em silêncio — um hook que não roda
// num clone Linux, um driver de merge que volta, um `git add` escondido.

const DIR = path.resolve(repoRoot(), "aiteam", "githooks");
const read = (name: string): string => fs.readFileSync(path.join(DIR, name), "utf8");
const code = (src: string): string =>
  src
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
const files = fs.readdirSync(DIR).filter((f) => fs.statSync(path.join(DIR, f)).isFile());
const hooks = files.filter((f) => f !== "_beads.sh");

describe("githooks — inventário", () => {
  // install.mjs encadeia CHAINED_HOOKS num core.hooksPath do hospedeiro e o
  // doctor confere a mesma lista: um hook fora dela some no modo roteador.
  it("todo hook do diretório está em CHAINED_HOOKS, e vice-versa", () => {
    expect([...hooks].sort()).toEqual([...CHAINED_HOOKS].sort());
  });

  // Sem o bit de execução no índice do git, um clone Linux ou macOS não roda
  // hook nenhum — e nada avisa.
  it("todo arquivo de aiteam/githooks está em 100755 no git", () => {
    const r = spawnSync("git", ["ls-files", "-s", "--", "aiteam/githooks"], { cwd: repoRoot(), encoding: "utf8" });
    const modes = Object.fromEntries(
      r.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => [l.split("\t")[1]!.replace("aiteam/githooks/", ""), l.split(" ")[0]])
    );
    expect(Object.keys(modes).sort()).toEqual([...files].sort());
    for (const f of files) expect(modes[f], f).toBe("100755");
  });
});

describe("githooks — o modelo antigo não volta", () => {
  it.each(files)("%s não registra nem cita o merge driver beads-yaml", (f) => {
    expect(read(f)).not.toMatch(/beads-yaml|beads-merge/);
  });

  // O .git/config é compartilhado entre o checkout principal e as worktrees:
  // um hook que escreve nele mexe nos outros checkouts (rb-ai-team#37).
  it.each(files)("%s não escreve no .git/config", (f) => {
    expect(code(read(f))).not.toMatch(/git\s+config\b/);
  });

  // rb-ai-team#37 DoD 3: sem driver. O merge do GitHub roda sem ele, e era
  // exatamente esse merge que perdia o backlog.
  it("o .gitattributes não mapeia nada para o driver beads-yaml", () => {
    const attrs = fs.readFileSync(path.resolve(repoRoot(), ".gitattributes"), "utf8");
    expect(attrs).not.toMatch(/beads-yaml/);
  });

  it("o pre-commit não faz git add de nada", () => {
    expect(code(read("pre-commit"))).not.toMatch(/git\s+add\b/);
    expect(code(read("_beads.sh"))).not.toMatch(/git\s+add\b/);
  });

  it("nenhum hook copia ou escreve o active.yaml", () => {
    for (const f of files) expect(code(read(f)), f).not.toMatch(/(cp|>)\s*"?[^\n]*active\.yaml/);
  });
});

describe("githooks — visões regeneradas pelos quatro hooks", () => {
  it.each(["post-checkout", "post-merge", "post-commit", "post-rewrite"])("%s carrega _beads.sh e regenera", (f) => {
    const src = code(read(f));
    expect(src).toMatch(/\.\s+"\$\(dirname "\$0"\)\/_beads\.sh"/);
    expect(src).toMatch(/beads_regenerate/);
  });

  it("o pre-commit aplica a regra de dono fora do modo legado", () => {
    const src = code(read("pre-commit"));
    expect(src).toMatch(/beads_legacy/);
    expect(src).toMatch(/beads_pre_commit \|\| exit 1/);
  });
});
