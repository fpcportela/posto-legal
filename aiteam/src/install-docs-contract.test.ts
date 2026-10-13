import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./repo-root.js";
import { ROOT_FILES, checkRootFilesUpstream } from "./root-files-core.mjs";

// `npm --prefix aiteam install` NÃO instala o manifesto de aiteam/. No npm 10 o
// --prefix define só o DESTINO; o manifesto continua vindo do diretório atual.
// Num consumidor sem package.json na raiz o comando falha com ENOENT; num que
// TEM (o caso da migração do layout antigo) ele silenciosamente instala as deps
// erradas em aiteam/node_modules e reporta sucesso — modo de falha pior, porque
// o MCP server fica sem @modelcontextprotocol/sdk e o doctor passa mesmo assim.
// `npm --prefix aiteam run <script>` funciona; a inconsistência entre install e
// run é o que torna isso difícil de perceber. Ver issue #7.
//
// Este teste existe porque a recomendação errada foi REINTRODUZIDA por engano em
// install.mjs depois de a issue já estar aberta: prosa não tem quem a verifique.
const PROIBIDO = /npm\s+--prefix\s+\S*aiteam\S*\s+install\b/;

const arquivosDeTexto = (dir: string, acc: string[] = []): string[] => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) arquivosDeTexto(p, acc);
    else if (/\.(md|mjs|ts|json|yaml|yml)$/.test(e.name) && !p.endsWith("install-docs-contract.test.ts")) {
      acc.push(p);
    }
  }
  return acc;
};

