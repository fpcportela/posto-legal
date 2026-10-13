import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { GITIGNORE_ENTRIES } from "./install-core.mjs";
import { repoRoot } from "./repo-root.js";

// Issue 51: a partir do superpowers 6.2 o SDD (e, desde a 6.4.1, o
// `executing-plans` em modo Native) mantém um ledger por plano em
// `.superpowers/sdd/<plano>/` e o apaga quando a revisão final passa limpa. A
// regra do framework citava `.superpowers/sdd/progress.md`, um caminho que não
// existe mais, e não dizia o que fazer com os rulings que o ledger recebe nem
// como a revisão final do skill se relaciona com o QA. Estes testes fixam o que
// o texto dos agentes tem de dizer; não provam o comportamento do plugin.
const read = (...p: string[]): string => fs.readFileSync(path.resolve(repoRoot(), ...p), "utf8");
const flat = (text: string): string => text.replace(/\s+/g, " ");

const agents = flat(read("aiteam", "AGENTS.md"));
const boot = flat(read("aiteam", "BOOT.md"));
const orchestrator = flat(read("aiteam", "agents", "orchestrator.md"));
const reviewer = flat(read("aiteam", "agents", "qa-security-reviewer.md"));
const reviewerBinding = flat(read(".claude", "agents", "qa-security-reviewer.md"));

describe("workspace .superpowers/ — rascunho do skill, nunca fonte de estado (issue 51, decisão A)", () => {
  it("AGENTS.md e BOOT.md citam o diretório inteiro e não o caminho que deixou de existir", () => {
    for (const [nome, texto] of [["AGENTS.md", agents], ["BOOT.md", boot]] as const) {
      expect(texto, nome).toContain("`.superpowers/`");
      expect(texto, nome).not.toContain("progress.md");
      expect(texto, nome).not.toContain(".superpowers/sdd/progress");
    }
  });

  it("AGENTS.md proíbe qualquer coisa dentro de .superpowers/ como ledger", () => {
    expect(agents).toMatch(/Do not use alternative ledgers, temporary checklists, or anything under `\.superpowers\/`/);
  });

  it("AGENTS.md aceita o workspace como rascunho e manda levar rulings e a revisão final para o bead antes de ele ser apagado", () => {
    expect(agents).toMatch(/`\.superpowers\/` is scratch, never state/);
    expect(agents).toMatch(/superpowers 6\.2/);
    expect(agents).toMatch(/6\.4\.1, `executing-plans` in Native mode/);
    expect(agents).toMatch(/deletes it itself/);
    expect(agents).toMatch(/every ruling the controller records on a conflict with the plan, and the result of the final review/);
    expect(agents).toContain('beads note <id> "…"');
    expect(agents).toContain("beads stage <id> <s>");
    expect(agents).toMatch(/before\*\* the workspace is deleted/);
    expect(agents).toMatch(/the bead wins/);
  });

  it("AGENTS.md diz que o install ignora a pasta, ao lado de .claude/worktrees/", () => {
    expect(agents).toMatch(/`node aiteam\/install\.mjs` adds `\.superpowers\/` to the root `\.gitignore`, next to `\.claude\/worktrees\/`/);
    expect(agents).toMatch(/never turns the draft into history/);
  });

  it("README EN e PT listam o .superpowers/ e o .trello-cache/ entre o que o install acrescenta ao .gitignore", () => {
    const readme = flat(read("aiteam", "README.md"));
    expect(readme).toContain("`.claude/worktrees/`, `.trello-cache/` and `.superpowers/` to `.gitignore`");
    expect(readme).toContain("o `.claude/worktrees/`, o `.trello-cache/` e o `.superpowers/` no `.gitignore`");
  });

  it("consuming-as-upstream.md lista as três regras que o install acrescenta ao .gitignore (QA #51, A5)", () => {
    const doc = flat(read("aiteam", "docs", "consuming-as-upstream.md"));
    expect(doc).toMatch(
      /adds `\.claude\/worktrees\/` \(where Claude Code puts those worktrees\), `\.trello-cache\/` \(the card images the Trello MCP downloads\) and `\.superpowers\/` \(the superpowers skills' scratch workspace\) to your root `\.gitignore`/,
    );
  });

  it("as listas das docs citam toda regra de GITIGNORE_ENTRIES: uma regra nova no install sem a doc reprova", () => {
    const readme = flat(read("aiteam", "README.md"));
    const between = (text: string, from: string, to: string): string => {
      const a = text.indexOf(from);
      const b = text.indexOf(to, a);
      expect(a, from).toBeGreaterThanOrEqual(0);
      expect(b, to).toBeGreaterThan(a);
      return text.slice(a, b);
    };
    const lists = [
      between(readme, "it adds the new hook entries", "`.claude/tier-rules.json` is yours"),
      between(readme, "ele acrescenta ao `.claude/settings.json` as entradas novas", "O `.claude/tier-rules.json` é seu"),
      between(flat(read("aiteam", "docs", "consuming-as-upstream.md")), "adds `.claude/worktrees/`", "creates `.claude/tier-rules.json`"),
    ];
    for (const list of lists) {
      for (const entry of GITIGNORE_ENTRIES) expect(list, `${entry.line} em: ${list.slice(0, 60)}`).toContain(`\`${entry.line}\``);
    }
  });

  it("a tarefa do plano continua virando bead na hora (a regra anterior não foi afrouxada)", () => {
    expect(agents).toMatch(/MUST immediately record those tasks as beads/);
    expect(agents).toMatch(/a task of the plan becomes a bead the moment/i);
  });

  it("BOOT.md diz o mesmo em português: rascunho, ruling e revisão final no bead antes de o skill apagar", () => {
    expect(boot).toMatch(/nada em `\.superpowers\/`[^.]*é fonte de estado/);
    expect(boot).toMatch(/ruling/);
    expect(boot).toMatch(/revisão final/);
    expect(boot).toContain("beads note");
    expect(boot).toMatch(/antes de o skill apagar/);
  });

  it("o Orchestrator não trata o workspace como o ledger e registra os rulings no bead", () => {
    expect(orchestrator).toMatch(/not a `PLAN\.md`, a checklist file, a `\.superpowers\/` workspace, or the conversation/);
    expect(orchestrator).toMatch(/Skill workspaces are scratch/);
    expect(orchestrator).toMatch(/before the skill deletes it/);
  });
});

describe("a revisão final do skill não substitui o QA & Security Reviewer (issue 51, decisão 2)", () => {
  it("AGENTS.md: as duas rodam, e o QA é o gate antes de fechar o bead", () => {
    expect(agents).toMatch(/does not replace the QA & Security Reviewer: both run/);
    expect(agents).toMatch(/remains the gate before a bead is closed/);
    expect(agents).toMatch(/executing-plans/);
    expect(agents).toMatch(/never as its `PASS`/);
  });

  it("o Orchestrator diz o mesmo ao despachar a revisão", () => {
    expect(orchestrator).toMatch(/does not replace it: both run, and the QA & Security Reviewer is the gate before the bead closes/);
  });

  it("a persona do QA diz que a revisão do skill é insumo, nunca o veredito, e o binding nativo acompanha", () => {
    for (const [nome, texto] of [["persona", reviewer], ["binding", reviewerBinding]] as const) {
      expect(texto, nome).toMatch(/A skill's review is not yours/);
      expect(texto, nome).toMatch(/does not stand in for the four checks/);
      expect(texto, nome).toMatch(/only your `PASS` lets the Orchestrator close the bead/);
    }
  });
});
