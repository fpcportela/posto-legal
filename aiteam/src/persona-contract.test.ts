import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./repo-root.js";

// No Claude Code a persona chega pelo binding nativo (.claude/agents/, ADR 0001
// passo 2): o harness carrega o persona-file no contexto do subagente. A linha
// `Persona: <nome> — mandato aplicado: <1 frase>` segue obrigatória por dois
// motivos: é o resumo de uma frase de como o mandato moldou o trabalho, e nos
// engines sem subagente nativo (onde o vínculo é só disciplina de prompt) é a
// única evidência de que o persona-file foi lido. Estes testes fixam esse
// contrato nos templates de dispatch.
const read = (...p: string[]): string =>
  fs.readFileSync(path.resolve(repoRoot(), ...p), "utf8");

const implement = read("aiteam", "prompts", "implement.md");
const review = read("aiteam", "prompts", "review.md");
const orchestrator = read("aiteam", "agents", "orchestrator.md");
const reviewerPersona = read("aiteam", "agents", "qa-security-reviewer.md");

// Toda referência a um persona-file num template de dispatch tem que resolver:
// um ponteiro morto devolve o agente ao estado de "sem mandato", que é
// exatamente o que o contrato existe para evitar.
const personaPointers = (texto: string): string[] => [
  ...new Set(texto.match(/aiteam\/agents\/[a-z-]+\.md/g) ?? []),
];