// A5 (issue 38): quem consome o framework recebe o hook que cria a junction do
// node_modules e o baseRef que vale para TODA worktree do Claude Code. As duas
// coisas têm que estar escritas onde ele lê, com o caminho seguro de remoção.
describe("consuming-as-upstream.md — o que o install e o hook fazem com as worktrees", () => {
  const doc = fs
    .readFileSync(path.resolve(repoRoot(), "aiteam", "docs", "consuming-as-upstream.md"), "utf8")
    .replace(/\s+/g, " ");

  it("o baseRef vale para toda worktree que o Claude Code cria, não só a de subagente", () => {
    expect(doc).toMatch(/every worktree Claude Code creates/);
    expect(doc).toMatch(/`claude -w`/);
    expect(doc).not.toMatch(/makes the worktree of a subagent/);
  });

  it("avisa que o git worktree remove cru esvazia o node_modules do principal e aponta o caminho seguro", () => {
    expect(doc).toMatch(/bare `git worktree remove` follows that junction and empties the main checkout's `node_modules`/);
    expect(doc).toContain("node aiteam/scripts/worktree-link.mjs remove <path>");
  });
});

// rb-ai-team#39: a Opção B levava `.beads/SCHEMA.md AGENTS.md CLAUDE.md GEMINI.md`, `.claude/` e `.mcp.json`
// no checkout, arquivos que o próprio guia classifica como do consumidor. Um `git checkout upstream/main --
// <arquivo>` apaga a customização sem erro nem teste vermelho (foi assim que um consumidor perdeu padrões
// Tier-3 locais). Os arquivos de raiz chegam por install, pelo checklist do sync ou por hand-merge, e a
// tabela da seção própria diz qual: prosa não tem quem a verifique.
describe("consuming-as-upstream.md — a Opção B leva só aiteam/, e os arquivos de raiz têm a sua tabela", () => {
  // CRLF: o checkout no Windows (core.autocrlf) grava o .md assim, e os blocos de código são lidos por linha
  const raw = fs.readFileSync(path.resolve(repoRoot(), "aiteam", "docs", "consuming-as-upstream.md"), "utf8").replace(/\r\n/g, "\n");
  const optionB = raw.slice(raw.indexOf("**Option B"));
  const block = /```bash\n([\s\S]*?)```/.exec(optionB)?.[1] ?? "";
  const checkout = block.replace(/\\\n/g, " ").split("\n").find((l) => l.includes("git checkout upstream/main --")) ?? "";
  const pathspecs = checkout.split(" -- ")[1]?.trim().split(/\s+/) ?? [];
  const section = raw.slice(raw.indexOf("## Root files the framework distributes"), raw.indexOf("## Conflicts are cheaper here"));

  it("o bloco da Opção B existe e traz um checkout com pathspec", () => {
    expect(optionB.length).toBeGreaterThan(0);
    expect(pathspecs.length).toBeGreaterThan(0);
  });

  it("todo pathspec do checkout está dentro de aiteam/", () => {
    expect(pathspecs.filter((p) => !p.startsWith("aiteam/"))).toEqual([]);
  });

  it("nenhum arquivo de raiz distribuído, nem .claude/ nem .mcp.json, está no bloco da Opção B", () => {
    for (const p of [...ROOT_FILES.map((f) => f.path), ".claude/", ".mcp.json"]) {
      expect(block, p).not.toContain(p);
    }
  });

  it("a seção dos arquivos de raiz existe e cada arquivo que o framework distribui aparece na tabela", () => {
    expect(section.length).toBeGreaterThan(0);
    for (const f of ROOT_FILES) expect(section, f.path).toContain(`\`${f.path}\``);
  });

  it("a tabela diz o caminho de cada um: install, checklist do sync ou hand-merge", () => {
    for (const word of ["install.mjs", "hand-merge", "copy-once", "checklist"]) expect(section, word).toContain(word);
  });

  it("cada linha que o doctor imprime para os arquivos de raiz está explicada na seção, com o nome que ele imprime", () => {
    const lines = checkRootFilesUpstream({
      upstream: { state: "ok", ref: "upstream/main", sha: "a".repeat(40), ageDays: 1 },
      marker: { state: "absent" },
      since: null,
      local: {},
      remote: {},
      template: null,
      workflows: null,
      workflowsUnavailable: "sem js-yaml",
    });
    expect(lines.length).toBe(5);
    for (const l of lines) expect(section, l.name).toContain(`\`${l.name}\``);
  });

  // QA da #39 (R1): o contrato diz "siga o .beads/SCHEMA.md local até migrar" (beads-schema.md §11), e o apontador manda
  // escrever em .beads/tasks/, que o pre-commit recusa em modo legado. A troca pelo apontador é da migração.
  it("a linha do .beads/SCHEMA.md diz que o apontador só vale depois de migrar: em modo legado a cópia local é o contrato", () => {
    const row = section.split("\n").find((l) => l.startsWith("| `.beads/SCHEMA.md`")) ?? "";
    const flat = row.replace(/\s+/g, " ");
    expect(flat).toMatch(/only after you migrate/);
    expect(flat).toMatch(/legacy mode/);
    expect(flat).toMatch(/local copy is the contract in force/);
    expect(flat).toMatch(/beads-schema\.md[^|]*§11|§11/);
  });

  it("a linha do doctor para o SCHEMA.md também fala do modo legado", () => {
    const row = section.split("\n").find((l) => l.startsWith("| `.beads/SCHEMA.md × upstream`")) ?? "";
    expect(row.replace(/\s+/g, " ")).toMatch(/legacy mode/);
  });

  // QA da #39 (A1): a Opção B nova não leva mais o `.claude/`, então os bindings gerados (.claude/agents/*.md) ficam fora
  // de sincronia com as personas de aiteam/agents/ e o pre-commit recusa o commit ("binding(s) fora de sincronia"; visto
  // no robo-pb-raspagem e no trabalhista). O passo de regenerar vem depois do install e antes de gravar o marcador.
  it("a Opção B manda regenerar os bindings das personas, com o resultado no commit, entre o install e o marcador", () => {
    const install = optionB.indexOf("`node aiteam/install.mjs`");
    const sync = optionB.indexOf("npm --prefix aiteam run sync:agents");
    const record = optionB.indexOf("**Record the sync.**");
    expect(install, "install").toBeGreaterThan(-1);
    expect(sync, "sync:agents").toBeGreaterThan(install);
    expect(record, "Record the sync").toBeGreaterThan(sync);
    const step = optionB.slice(sync - 400, record);
    expect(step).toContain("git add .claude/agents");
    expect(step.replace(/\s+/g, " ")).toMatch(/binding\(s\) fora de sincronia/);
  });

  // QA da #39 (A11): o vigacapital chama o remote do rb-ai-team de `rb-ai-team`; o doctor diz qual e sugere o rename
  it("diz que o doctor aponta o remote com outro nome que é o do rb-ai-team e sugere o git remote rename", () => {
    const flat = section.replace(/\s+/g, " ");
    expect(flat).toContain("git remote rename <name> upstream");
    expect(flat).toMatch(/remote with another name that points to the rb-ai-team/);
  });

  // QA da #39 (A4): o marcador diz de que commit o aiteam/ veio, não que a raiz foi reconciliada com ele.
  it("diz que o marcador não prova que os arquivos de raiz foram reconciliados, e que o doctor é a conferência independente dele", () => {
    const flat = raw.replace(/\s+/g, " ");
    expect(flat).toMatch(/records where your `aiteam\/` came from, \*\*not\*\* that your root files were reconciled/);
    expect(flat).toMatch(/advances the marker even if you skipped a checklist item/);
    expect(flat).toMatch(/does not depend on the marker/);
  });

  it("diz que o doctor só lê, não faz fetch, e que o remote tem de se chamar upstream", () => {
    const flat = section.replace(/\s+/g, " ");
    expect(flat).toMatch(/never runs `git fetch`/);
    expect(flat).toMatch(/read-only and offline/);
    expect(flat).toMatch(/must be named `upstream`/);
    expect(flat).toMatch(/WARN\*\*, never a FAIL/);
  });
});

// O .claude/tier-rules.json fica fora de aiteam/ e não viaja com o vendor. O
// README mandava copiá-lo à mão ("o install não o cria; sem ele o guard falha
// aberto"). Hoje o install o cria a partir de aiteam/templates/tier-rules.json e
// o guard cai nessa cópia: a instrução antiga não pode voltar.
describe("README — o tier-rules.json vem do install, não de uma cópia à mão", () => {
  const readme = fs.readFileSync(path.resolve(repoRoot(), "aiteam", "README.md"), "utf8").replace(/\s+/g, " ");

  it("EN: o install cria o arquivo a partir do template, e a instrução antiga sumiu", () => {
    expect(readme).toMatch(/`install\.mjs` creates it from `aiteam\/templates\/tier-rules\.json`/);
    expect(readme).not.toMatch(/`install\.mjs` does not create it/);
    expect(readme).not.toMatch(/tier-guard fails open/);
  });

  it("PT: o install cria o arquivo a partir do template, e a instrução antiga sumiu", () => {
    expect(readme).toMatch(/`install\.mjs` do passo 3 o cria a partir de `aiteam\/templates\/tier-rules\.json`/);
    expect(readme).not.toMatch(/o `install\.mjs` não o cria/);
    expect(readme).not.toMatch(/tier-guard falha aberto/);
  });

  it("os dois idiomas dizem que o guard cai na cópia canônica quando o arquivo falta", () => {
    expect(readme).toMatch(/protects with the framework's canonical copy \(`aiteam\/templates\/tier-rules\.json`\)/);
    expect(readme).toMatch(/protege com a cópia canônica do framework \(`aiteam\/templates\/tier-rules\.json`\)/);
  });
});

describe("nenhuma doc do framework recomenda `npm --prefix aiteam install`", () => {
  const raiz = repoRoot();

  it("o comando quebrado não aparece em lugar nenhum", () => {
    const ofensores = arquivosDeTexto(path.resolve(raiz, "aiteam"))
      .filter((p) => PROIBIDO.test(fs.readFileSync(p, "utf8")))
      .map((p) => path.relative(raiz, p).replace(/\\/g, "/"));
    expect(ofensores).toEqual([]);
  });

  // A mensagem de erro que o usuário vê no primeiro tropeço é onde uma
  // instrução errada custa mais caro.
  it("o session-brief manda o comando que funciona", () => {
    const brief = fs.readFileSync(path.resolve(raiz, "aiteam", "hooks", "session-brief.mjs"), "utf8");
    expect(brief).toMatch(/cd\s+aiteam\s+&&\s+npm\s+install/);
  });
});