describe("contrato de dispatch — confirmação de persona no report", () => {
  it("o template do implementer exige a linha de persona na ABERTURA do report", () => {
    expect(implement).toMatch(/^\s*1\.\s*\*\*`?Persona:/m);
    expect(implement).toMatch(/mandato aplicado/i);
  });

  it("o orquestrador cobra a mesma linha ao delegar", () => {
    expect(orchestrator).toMatch(/Persona:/);
    expect(orchestrator).toMatch(/mandato aplicado/i);
  });

  it("o template do reviewer exige a mesma linha", () => {
    expect(review).toMatch(/Persona:/);
    expect(review).toMatch(/mandato aplicado/i);
  });
});

describe("contrato de dispatch — binding do reviewer à persona", () => {
  it("o template de review aponta o persona-file do QA & Security Reviewer", () => {
    expect(review).toMatch(/aiteam\/agents\/qa-security-reviewer\.md/);
  });

  it("o template de review nomeia o Critic-Refiner Loop da persona", () => {
    expect(review).toMatch(/Critic-Refiner Loop/i);
    expect(reviewerPersona).toMatch(/Critic-Refiner Loop/i);
  });

  // A persona decide PASS/FAIL; o template emite APPROVE/REQUEST CHANGES/BLOCK
  // (vocabulário que o review.eval.yaml fixa). Dois vocabulários para o mesmo
  // papel só não é drift se a equivalência estiver escrita.
  it("a equivalência entre os dois vocabulários de veredito está documentada", () => {
    expect(reviewerPersona).toMatch(/\bPASS\b/);
    expect(reviewerPersona).toMatch(/\bFAIL\b/);
    for (const termo of [/\bPASS\b/, /\bFAIL\b/, /APPROVE/, /REQUEST CHANGES/, /BLOCK/]) {
      expect(review, String(termo)).toMatch(termo);
    }
  });
});

// Os evals pareados são pulados quando falta ANTHROPIC_API_KEY — que é o caso
// no CI e na maioria das máquinas. Ou seja: um erro de sintaxe num .eval.yaml
// não aparece em lugar nenhum até alguém rodar com chave. Uma linha
// `Persona: <nome>` não-quotada num item de lista, por exemplo, o YAML lê como
// mapping e o arquivo inteiro para de carregar.
describe("evals pareados — carregam e cobrem o contrato de persona", () => {
  const evalPaths = [
    "implement.eval.yaml",
    "implement-wrong-branch.eval.yaml",
    "implement-harness-worktree.eval.yaml",
    "review.eval.yaml",
    "plan.eval.yaml",
  ].map((f) =>
    path.resolve(repoRoot(), "aiteam", "prompts", f),
  );

  it("todo .eval.yaml dos prompts é YAML válido", () => {
    for (const p of evalPaths) {
      expect(() => yaml.load(fs.readFileSync(p, "utf8")), path.basename(p)).not.toThrow();
    }
  });

  it("os evais de implement e review cobram a linha de persona", () => {
    for (const p of evalPaths.filter((p) => !p.endsWith("plan.eval.yaml"))) {
      const caso = yaml.load(fs.readFileSync(p, "utf8")) as { expected_behavior?: string[] };
      const esperado = (caso.expected_behavior ?? []).join("\n");
      expect(esperado, path.basename(p)).toMatch(/Persona:/);
    }
  });
});

describe("contrato de dispatch — os ponteiros de persona resolvem", () => {
  it("todo persona-file citado nos templates e no orquestrador existe", () => {
    const citados = [
      ...personaPointers(implement),
      ...personaPointers(review),
      ...personaPointers(orchestrator),
    ];
    expect(citados.length).toBeGreaterThan(0);
    for (const alvo of citados) {
      expect(fs.existsSync(path.resolve(repoRoot(), alvo)), alvo).toBe(true);
    }
  });
});

// Issue 38: um subagente despachado com o cwd só em prosa ("Work from: <path>")
// commitou no checkout principal. O isolamento é mecânico — parâmetro do Agent
// tool no despacho — e a checagem de branch é a rede de proteção quando a
// worktree já existe. As duas regras têm que estar escritas onde o Orchestrator
// as lê, e a persona não pode carregar o isolamento no frontmatter (decisão do
// PO: o isolamento é uma escolha do despacho, não da persona).
describe("contrato de dispatch — isolamento em worktree (issue 38)", () => {
  const frontmatterDe = (dir: string[]): Map<string, string> => {
    const abs = path.resolve(repoRoot(), ...dir);
    const out = new Map<string, string>();
    for (const f of fs.readdirSync(abs).filter((f) => f.endsWith(".md"))) {
      const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(path.join(abs, f), "utf8"));
      out.set(`${dir.join("/")}/${f}`, m?.[1] ?? "");
    }
    return out;
  };

  it("o orquestrador manda despachar quem edita arquivos com isolation: \"worktree\"", () => {
    expect(orchestrator).toMatch(/isolation: "worktree"/);
    expect(orchestrator).toMatch(/edits files/i);
  });

  it("o caminho no brief é contexto, não instrução", () => {
    expect(orchestrator).toMatch(/context, not an instruction/i);
  });

  it("com a worktree já criada, o primeiro passo do brief confere a branch, e de novo antes do commit", () => {
    expect(orchestrator).toContain('cd "<absolute path>" && git branch --show-current');
    expect(orchestrator).toMatch(/right before committing/i);
    expect(orchestrator).toMatch(/BLOCKED/);
  });

  it("explica o worktree.baseRef com o valor que preserva commits locais", () => {
    expect(orchestrator).toContain("worktree.baseRef");
    expect(orchestrator).toContain('"head"');
  });

  it("sub-tarefas só de leitura dispensam o isolamento", () => {
    expect(orchestrator).toMatch(/Read-only sub-tasks \(review, exploration\) don't need isolation/);
  });

  it("nenhuma persona (canônica ou binding) carrega isolation no frontmatter", () => {
    const todas = [...frontmatterDe(["aiteam", "agents"]), ...frontmatterDe([".claude", "agents"])];
    expect(todas.length).toBeGreaterThan(0);
    for (const [arquivo, fm] of todas) {
      expect(fm, arquivo).not.toMatch(/^isolation\s*:/m);
    }
  });

  it("o template do implementer confere a branch antes de editar e antes de commitar", () => {
    expect(implement).toContain("git branch --show-current");
    expect(implement).toMatch(/before (?:you )?edit/i);
    expect(implement).toMatch(/before (?:you )?commit|right before every commit/i);
  });

  it("o template do implementer manda parar com BLOCKED quando a branch diverge", () => {
    expect(implement).toMatch(/differs[\s\S]{0,200}BLOCKED/);
  });

  it("o orquestrador e o implementer mandam passar a worktree às tools MCP, que rodam no checkout principal", () => {
    for (const [nome, texto] of [["orchestrator", orchestrator], ["implement", implement]] as const) {
      expect(texto, nome).toMatch(/`git_commit` and `run_tests`/);
      expect(texto, nome).toMatch(/`worktree`/);
    }
  });

  it("a remoção de worktree com o node_modules ligado passa pelo worktree-link, não por git worktree remove cru", () => {
    expect(orchestrator).toContain("node aiteam/scripts/worktree-link.mjs remove <path>");
    const agents = read("aiteam", "AGENTS.md");
    expect(agents).toContain("node aiteam/scripts/worktree-link.mjs remove <path>");
    expect(agents).toMatch(/follows the junction/);
  });

  // O despacho isolado nasce sem aiteam/node_modules e o post-checkout não roda
  // nele (medido; o `claude -w` roda). O plano é o brief mandar ligar à mão.
  it("o despacho isolado nasce sem node_modules: orquestrador e implementer mandam ligar na primeira ação e desligar antes do report", () => {
    for (const [nome, texto] of [["orchestrator", orchestrator], ["implement", implement]] as const) {
      expect(texto, nome).toContain("node aiteam/scripts/worktree-link.mjs link");
      expect(texto, nome).toContain("node aiteam/scripts/worktree-link.mjs unlink");
      expect(texto, nome).toMatch(/first\s+action/i);
      expect(texto, nome).toMatch(/before\s+(?:you\s+|it\s+)?report/i);
    }
  });

  it("o AGENTS.md diz que o npm ci só é perigoso depois do link, e que o hook não roda no despacho isolado", () => {
    const agents = read("aiteam", "AGENTS.md");
    expect(agents).toMatch(/`npm ci` is harmless in a worktree that has no link/);
    expect(agents).toMatch(/dangerous only once the link exists/);
    expect(agents).not.toMatch(/has no `aiteam\/node_modules` \(git ignores it\), and `npm ci` in it would rewrite/);
    expect(agents).toContain("node aiteam/scripts/worktree-link.mjs link");
  });

  it("nenhum texto do framework manda usar worktree.symlinkDirectories (decisão do PO: o brief liga à mão)", () => {
    const hook = read("aiteam", "githooks", "post-checkout");
    for (const [nome, texto] of [
      ["orchestrator", orchestrator],
      ["implement", implement],
      ["AGENTS.md", read("aiteam", "AGENTS.md")],
      ["post-checkout", hook],
    ] as const) {
      expect(texto, nome).not.toMatch(/symlinkDirectories/);
    }
  });

  // No despacho isolado o Orchestrator não sabe a branch: é o harness que a cria.
  // O implementer a descobre na primeira ação, e a prova de que não é o principal
  // vem do git (git-dir ≠ git-common-dir e a branch ≠ a do checkout principal).
  it("o implementer trata o brief sem branch (worktree do harness): a esperada é a da primeira ação, validada contra o principal", () => {
    expect(implement).toMatch(/brief names no branch/i);
    expect(implement).toContain("git rev-parse --git-dir");
    expect(implement).toContain("git rev-parse --git-common-dir");
    expect(implement).toMatch(/differ/i);
    expect(implement).toMatch(/not the branch of the main checkout/i);
    expect(implement).toMatch(/first\s+action/i);
    expect(implement).toMatch(/same\s+(?:name\s+)?right\s+before\s+every\s+commit|before\s+every\s+commit/i);
    expect(implement).toMatch(/bead file/i);
    expect(orchestrator).toMatch(/harness creates the branch, so the brief cannot name it/);
    expect(orchestrator).toContain("`--git-common-dir`");
  });

  // O git_commit sem `worktree` comita no checkout principal, e a checagem ANTES
  // do commit não vê isso: a saída do commit mostra `[<branch> <sha>]`.
  it("o implementer confere, depois de cada commit, que a linha [branch sha] traz a branch esperada", () => {
    expect(implement).toContain("[branch sha]");
    expect(implement).toMatch(/after\s+every\s+commit/i);
    expect(implement).toMatch(/`git_commit`[^.]*without\s+`worktree`[^.]*main\s+checkout/i);
    expect(implement).toMatch(/do\s+not\s+try\s+to\s+undo/i);
  });

  it("o caminho escrito no brief é contexto também no template do implementer", () => {
    expect(implement).toMatch(/context, not an instruction/i);
  });

  describe("eval da worktree do harness, brief sem branch", () => {
    const evalPath = path.resolve(repoRoot(), "aiteam", "prompts", "implement-harness-worktree.eval.yaml");
    const caso = (): { id: string; prompt_file: string; input: string; expected_behavior: string[]; fail_signals: string[] } =>
      yaml.load(fs.readFileSync(evalPath, "utf8")) as ReturnType<typeof caso>;

    it("existe, aponta para o prompt de implement e tem id próprio", () => {
      expect(fs.existsSync(evalPath)).toBe(true);
      const c = caso();
      expect(c.prompt_file).toBe("prompts/implement.md");
      const outros = ["implement.eval.yaml", "implement-wrong-branch.eval.yaml", "review.eval.yaml", "plan.eval.yaml"].map(
        (f) => (yaml.load(fs.readFileSync(path.resolve(repoRoot(), "aiteam", "prompts", f), "utf8")) as { id: string }).id,
      );
      expect(outros).not.toContain(c.id);
    });

    it("o brief não nomeia a branch e a primeira ação mostra uma worktree vinculada numa branch que não é a do principal", () => {
      const c = caso();
      expect(c.input).not.toMatch(/Branch do brief/i);
      expect(c.input).toMatch(/git rev-parse --git-dir/);
      expect(c.input).toMatch(/git rev-parse --git-common-dir/);
      expect(c.input).toMatch(/worktree-agent-/);
    });

    it("espera seguir adiante, sem BLOCKED, e trata como erro o BLOCKED indevido", () => {
      const c = caso();
      expect(c.expected_behavior.join("\n")).toMatch(/Persona:/);
      expect(c.expected_behavior.join("\n")).toMatch(/not .*BLOCKED|no BLOCKED|does not report BLOCKED/i);
      expect(c.fail_signals.join("\n")).toMatch(/BLOCKED/);
    });
  });

  describe("eval da branch errada", () => {
    const evalPath = path.resolve(repoRoot(), "aiteam", "prompts", "implement-wrong-branch.eval.yaml");
    const caso = (): { id: string; prompt_file: string; input: string; expected_behavior: string[]; pass_criteria: Record<string, unknown>; fail_signals: string[] } =>
      yaml.load(fs.readFileSync(evalPath, "utf8")) as ReturnType<typeof caso>;

    it("existe, aponta para o prompt de implement e tem id próprio", () => {
      expect(fs.existsSync(evalPath)).toBe(true);
      const c = caso();
      expect(c.prompt_file).toBe("prompts/implement.md");
      const outros = ["implement.eval.yaml", "review.eval.yaml", "plan.eval.yaml"].map(
        (f) => (yaml.load(fs.readFileSync(path.resolve(repoRoot(), "aiteam", "prompts", f), "utf8")) as { id: string }).id,
      );
      expect(outros).not.toContain(c.id);
    });

    it("a entrada traz a branch esperada e a branch encontrada, diferentes", () => {
      const c = caso();
      expect(c.input).toMatch(/git branch --show-current/);
      expect(c.input).toMatch(/\bmain\b/);
      expect(c.input).toMatch(/worktree-agent-/);
    });

    it("espera a linha de persona, BLOCKED, nenhuma edição e nenhum commit", () => {
      const c = caso();
      const esperado = c.expected_behavior.join("\n");
      expect(esperado).toMatch(/Persona:/);
      expect(esperado).toMatch(/BLOCKED/);
      expect(esperado).toMatch(/commit/i);
      expect(c.fail_signals.join("\n")).toMatch(/commit/i);
      expect(c.pass_criteria["no_implementation_code"]).toBe(true);
    });
  });
});

// Fase 2 da #37: o agente grava os beads com o comando `beads`, e o despacho isolado
// leva a definição do bead à branch do subagente de dois jeitos. O texto dos
// agentes tem de dizer isso — e o comando e o alias que ele cita têm de existir.
describe("protocolo de beads — o comando beads nos textos dos agentes", () => {
  const agents = read("aiteam", "AGENTS.md");
  const pkg = JSON.parse(read("aiteam", "package.json")) as { scripts: Record<string, string> };

  it("o alias `beads` do package.json aponta para o script que existe", () => {
    expect(pkg.scripts["beads"]).toBe("node scripts/beads.mjs");
    expect(fs.existsSync(path.resolve(repoRoot(), "aiteam", "scripts", "beads.mjs"))).toBe(true);
  });

  it("AGENTS.md manda gravar com o comando e diz que editar à mão continua valendo", () => {
    expect(agents).toContain("node aiteam/scripts/beads.mjs");
    expect(agents).toContain("npm --prefix aiteam run beads --");
    expect(agents).toMatch(/Editing your own file by hand stays valid/);
    for (const sub of ["beads new <id>", "beads done <id>", "beads block <id>", "beads note <id>"]) expect(agents, sub).toContain(sub);
    expect(agents).toMatch(/OUTRAS BRANCHES \(não mergeado/);
  });

  it("o Orchestrator documenta os dois jeitos de a definição chegar à branch do subagente", () => {
    expect(orchestrator).toMatch(/commit the bead's definition there \*\*before\*\* dispatching/);
    expect(orchestrator).toContain('worktree.baseRef: "head"');
    expect(orchestrator).toContain('beads new <id> --title "…" --start');
    expect(orchestrator).toMatch(/default branch and do not commit there/);
    expect(orchestrator).toMatch(/A definition left only in your uncommitted tree is a trap/);
    expect(orchestrator).toContain("beads show <id> --all");
  });

  it("o implementer cria o bead com `beads new` quando o brief traz a definição, e reporta BLOCKED se o comando recusar", () => {
    expect(implement).toMatch(/node aiteam\/scripts\/beads\.mjs\s+new <id> --title/);
    expect(implement).toMatch(/bead is not in your tree/);
    expect(implement).toMatch(/do not copy the definition by hand/i);
    expect(implement).toMatch(/report \*\*BLOCKED\*\*/);
    expect(implement).toMatch(/bead file/i);
  });

  // B-R4: o Orchestrator na branch padrão que cria o bead no próprio tree, sem commitar, prende o
  // subagente num ciclo: o `new` dele recusa ("já existe em main") e o `start` manda usar o `new`.
  it("o caminho (b) manda o Orchestrator NÃO criar o bead no próprio tree; o BOOT e o AGENTS têm a ressalva", () => {
    expect(orchestrator).toMatch(/do not create the bead in your own tree/);
    expect(orchestrator).toMatch(/already created it there, give the dispatch another id, or order the subagent to run `beads new … --force`/);
    expect(orchestrator).toMatch(/subagent never uses `--force` on its own/);
    expect(agents).toMatch(/Exception — an isolated dispatch from the default branch/);
    expect(agents).toMatch(/does not create the bead in its own uncommitted tree/);
    expect(read("aiteam", "BOOT.md")).toMatch(/Exceção — despacho isolado a\s+partir da branch padrão/);
    expect(read("aiteam", "BOOT.md")).toMatch(/não crie o bead no seu tree sem commitar/);
  });

  it("o implementer decide (a) ou (b) com `beads show <id>` e cita as duas recusas, BLOCKED nas duas, --force só por ordem do Orchestrator", () => {
    expect(implement).toContain("node aiteam/scripts/beads.mjs show <id>");
    expect(implement).toMatch(/`show` finds it/);
    expect(implement).toMatch(/`show` says the bead does not exist in your tree/);
    expect(implement).toContain("só existe em …");
    expect(implement).toContain("já existe em …");
    expect(implement).toMatch(/in both cases do not copy the definition by hand/i);
    expect(implement).toMatch(/do not retry with `--force` — report \*\*BLOCKED\*\*/);
    expect(implement).toMatch(/`--force` is only for when the Orchestrator orders it in the brief/);
  });

  // Follow-ups finais da frente B: o brief sem definição, o "MUST record as beads" do AGENTS.md
  // e o GEMINI.md (que também orienta engines sem subagente nativo).
  it("A-1: sem o bead no tree e sem a definição no brief, o implementer reporta BLOCKED", () => {
    expect(implement).toMatch(/does not exist in your tree, and the brief does not carry the definition either[^.]*report \*\*BLOCKED\*\*/);
  });

  it("A-2: o 'MUST immediately record those tasks as beads' do AGENTS.md ressalva o despacho isolado a partir da branch padrão", () => {
    const bullet = agents.split("\n").find((l) => l.includes("Single Source of Truth:") && l.includes("MUST immediately record those tasks as beads"));
    expect(bullet).toBeTruthy();
    expect(bullet).toMatch(/isolated dispatch from the default branch/);
    expect(bullet).toMatch(/born on the subagent's branch/);
    expect(bullet).toContain("beads new");
  });

  it("A-3: o GEMINI.md repete a ressalva do consumidor em modo legado", () => {
    const gemini = read("aiteam", "GEMINI.md");
    expect(gemini).toMatch(/consumer still in legacy mode[^.]*refuses with a migration hint[^.]*\.beads\/SCHEMA\.md/);
  });

  // B-A2: o consumidor ainda no modelo antigo recusa o comando com a dica de migração.
  it("implement.md e os persona-files que citam o comando avisam do consumidor em modo legado, e o binding acompanha", () => {
    expect(implement).toMatch(/consumer still in legacy mode[^.]*refuses with the\s+migration hint[^.]*\.beads\/SCHEMA\.md/);
    for (const nome of ["backend-architect", "frontend-expert", "deep-debugger", "qa-security-reviewer", "release-engineer", "product-manager"]) {
      for (const texto of [read("aiteam", "agents", `${nome}.md`), read(".claude", "agents", `${nome}.md`)]) {
        expect(texto, nome).toContain("In a consumer still in legacy mode the `beads` command refuses with a migration hint");
        expect(texto, nome).toContain(".beads/SCHEMA.md");
      }
    }
  });

  it("os persona-files que gravam bead citam o subcomando, e o binding nativo acompanha", () => {
    for (const nome of ["backend-architect", "frontend-expert", "deep-debugger", "qa-security-reviewer"]) {
      const canon = read("aiteam", "agents", `${nome}.md`);
      expect(canon, nome).toContain('beads note <id> "…"');
      expect(read(".claude", "agents", `${nome}.md`), `${nome} (binding)`).toContain('beads note <id> "…"');
    }
    expect(read("aiteam", "agents", "product-manager.md")).toContain("beads new spec-<name>");
    expect(read("aiteam", "agents", "release-engineer.md")).toContain("beads done <id> --summary");
  });
});
