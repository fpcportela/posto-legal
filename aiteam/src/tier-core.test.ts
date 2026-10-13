import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  allowTier3FromSpec,
  classifyTier,
  countCompilablePatterns,
  explainDeny,
  floorDenyCulprit,
  guardDecision,
  isAskEligibleTier3,
  splitSubCommands,
} from "./tier-core.mjs";

// Text that MENTIONS a Tier-3 command is data, not a command. The classifier
// used to regex the whole Bash string, so writing a doc/commit that documents a
// deploy got denied — a false positive that blocked real work and pushed people
// toward workarounds. Narrow, adversarially-tested exceptions: a heredoc body
// (stdin data) and a `git commit -m` message. Everything an interpreter would
// actually RUN must still be caught — that's what the bypass cases below pin.
describe("classifyTier — data vs. commands (heredoc bodies, commit messages)", () => {
  const RULES = {
    tier3: {
      label: "t3",
      patterns: ["vercel\\s+.*--prod\\b", "\\bdrop\\s+(table|database)\\b"],
      ask_patterns: ["vercel\\s+.*--prod\\b"],
    },
    tier2: { label: "t2", patterns: ["\\bgit\\s+commit\\b"] },
  };

  it("a commit message that merely mentions a deploy command is not Tier 3", () => {
    expect(classifyTier('git commit -m "docs: stop calling vercel --prod by hand"', RULES)).toBeLessThan(3);
    expect(classifyTier("git commit -m 'chore: document vercel --prod gating'", RULES)).toBeLessThan(3);
  });

  // Mesmo caso do teste acima, na sintaxe que o Windows/PowerShell exige para
  // mensagem multi-linha (`@'...'@`). Sem isto, documentar um comando Tier 3 no
  // corpo do commit é negado em toda máquina Windows — foi o que aconteceu ao
  // commitar a própria correção do padrão ssh+deploy (2026-07-27).
  it("um here-string do PowerShell em git commit -m é mensagem, não comando", () => {
    const cmd = "git commit -m @'\nfix(tiers): para de chamar vercel --prod na mão\n\nDetalhe: drop table era o exemplo.\n'@";
    expect(classifyTier(cmd, RULES)).toBeLessThan(3);
  });

  it("BYPASS: substituição dentro do here-string ainda conta", () => {
    expect(classifyTier("git commit -m @'\n$(vercel --prod)\n'@", RULES)).toBe(3);
  });

  it("a heredoc body written to a FILE is data, not commands", () => {
    const cmd = "cat > runbook.md << 'EOF'\nRun vercel --prod to ship.\nEOF";
    expect(classifyTier(cmd, RULES)).toBeLessThan(3);
  });

  it("a heredoc piped into git commit -F - is data", () => {
    const cmd = "git commit -F - << 'MSG'\ndocs: explain vercel --prod\nMSG";
    expect(classifyTier(cmd, RULES)).toBeLessThan(3);
  });

  // --- bypass attempts: these MUST stay Tier 3 ---

  it("BYPASS: an interpreter really executes its heredoc body", () => {
    expect(classifyTier("sh << 'EOF'\nvercel --prod\nEOF", RULES)).toBe(3);
    expect(classifyTier("bash << EOF\ndrop table users\nEOF", RULES)).toBe(3);
  });

  it("BYPASS: command substitution inside a commit message still counts", () => {
    expect(classifyTier('git commit -m "$(vercel --prod)"', RULES)).toBe(3);
  });

  it("BYPASS: an UNQUOTED heredoc delimiter expands $(...) — still counts", () => {
    expect(classifyTier("cat > f.md << EOF\n$(vercel --prod)\nEOF", RULES)).toBe(3);
  });

  it("BYPASS: a real deploy chained after a harmless heredoc still counts", () => {
    expect(classifyTier("cat > f.md << 'EOF'\nharmless text\nEOF\nvercel --prod", RULES)).toBe(3);
  });

  it("does not regress the plain cases", () => {
    expect(classifyTier("vercel --prod", RULES)).toBe(3);
    expect(classifyTier("git commit -m 'normal message'", RULES)).toBe(2);
    expect(classifyTier("ls -la", RULES)).toBe(1);
  });
});

// Issue #12, item 2: só o `-m` do `git commit` tinha o literal ignorado, então
// `gh issue comment 12 --body "exemplo: rm -rf build/"` dava deny. A exceção
// vira uma LISTA FECHADA de programa + opção cujo valor o programa guarda ou
// envia como texto e nunca executa. Nunca "qualquer texto entre aspas": em
// `ssh host "…"`, `bash -c "…"` e `docker exec … sh -c "…"` o texto citado É o
// comando.
describe("classifyTier — texto citado em opção de texto não é comando", () => {
  const RULES = {
    tier3: {
      label: "t3",
      patterns: [
        "\\brm\\s+-[a-z]*r[a-z]*f\\b",
        "\\bdrop\\s+(table|database)\\b",
        "\\bgh\\s+workflow\\s+run\\s+\\S*deploy",
      ],
      ask_patterns: ["\\bgh\\s+workflow\\s+run\\s+\\S*deploy"],
    },
    tier2: { label: "t2", patterns: ["\\bgit\\s+commit\\b", "\\bgit\\s+push\\b"] },
  };
  const DEPLOY = "gh workflow run deploy.yml -f ref=v1 -f confirm=deploy";

  it("o caso da issue: corpo de comentário que cita um destrutivo", () => {
    expect(classifyTier('gh issue comment 12 --body "exemplo: rm -rf build/"', RULES)).toBeLessThan(3);
    expect(guardDecision('gh issue comment 12 --body "exemplo: rm -rf build/"', RULES, false)).toBe("allow");
  });

  it("gh issue/pr: --body/-b, --title/-t, --comment/-c, --subject, em qualquer subcomando", () => {
    for (const cmd of [
      'gh pr create --title "x" --body "não rode drop table"',
      'gh pr create -t "rm -rf build" -b "drop table users"',
      "gh issue create --title 'drop table users' --body 'nada'",
      'gh issue close 7 --comment "fechado: rm -rf resolvia"',
      'gh pr close 9 -c "rm -rf não é o caminho"',
      'gh pr merge 9 --squash --subject "drop table x" --body "rm -rf y"',
      'gh pr review 9 --comment -b "evite rm -rf aqui"',
      'gh issue edit 3 --body="exemplo: rm -rf build/"',
      `gh pr comment 9 --body="cita ${DEPLOY}"`,
    ]) {
      expect(classifyTier(cmd, RULES), cmd).toBeLessThan(3);
    }
  });

  it("gh release: --notes/-n e --title/-t", () => {
    expect(classifyTier('gh release create v1 --notes "rm -rf"', RULES)).toBeLessThan(3);
    expect(classifyTier('gh release edit v1 -n "drop table" -t "rm -rf build"', RULES)).toBeLessThan(3);
  });

  it("git commit|tag|merge|notes: -m/--message", () => {
    for (const cmd of [
      'git tag -a v1 -m "rm -rf"',
      'git merge --no-ff -m "drop table era o exemplo" feat/x',
      'git notes add -m "rm -rf build"',
      'git commit --message="drop table x"',
    ]) {
      expect(classifyTier(cmd, RULES), cmd).toBeLessThan(3);
    }
  });

  it("here-string do PowerShell como valor de opção do gh", () => {
    const cmd = "gh pr create --title 'x' --body @'\nNão rode rm -rf build nem drop table.\n'@";
    expect(classifyTier(cmd, RULES)).toBeLessThan(3);
  });

  // --- a lista é fechada: fora dela o texto continua classificado ---

  it("opção fora da lista continua classificada (gh api -f, --body-file)", () => {
    expect(classifyTier('gh api repos/o/r/issues -f body="rm -rf build"', RULES)).toBe(3);
    expect(classifyTier('gh issue create --body-file "rm -rf build"', RULES)).toBe(3);
  });

  it("gh precisa ser o programa líder do sub-comando", () => {
    expect(classifyTier('ssh host gh issue comment 1 --body "rm -rf build"', RULES)).toBe(3);
    expect(classifyTier('sudo gh issue comment 1 --body "rm -rf build"', RULES)).toBe(3);
  });

  it("NUNCA qualquer texto entre aspas: ssh, bash -c e sh -c executam o texto citado", () => {
    for (const cmd of [
      'ssh host "rm -rf /tmp/x"',
      'bash -c "rm -rf x"',
      'docker exec c sh -c "rm -rf /data"',
      "pwsh -Command 'drop table users'",
    ]) {
      expect(classifyTier(cmd, RULES), cmd).toBe(3);
      expect(guardDecision(cmd, RULES, false), cmd).toBe("deny");
    }
  });

  // --- bypass attempts: these MUST stay Tier 3 ---

  it("BYPASS: substituição dentro do valor executa e continua classificada", () => {
    for (const cmd of [
      'gh issue comment 1 --body "$(rm -rf build)"',
      'gh issue comment 1 --body "`rm -rf build`"',
      'gh release create v1 --notes "$(rm -rf build)"',
      "gh pr create --title 'x' --body @\"\n$(rm -rf build)\n\"@",
      'git tag -a v1 -m "$(rm -rf build)"',
    ]) {
      expect(classifyTier(cmd, RULES), cmd).toBe(3);
      expect(guardDecision(cmd, RULES, false), cmd).toBe("deny");
    }
  });

  // Com o literal fora da sondagem, a extração da substituição é a ÚNICA
  // defesa contra o que roda dentro dele: o corpo do `$(…)` é um script
  // inteiro (operadores, aninhamento, parêntese entre aspas) e não pode ser
  // classificado como um bloco só — `echo` na frente o faria parecer inerte.
  it("BYPASS: o corpo da substituição é um script — operadores e aninhamento contam", () => {
    for (const cmd of [
      'gh pr create --title "x" --body "$(echo ok; rm -rf build)"',
      'gh issue comment 1 --body "$(echo ok && rm -rf build)"',
      'gh release create v1 --notes "$(echo $(rm -rf build))"',
      'gh issue comment 1 --body "`echo ok; rm -rf build`"',
      "gh issue comment 1 --body \"$(echo ')'; rm -rf build)\"",
      'gh issue comment 1 --body "$(rm -rf build"',
      'gh issue comment 1 --body "linha`n$(rm -rf build)"',
      'git commit -m "a`n$(rm -rf build)"',
      'git commit -m "$(echo ok; rm -rf build)"',
      'echo "$(echo ok; rm -rf build)"',
    ]) {
      expect(classifyTier(cmd, RULES), cmd).toBe(3);
      expect(guardDecision(cmd, RULES, false), cmd).toBe("deny");
    }
  });

  // Process substitution também executa. Dentro de aspas POSIX o bash não a
  // expande, mas o here-string `@'…'@` é casado de forma frouxa: no bash ele
  // pode atravessar aspas e deixar um `<(…)` fora delas.
  it("BYPASS: process substitution conta, mesmo onde o literal foi removido", () => {
    for (const cmd of [
      "gh issue comment 1 --body @'x' <(rm -rf build) '@'",
      "git commit -m @'x' >(rm -rf build) '@'",
      "diff <(rm -rf build) b.txt",
    ]) {
      expect(classifyTier(cmd, RULES), cmd).toBe(3);
    }
  });

  // Hook que lança exceção sai com código != 0 e o Claude Code trata como erro
  // não-bloqueante: o comando RODA. Aninhamento patológico não pode estourar a
  // pilha do classificador.
  it("BYPASS: aninhamento patológico de $( não derruba o classificador", () => {
    const deep = "$(".repeat(20_000) + "rm -rf build" + ")".repeat(20_000);
    const cmd = `gh issue comment 1 --body "${deep}"`;
    expect(classifyTier(cmd, RULES)).toBe(3);
    expect(guardDecision(cmd, RULES, false)).toBe("deny");
  });

  it("BYPASS: um destrutivo encadeado depois do gh ainda conta", () => {
    for (const cmd of [
      'gh issue comment 1 --body "x" && rm -rf y',
      'gh issue comment 1 --body "x"; rm -rf y',
      'gh pr create --title "a" --body "b" | sh -c "rm -rf y"',
    ]) {
      expect(classifyTier(cmd, RULES), cmd).toBe(3);
      expect(guardDecision(cmd, RULES, false), cmd).toBe("deny");
    }
  });

  // isAskEligibleTier3 testava o sub-comando cru: um commit que CITA um
  // destrutivo derrubava o ASK do deploy encadeado para deny.
  it("ask-eligibility usa a mesma remoção: commit que cita destrutivo + deploy → ask", () => {
    expect(guardDecision(`git commit -m "doc rm -rf" && ${DEPLOY}`, RULES, false)).toBe("ask");
    expect(guardDecision(`gh pr comment 9 --body "rm -rf não" && ${DEPLOY}`, RULES, false)).toBe("ask");
  });

  it("ask-eligibility: substituição destrutiva no commit ainda derruba para deny", () => {
    expect(guardDecision(`git commit -m "$(rm -rf build)" && ${DEPLOY}`, RULES, false)).toBe("deny");
  });

  it("não regride o texto comum (sem nada citado)", () => {
    expect(classifyTier('gh issue comment 12 --body "LGTM"', RULES)).toBe(1);
    expect(classifyTier("git commit -m 'fix'", RULES)).toBe(2);
    expect(classifyTier("git push origin main", RULES)).toBe(2);
  });
});

// Fora de aspas o divisor externo já corta nos operadores; é DENTRO de aspas
// ("$(…)", "`…`") que o corpo chegava inteiro e precisava ser dividido de novo.
describe("splitSubCommands — o corpo de uma substituição é dividido como script", () => {
  it("surfaces each command inside a quoted $(…), quoted backticks and <(…)", () => {
    expect(splitSubCommands('echo "$(date; whoami)"')).toEqual(['echo "$(date; whoami)"', "date", "whoami"]);
    expect(splitSubCommands('echo "`a && b`"')).toEqual(['echo "`a && b`"', "a", "b"]);
    expect(splitSubCommands("diff <(sort a) <(sort b)")).toEqual(["diff <(sort a) <(sort b)", "sort a", "sort b"]);
  });

  it("follows nesting and ignores a ) inside quotes", () => {
    expect(splitSubCommands("echo $(a $(b))")).toEqual(["echo $(a $(b))", "a $(b)", "b"]);
    expect(splitSubCommands(`echo "$(printf ')'; c)"`)).toEqual([`echo "$(printf ')'; c)"`, "printf ')'", "c"]);
  });

  // O backtick é o caractere de escape do PowerShell (`n, `t): um backtick
  // sem par não pode encerrar a varredura e esconder um $(…) que vem depois.
  it("a lone backtick does not hide a later $(…)", () => {
    expect(splitSubCommands('echo "a`n$(b)"')).toEqual(['echo "a`n$(b)"', "b"]);
    expect(splitSubCommands("echo `a")).toEqual(["echo `a"]);
  });
});

// Issue #12, item 3: o deny dizia sempre "ligue o allow_tier3" e citava a
// linha inteira. Para `ssh host reboot` o conselho é errado (controle de host
// não é tarefa de agente — e o break-glass é GLOBAL); para um deploy encadeado
// com um destrutivo, o certo é separar os dois. A razão passa a citar o trecho
// que bloqueia e a vir por classe (`tier3.deny_hints`), com o texto de sempre
// como fallback.
describe("explainDeny — o trecho que bloqueia e a razão por classe", () => {
  const BREAK_GLASS = "Set tier_defaults.allow_tier3: true in SPEC.md after explicit human approval to permit it.";
  const REBOOT_HINT = "Host control is a human's job.";
  const BASE = {
    tier3: {
      label: "t3",
      patterns: [
        "\\brm\\s+-[a-z]*r[a-z]*f\\b",
        "\\bgh\\s+workflow\\s+run\\s+\\S*deploy",
        "\\bssh\\b.*\\b(reboot|shutdown|poweroff)\\b",
      ],
      ask_patterns: ["\\bgh\\s+workflow\\s+run\\s+\\S*deploy"],
    },
    tier2: { label: "t2", patterns: ["\\bgit\\s+commit\\b"] },
  };
  const RULES = {
    ...BASE,
    tier3: { ...BASE.tier3, deny_hints: [{ match: "\\bssh\\b.*\\b(reboot|shutdown|poweroff)\\b", hint: REBOOT_HINT }] },
  };
  const DEPLOY = "gh workflow run deploy.yml -f ref=v1 -f confirm=deploy";

  it("reboot via ssh: a razão da classe, sem mencionar o allow_tier3", () => {
    const r = explainDeny("ssh vps reboot", RULES);
    expect(r).toEqual({ culprit: "ssh vps reboot", hint: REBOOT_HINT });
    expect(r.hint).not.toMatch(/allow_tier3/);
  });

  it("a regex do deny_hints é case-insensitive, como os patterns", () => {
    expect(explainDeny("SSH vps sudo REBOOT", RULES).hint).toBe(REBOOT_HINT);
  });

  it("destrutivo comum mantém a orientação atual (break-glass)", () => {
    expect(explainDeny("rm -rf x", RULES)).toEqual({ culprit: "rm -rf x", hint: BREAK_GLASS });
  });

  it("o culprit é o primeiro sub-comando que bloqueia, não a linha inteira", () => {
    expect(explainDeny("npm run lint && ssh vps reboot && rm -rf x", RULES).culprit).toBe("ssh vps reboot");
    expect(explainDeny('gh issue comment 1 --body "$(rm -rf build)"', RULES).culprit).toBe("rm -rf build");
  });

  it("deploy aprovável + destrutivo na mesma linha: rodar o deploy sozinho e o resto separado", () => {
    const r = explainDeny(`${DEPLOY} && rm -rf dist`, RULES);
    expect(r.culprit).toBe("rm -rf dist");
    expect(r.hint).toContain(DEPLOY);
    expect(r.hint).toMatch(/on its own/);
    expect(r.hint).toMatch(/separate/);
    expect(r.hint).not.toMatch(/allow_tier3/);
  });

  it("a mistura com deploy vence o deny_hints da classe", () => {
    const r = explainDeny(`${DEPLOY} && ssh vps reboot`, RULES);
    expect(r.culprit).toBe("ssh vps reboot");
    expect(r.hint).toMatch(/on its own/);
  });

  it("um deploy só (sem nada aprovável junto) não é 'mistura'", () => {
    const legacy = { ...BASE, tier3: { label: "t3", patterns: BASE.tier3.patterns } };
    expect(explainDeny(DEPLOY, legacy)).toEqual({ culprit: DEPLOY, hint: BREAK_GLASS });
  });

  it("regras sem deny_hints → a razão atual", () => {
    expect(explainDeny("ssh vps reboot", BASE)).toEqual({ culprit: "ssh vps reboot", hint: BREAK_GLASS });
  });

  it("entradas malformadas são ignoradas (cai na seguinte ou no padrão)", () => {
    const withHints = (deny_hints: unknown) =>
      ({ ...BASE, tier3: { ...BASE.tier3, deny_hints } }) as unknown as Parameters<typeof explainDeny>[1];
    for (const bad of [
      "não é lista",
      [null],
      [{ match: "(", hint: "regex inválida" }],
      [{ match: "reboot" }],
      [{ hint: "sem match" }],
      [{ match: 3, hint: "match não é texto" }],
      [{ match: "", hint: "match vazio casaria com tudo" }],
      [{ match: "reboot", hint: "  " }],
    ]) {
      expect(explainDeny("ssh vps reboot", withHints(bad)).hint, JSON.stringify(bad)).toBe(BREAK_GLASS);
    }
    const r = explainDeny("ssh vps reboot", withHints([{ match: "(", hint: "x" }, { match: "reboot", hint: REBOOT_HINT }]));
    expect(r.hint).toBe(REBOOT_HINT);
  });

  it("o primeiro deny_hints que casar vence", () => {
    const rules = {
      ...BASE,
      tier3: { ...BASE.tier3, deny_hints: [{ match: "reboot", hint: "primeiro" }, { match: "ssh", hint: "segundo" }] },
    };
    expect(explainDeny("ssh vps reboot", rules).hint).toBe("primeiro");
  });

  // F15: um deploy negado porque o ask_patterns está quebrado (o guard PULA o padrão que
  // não compila, e sem ele o deploy não pede aprovação: fecha para deny) recebia a razão
  // de sempre, "ligue o allow_tier3". Esse conselho é errado para um deploy: o flag é
  // GLOBAL e libera também rm -rf e drop table — para consertar um typo no arquivo. Com
  // padrão pulado na lista de ask, a razão aponta o doctor, que nomeia a entrada, e diz
  // para não ligar o flag. O destrutivo de verdade segue com o break-glass.
  describe("ask_patterns com padrão pulado — a razão aponta o doctor, não o break-glass (F15)", () => {
    const withAsk = (ask: unknown) =>
      ({ ...BASE, tier3: { ...BASE.tier3, ask_patterns: ask } }) as unknown as Parameters<typeof explainDeny>[1];

    it.each([
      ["um que não compila", ["[unclosed"], 1],
      ["um vazio", [""], 1],
      ["um que não é texto", [42], 1],
      ["dois pulados ao lado de um válido que não é deste comando", ["(", "", "\\bvercel\\b"], 2],
    ])("deploy negado com %s: aponta node aiteam/scripts/doctor.mjs e diz para não ligar o flag", (_label, ask, skipped) => {
      const r = explainDeny(DEPLOY, withAsk(ask));
      expect(r.culprit).toBe(DEPLOY);
      expect(r.hint).toContain("node aiteam/scripts/doctor.mjs");
      expect(r.hint).toContain(`${skipped} ${skipped === 1 ? "entry" : "entries"}`);
      expect(r.hint).toMatch(/do NOT turn on tier_defaults\.allow_tier3 for it/);
      expect(r.hint).toMatch(/global/);
      // O padrão de ask que pegaria o comando foi pulado, então o guard não sabe se é um deploy:
      // a razão é condicional, e o destrutivo que não é deploy segue liberado só pelo break-glass.
      expect(r.hint).toMatch(/Otherwise it is a destructive command, released only by that flag after explicit human approval/);
      expect(r.hint).not.toBe(BREAK_GLASS);
    });

    it("o destrutivo de verdade (piso) mantém o break-glass: consertar o ask não o libera", () => {
      expect(explainDeny("rm -rf x", withAsk(["[unclosed"]))).toEqual({ culprit: "rm -rf x", hint: BREAK_GLASS });
      expect(explainDeny("git push --force origin main", withAsk(["[unclosed"])).hint).toBe(BREAK_GLASS);
    });

    it("ask_patterns ausente (modo legado, fecha de propósito) e ask_patterns íntegro: a razão de sempre", () => {
      expect(explainDeny(DEPLOY, withAsk(undefined)).hint).toBe(BREAK_GLASS);
      expect(explainDeny(DEPLOY, withAsk([])).hint).toBe(BREAK_GLASS);
      expect(explainDeny("ssh vps reboot", withAsk(["\\bgh\\s+workflow\\s+run\\s+\\S*deploy"])).hint).toBe(BREAK_GLASS);
    });

    it("a razão da classe (deny_hints) continua vencendo: reboot não é deploy", () => {
      const rules = { ...RULES, tier3: { ...RULES.tier3, ask_patterns: ["[unclosed"] } };
      expect(explainDeny("ssh vps reboot", rules).hint).toBe(REBOOT_HINT);
    });

    it("o hint não muda o que é negado: o deploy segue deny (fecha), nunca ask", () => {
      expect(guardDecision(DEPLOY, withAsk(["[unclosed"]), false)).toBe("deny");
    });
  });
});

// Revisão de segurança da #12: um padrão que não compila derrubava o hook
// inteiro — `new RegExp` lançava, o hook saía com exit 1 e stdout vazio, e o
// Claude Code trata hook que falha como erro NÃO-bloqueante: o comando rodava
// com o gate desligado. O padrão inválido é ignorado e os outros seguem
// protegendo; o doctor (checkTierRules) é quem aponta o inválido.
describe("padrão inválido nas regras não desliga o gate", () => {
  const DROP = "\\bdrop\\s+(table|database)\\b";
  const DEPLOY_RE = "\\bgh\\s+workflow\\s+run\\s+\\S*deploy";
  type Rules = Parameters<typeof guardDecision>[1];
  const rules = (tier3: string[], ask: string[], tier2: string[]): Rules => ({
    tier3: { label: "t3", patterns: tier3, ask_patterns: ask },
    tier2: { label: "t2", patterns: tier2 },
  });

  it("tier3.patterns: o inválido é ignorado e os outros seguem negando", () => {
    const r = rules(["unbalanced(paren", DROP], [], []);
    expect(classifyTier('psql -c "drop table users"', r)).toBe(3);
    expect(guardDecision('psql -c "drop table users"', r, false)).toBe("deny");
    expect(explainDeny('psql -c "drop table users"', r).culprit).toBe('psql -c "drop table users"');
  });

  it("ask_patterns: o inválido é ignorado e o deploy válido segue pedindo aprovação", () => {
    const r = rules([DROP, DEPLOY_RE], ["[unclosed", DEPLOY_RE], []);
    expect(guardDecision("gh workflow run deploy.yml -f ref=v1", r, false)).toBe("ask");
    expect(guardDecision("drop table users", r, false)).toBe("deny");
  });

  it("ask_patterns só com inválidos: deploy cai para deny, como regra legada (fail closed)", () => {
    expect(guardDecision("gh workflow run deploy.yml", rules([DEPLOY_RE], ["[unclosed"], []), false)).toBe("deny");
  });

  it("tier2.patterns: o inválido é ignorado e os outros seguem classificando", () => {
    expect(classifyTier("git commit -m x", rules([DROP], [], ["*nothing to repeat", "\\bgit\\s+commit\\b"]))).toBe(2);
  });

  it("lista que não é array, entrada que não é texto e banda ausente não lançam; os heurísticos seguem valendo", () => {
    const broken = [
      { tier3: { label: "t3", patterns: "drop table" }, tier2: { label: "t2", patterns: [null, 42] } },
      { tier3: { label: "t3", patterns: [DROP], ask_patterns: 7 }, tier2: { label: "t2" } },
      { tier2: { label: "t2", patterns: [] } },
      {},
    ] as unknown as Rules[];
    for (const r of broken) {
      expect(() => guardDecision("ls -la", r, false), JSON.stringify(r)).not.toThrow();
      expect(guardDecision("rm -rf build", r, false), JSON.stringify(r)).toBe("deny");
      expect(guardDecision("git push --force origin main", r, false), JSON.stringify(r)).toBe("deny");
      expect(() => explainDeny("rm -rf build", r), JSON.stringify(r)).not.toThrow();
    }
  });
});

describe("allowTier3FromSpec — SPEC.md frontmatter gate", () => {
  it("returns true when allow_tier3 is true in frontmatter", () => {
    const spec = "---\ntier_defaults:\n  allow_tier3: true\n---\n\n# Spec\n";
    expect(allowTier3FromSpec(spec)).toBe(true);
  });

  it("returns false when allow_tier3 is false", () => {
    const spec = "---\ntier_defaults:\n  allow_tier3: false\n---\n";
    expect(allowTier3FromSpec(spec)).toBe(false);
  });

  it("defaults to false when the field is missing", () => {
    expect(allowTier3FromSpec("---\nproject: x\n---\n")).toBe(false);
  });

  it("defaults to false when there is no frontmatter at all", () => {
    expect(allowTier3FromSpec("# Just a heading\n")).toBe(false);
  });

  it("defaults to false for empty/undefined input", () => {
    expect(allowTier3FromSpec("")).toBe(false);
    expect(allowTier3FromSpec(undefined)).toBe(false);
  });

  // Windows com core.autocrlf=true grava o SPEC.md com CRLF no checkout. Com a
  // regex estrita o break-glass era ignorado: o humano punha `allow_tier3:
  // true`, como a mensagem de bloqueio manda, e o gate seguia negando
  // (rb-ai-team#36).
  it("o frontmatter em CRLF vale igual ao em LF", () => {
    const lf = "---\ntier_defaults:\n  allow_tier3: true\n---\n\n# Spec\n";
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(allowTier3FromSpec(crlf)).toBe(true);
    expect(allowTier3FromSpec(crlf.replace("allow_tier3: true", "allow_tier3: false"))).toBe(false);
  });
});

// Só a CHAVE libera, e só onde o YAML a põe: filha direta do bloco
// `tier_defaults:` de coluna 0, com o booleano `true` do YAML 1.2. A busca de
// substring antiga (`allow_tier3:\s*true` em qualquer ponto do frontmatter)
// liberava com texto que só CITA o flag, inclusive a própria mensagem de
// bloqueio colada num comentário. Enquanto o CRLF fazia todo gate no Windows
// ler false, o furo não aparecia; lido o CRLF, ele chegou ao Windows (revisão
// de segurança da rb-ai-team#36). Todo caso roda em LF e em CRLF.
describe("allowTier3FromSpec — só a chave allow_tier3 sob tier_defaults libera", () => {
  const spec = (...linhas: string[]) => ["---", ...linhas, "---", "", "# Spec", ""].join("\n");
  const crlf = (s: string) => s.replace(/\n/g, "\r\n");

  const LIBERA: Array<[string, string]> = [
    ["true", spec("tier_defaults:", "  allow_tier3: true")],
    ["true seguido de comentário", spec("tier_defaults:", "  allow_tier3: true # aprovado no chat em 2026-10-05")],
    ["TRUE", spec("tier_defaults:", "  allow_tier3: TRUE")],
    [
      "o frontmatter do template com o flag ligado",
      spec(
        'project: "demo"',
        "budget_usd: 2.00          # per-session hard limit",
        "tier_defaults:",
        "  allow_tier1: true",
        "  allow_tier2: true",
        "  allow_tier3: true       # requires explicit HITL approval",
        "infra_kb:",
        '  remote: ""',
        'last_updated: ""'
      ),
    ],
  ];

  const NEGA: Array<[string, string]> = [
    [
      "a mensagem de bloqueio citada no comentário de um false",
      spec(
        "tier_defaults:",
        "  allow_tier3: false  # Set tier_defaults.allow_tier3: true in SPEC.md after explicit human approval"
      ),
    ],
    [
      "uma linha comentada com true antes do false",
      spec("tier_defaults:", "  # allow_tier3: true  # emergência, desligado", "  allow_tier3: false"),
    ],
    [
      "a mesma linha comentada na coluna 0",
      spec("tier_defaults:", "# allow_tier3: true  # emergência, desligado", "  allow_tier3: false"),
    ],
    ["outra chave que termina com o nome", spec("tier_defaults:", "  disallow_tier3: true")],
    ["a chave em maiúsculas, que é outra chave", spec("tier_defaults:", "  ALLOW_TIER3: true")],
    ["um valor que só começa com true", spec("tier_defaults:", "  allow_tier3: true_nao")],
    ["o flag citado numa string na raiz", spec('example: "allow_tier3: true"', "tier_defaults:", "  allow_tier3: false")],
    ["o flag citado numa string dentro de tier_defaults", spec("tier_defaults:", '  example: "allow_tier3: true"')],
    ["valor vazio seguido de outra chave", spec("tier_defaults:", "  allow_tier3:", "  true_flag: 1")],
    ["valor vazio na raiz seguido de outra chave", spec("allow_tier3:", "true_flag: 1")],
    ["o valor na linha seguinte", spec("tier_defaults:", "  allow_tier3:", "    true")],
    ["a chave sob outro pai", spec("infra_kb:", "  allow_tier3: true", "tier_defaults:", "  allow_tier1: true")],
    ["a chave aninhada abaixo de tier_defaults", spec("tier_defaults:", "  excecoes:", "    allow_tier3: true")],
    ["a chave na raiz", spec("allow_tier3: true")],
    ["true entre aspas, que é string", spec("tier_defaults:", '  allow_tier3: "true"')],
    ["true colado num #, que é string", spec("tier_defaults:", "  allow_tier3: true#sim")],
    ["sem espaço depois dos dois-pontos", spec("tier_defaults:", "  allow_tier3:true")],
    ["a chave duplicada, uma delas false", spec("tier_defaults:", "  allow_tier3: true", "  allow_tier3: false")],
    ["tier_defaults duplicado", spec("tier_defaults:", "  allow_tier3: true", "tier_defaults:", "  allow_tier1: true")],
    ["frontmatter sem cerca de fechamento", "---\ntier_defaults:\n  allow_tier3: true\n\n# Spec\n"],
  ];

  for (const [caso, texto] of LIBERA) {
    it(`libera: ${caso}`, () => {
      expect(allowTier3FromSpec(texto)).toBe(true);
      expect(allowTier3FromSpec(crlf(texto))).toBe(true);
    });
  }

  for (const [caso, texto] of NEGA) {
    it(`nega: ${caso}`, () => {
      expect(allowTier3FromSpec(texto)).toBe(false);
      expect(allowTier3FromSpec(crlf(texto))).toBe(false);
    });
  }
});

// A leitura por linhas do break-glass e o YAML de verdade podem discordar sobre ONDE
// uma linha está. Quando discordam, quem leu "true" pode estar lendo texto de uma
// string, e o gate abre sem o humano ter ligado nada. Em vez de tentar reproduzir o
// YAML inteiro, allowTier3FromSpec NEGA o frontmatter que tem uma construção em que a
// discordância é possível: aspas ou colchetes abertos que atravessam linhas, linha de
// coluna 0 fora do formato `chave:`, indentação com tab e as quebras de linha do YAML
// 1.1 (U+2028/U+2029). Um frontmatter assim nega o flag mesmo escrito de boa-fé: o
// estado seguro é o default, e o conserto é escrever o frontmatter simples.
describe("allowTier3FromSpec — o que a leitura por linhas não consegue garantir nega (F19, F20, F21)", () => {
  const spec = (...linhas: string[]) => ["---", ...linhas, "---", "", "# Spec", ""].join("\n");
  const crlf = (s: string) => s.replace(/\n/g, "\r\n");
  const LIGADO = ["tier_defaults:", "  allow_tier3: true"];

  // F19: uma string entre aspas que atravessa linhas imita `tier_defaults:` com o flag
  // ligado. Para a leitura por linhas é um bloco de verdade; para o YAML é só texto do `title`.
  const NEGA: Array<[string, string]> = [
    ["string de aspas duplas que atravessa linhas e imita o bloco", spec('title: "x', ...LIGADO, '"')],
    ["string de aspas simples que atravessa linhas e imita o bloco", spec("title: 'x", ...LIGADO, "'")],
    ["a string aberta como item de lista", spec('notes:', '  - "x', ...LIGADO, '"')],
    ["a string aberta depois de um colchete", spec('tags: ["a", "b', ...LIGADO, '"]')],
    ["lista de fluxo que atravessa linhas", spec("tags: [a,", ...LIGADO, "]")],
    ["mapa de fluxo que atravessa linhas", spec("extra: { a: 1,", ...LIGADO, "}")],
    ["colchete aberto dentro do próprio tier_defaults", spec("tier_defaults:", "  allow_tier3: true", "  tags: [a,", "    b]")],
    ["linha de coluna 0 que não é `chave:` depois do bloco", spec(...LIGADO, "texto solto")],
    ["linha de coluna 0 que não é `chave:` antes do bloco", spec("texto solto", ...LIGADO)],
    ["item de lista na raiz", spec("- item", ...LIGADO)],
    ["aspas soltas na coluna 0", spec(...LIGADO, '"')],
    // F21: o YAML não aceita tab na indentação; o leitor por linhas aceitava.
    ["indentação com tab", spec("tier_defaults:", "\tallow_tier3: true")],
    ["tab misturado na indentação", spec("tier_defaults:", " \tallow_tier3: true")],
    // F20: LS e PS quebram linha no YAML 1.1 e não no 1.2 nem na leitura por linhas.
    ["U+2028 (separador de linha) em qualquer ponto do frontmatter", spec(...LIGADO, "nota: a\u2028b")],
    ["U+2029 (separador de parágrafo) num comentário", spec(...LIGADO, "# a\u2029b")],
    ["U+2028 escondendo a chave", spec("tier_defaults:\u2028  allow_tier3: true")],
  ];

  for (const [caso, texto] of NEGA) {
    it(`nega: ${caso}`, () => {
      expect(allowTier3FromSpec(texto), caso).toBe(false);
      expect(allowTier3FromSpec(crlf(texto)), `${caso} (CRLF)`).toBe(false);
    });
  }

  // O que NÃO pode virar falso negativo: o frontmatter que o template gera e o que um
  // humano escreve de boa-fé continuam liberando.
  const LIBERA: Array<[string, string]> = [
    ["strings fechadas na mesma linha, vazias ou com : e # dentro", spec('title: "a: b # c"', "empty: ''", 'vazio: ""', ...LIGADO)],
    ["aspas escapadas dentro da string", spec('title: "diz \\"oi\\" aqui"', "outro: 'it''s fine'", ...LIGADO)],
    ["apóstrofo e aspas no meio de um texto simples não abrem string", spec("description: Rios Braz's CRM, o \"melhor\"", ...LIGADO)],
    ["aspas e colchete dentro de um comentário", spec("tier_defaults:", "  allow_tier3: true  # don't \"quote\" [me", "  allow_tier1: true")],
    ["lista e mapa de fluxo fechados na mesma linha", spec("tags: [a, b, \"c\"]", "extra: { a: 1, b: [2, 3] }", ...LIGADO)],
    ["itens de lista fechados e comentários na coluna 0", spec("# comentário", "notes:", '  - "um"', "  - dois", "", ...LIGADO)],
    ["chaves com ponto, hífen e sublinhado", spec("last_updated: 2026-10-06", "budget_usd: 2.00", "my-key.v2: x", ...LIGADO)],
  ];

  for (const [caso, texto] of LIBERA) {
    it(`libera: ${caso}`, () => {
      expect(allowTier3FromSpec(texto), caso).toBe(true);
      expect(allowTier3FromSpec(crlf(texto)), `${caso} (CRLF)`).toBe(true);
    });
  }

  // F9 e F20 no leitor compartilhado (frontmatter.mjs): o BOM e o CR solto não escondem o bloco.
  it("um BOM no início do arquivo não esconde o frontmatter (o Set-Content do PowerShell 5 o grava)", () => {
    expect(allowTier3FromSpec(`\uFEFF${spec(...LIGADO)}`)).toBe(true);
    expect(allowTier3FromSpec(`\uFEFF${crlf(spec(...LIGADO))}`)).toBe(true);
    expect(allowTier3FromSpec(`\uFEFF${spec("tier_defaults:", "  allow_tier3: false")}`)).toBe(false);
  });

  it("quebras de linha só com CR (o YAML também as lê como quebra) valem como LF", () => {
    expect(allowTier3FromSpec(spec(...LIGADO).replace(/\n/g, "\r"))).toBe(true);
    expect(allowTier3FromSpec(spec("tier_defaults:", "  allow_tier3: false").replace(/\n/g, "\r"))).toBe(false);
  });
});

describe("guardDecision — allow/ask/deny", () => {
  const RULES = {
    tier3: {
      label: "t3",
      patterns: ["vercel\\s+.*--prod\\b", "\\bdrop\\s+(table|database)\\b"],
      ask_patterns: ["vercel\\s+.*--prod\\b"],
    },
    tier2: { label: "t2", patterns: ["\\bgit\\s+commit\\b"] },
  };

  it("tier 1/2 → allow", () => {
    expect(guardDecision("ls -la", RULES, false)).toBe("allow");
    expect(guardDecision("git commit -m x", RULES, false)).toBe("allow");
  });

  it("deploy sem flag → ask (aprovação one-shot no chat)", () => {
    expect(guardDecision("vercel --prod", RULES, false)).toBe("ask");
  });

  it("destrutivo sem flag → deny", () => {
    expect(guardDecision("drop table users", RULES, false)).toBe("deny");
    expect(guardDecision("rm -rf /", RULES, false)).toBe("deny");
  });

  it("misto deploy+destrutivo → deny", () => {
    expect(guardDecision("vercel --prod && rm -rf /", RULES, false)).toBe("deny");
  });

  it("allow_tier3 true é break-glass: tudo tier 3 → allow", () => {
    expect(guardDecision("vercel --prod", RULES, true)).toBe("allow");
    expect(guardDecision("drop table users", RULES, true)).toBe("allow");
  });

  it("rules legado sem ask_patterns → deny (comportamento atual preservado)", () => {
    const legacy = { tier3: { label: "t3", patterns: RULES.tier3.patterns }, tier2: RULES.tier2 };
    expect(guardDecision("vercel --prod", legacy, false)).toBe("deny");
  });

  // Regressão (#12): o alias `rm` do PowerShell com os parâmetros por extenso
  // já cai no heurístico do bash (case-insensitive) — mesmo com regras que não
  // trazem padrão nenhum de PowerShell, como as deste describe.
  it("rm -Recurse -Force (alias do PowerShell) é deny pelo heurístico, sem padrão próprio", () => {
    expect(guardDecision("rm -Recurse -Force .\\dist", RULES, false)).toBe("deny");
    expect(guardDecision("rm -Force -Recurse dist", RULES, false)).toBe("deny");
  });
});

// F14: o cabeçalho do tier-core dizia "dependency-free" e deixou de ser verdade quando o
// allowTier3FromSpec passou a ler o frontmatter por frontmatter.mjs. O hook o carrega em
// node puro, sem node_modules: o que importa é a LISTA de imports, e é ela que se fixa.
describe("tier-core.mjs — carregável pelo hook em node puro (o cabeçalho diz a verdade)", () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(HERE, "tier-core.mjs"), "utf8");
  const imports = [...src.matchAll(/^\s*import\b[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);

  it("não tem shebang", () => {
    expect(src.startsWith("#!")).toBe(false);
  });

  it("importa só ./frontmatter.mjs: nenhum node:*, nenhum pacote", () => {
    expect(imports).toEqual(["./frontmatter.mjs"]);
  });

  it("o cabeçalho nomeia o único import em vez de prometer 'dependency-free'", () => {
    expect(src).not.toMatch(/^\/\/ Pure, dependency-free/m);
    expect(src).toMatch(/ONE import: \.\/frontmatter\.mjs/);
  });
});

// F18: os padrões compilados ficam num WeakMap indexado pela IDENTIDADE da lista, não
// pelo conteúdo. É documentado em tier-core.d.mts; aqui o comportamento fica fixado, para
// que mudar para um cache por conteúdo force a revisão da documentação.
describe("cache de padrões — indexado pela identidade da lista (documentado em tier-core.d.mts)", () => {
  type Rules = Parameters<typeof classifyTier>[1];
  const build = (patterns: string[], hints?: Array<{ match: string; hint: string }>): Rules =>
    ({
      tier3: { label: "t3", patterns, ask_patterns: [], ...(hints ? { deny_hints: hints } : {}) },
      tier2: { label: "t2", patterns: [] },
    }) as Rules;

  it("alterar a lista NO LUGAR depois do primeiro uso não vale: os padrões antigos seguem aplicando", () => {
    const patterns = ["\\bdrop\\s+table\\b"];
    const rules = build(patterns);
    expect(classifyTier("meu-marcador", rules)).toBe(1);
    patterns.push("\\bmeu-marcador\\b");
    expect(classifyTier("meu-marcador", rules)).toBe(1); // ainda o cache da lista antiga
  });

  it("uma lista NOVA (ou um objeto de regras novo com lista nova) vale na hora", () => {
    const patterns = ["\\bdrop\\s+table\\b"];
    expect(classifyTier("meu-marcador", build(patterns))).toBe(1);
    expect(classifyTier("meu-marcador", build([...patterns, "\\bmeu-marcador\\b"]))).toBe(3);
  });

  it("o mesmo vale para ask_patterns", () => {
    const patterns = ["\\bgh\\s+workflow\\s+run\\b"];
    const ask: string[] = [];
    const rules = { tier3: { label: "t3", patterns, ask_patterns: ask }, tier2: { label: "t2", patterns: [] } } as Rules;
    expect(guardDecision("gh workflow run deploy.yml", rules, false)).toBe("deny");
    ask.push("\\bgh\\s+workflow\\s+run\\b");
    expect(guardDecision("gh workflow run deploy.yml", rules, false)).toBe("deny"); // cache da lista vazia
    const fresh = { tier3: { ...rules.tier3, ask_patterns: [...ask] }, tier2: rules.tier2 } as Rules;
    expect(guardDecision("gh workflow run deploy.yml", fresh, false)).toBe("ask");
  });

  // O deny_hints NÃO entra no cache: é compilado a cada negação.
  it("deny_hints não é cacheado: alterar no lugar vale na próxima negação", () => {
    const hints = [{ match: "nunca-casa-xyz", hint: "primeiro" }];
    const rules = build(["\\bdrop\\s+table\\b"], hints);
    expect(explainDeny("drop table x", rules).hint).not.toBe("segundo");
    hints[0] = { match: "drop", hint: "segundo" };
    expect(explainDeny("drop table x", rules).hint).toBe("segundo");
  });
});

// Quantos padrões da lista o guard consegue APLICAR: as strings que compilam com
// `new RegExp(p, "i")`. É a mesma regra do compilePatterns (que pula o resto), e
// serve ao carregador do mapa de tiers para recusar uma lista em que o guard não
// aplicaria nenhum padrão.
describe("countCompilablePatterns — a mesma semântica do guard", () => {
  it("conta só as strings que compilam", () => {
    expect(countCompilablePatterns(["\\bdrop\\b", "(", "[a-", 5, null, "vercel\\s+.*--prod\\b"])).toBe(2);
  });

  it.each([[["(", "[a-"]], [[123]], [[]], [undefined], [null], ["texto"], [{}]])("%j → 0", (list) => {
    expect(countCompilablePatterns(list as unknown)).toBe(0);
  });

  it("concorda com o que guardDecision aplica de fato", () => {
    const rules = { tier3: { label: "t3", patterns: ["(", "\\bdrop\\s+table\\b"] }, tier2: { label: "t2", patterns: [] } };
    expect(countCompilablePatterns(rules.tier3.patterns)).toBe(1);
    expect(guardDecision("drop table users", rules, false)).toBe("deny");
  });

  // `""` compila — e casa com TODO comando. O compilador o pula, como pula o `match`
  // vazio de um deny_hints: um padrão que não distingue nada não é uma regra.
  it.each([[[""]], [["   "]], [["\t", " \n "]], [["", "("]]])("%j → 0: texto vazio ou só espaço casaria com tudo", (list) => {
    expect(countCompilablePatterns(list)).toBe(0);
  });

  it("um padrão vazio ao lado de um válido não conta", () => {
    expect(countCompilablePatterns(["", "\\bdrop\\b", "  "])).toBe(1);
  });
});

// `new RegExp("")` casa com qualquer texto. Em tier3.patterns isso negava TODO comando
// (nem o `ls` passava) e, pior, em ask_patterns fazia todo Tier 3 virar "ask": o
// destrutivo (drop table) saía do deny, que só o break-glass destrava, para um
// prompt de um clique. O compilador pula o vazio e o que é só espaço.
describe("padrão vazio ou só de espaço — o guard o pula, não casa com tudo", () => {
  const BASE = {
    tier3: { label: "t3", patterns: ["\\bdrop\\s+(table|database)\\b", "vercel\\s+.*--prod\\b"], ask_patterns: ["vercel\\s+.*--prod\\b"] },
    tier2: { label: "t2", patterns: ["\\bgit\\s+commit\\b"] },
  };
  const withPatterns = (extra: string[]) => ({ ...BASE, tier3: { ...BASE.tier3, patterns: [...extra, ...BASE.tier3.patterns] } });
  const withAsk = (extra: string[]) => ({ ...BASE, tier3: { ...BASE.tier3, ask_patterns: [...extra, ...BASE.tier3.ask_patterns] } });

  it.each([[""], ["   "], ["\t"]])("%j em tier3.patterns: o comando inofensivo segue livre", (empty) => {
    const rules = withPatterns([empty]);
    expect(classifyTier("ls -la", rules)).toBe(1);
    expect(guardDecision("ls -la", rules, false)).toBe("allow");
    // e o que os outros padrões pegam continua pego
    expect(guardDecision("drop table users", rules, false)).toBe("deny");
    expect(guardDecision("vercel --prod", rules, false)).toBe("ask");
  });

  it.each([[""], ["   "]])("%j em ask_patterns: o destrutivo continua deny, nunca vira ask", (empty) => {
    const rules = withAsk([empty]);
    expect(guardDecision("drop table users", rules, false)).toBe("deny");
    expect(isAskEligibleTier3("drop table users", rules)).toBe(false);
    expect(guardDecision("vercel --prod", rules, false)).toBe("ask");
  });

  it("ask_patterns só com vazio: nenhum deploy é ask-eligible (fecha para deny, como sem ask_patterns)", () => {
    const rules = { ...BASE, tier3: { ...BASE.tier3, ask_patterns: ["", "  "] } };
    expect(isAskEligibleTier3("vercel --prod", rules)).toBe(false);
    expect(guardDecision("vercel --prod", rules, false)).toBe("deny");
  });

  it("em tier2.patterns o vazio também não promove todo comando a Tier 2", () => {
    const rules = { ...BASE, tier2: { label: "t2", patterns: ["", "\\bgit\\s+commit\\b"] } };
    expect(classifyTier("ls -la", rules)).toBe(1);
    expect(classifyTier("git commit -m x", rules)).toBe(2);
  });
});

// O piso fixo: `rm` recursivo+forçado e `git push --force` são heurísticos do
// tier-core, que valem SEM regra nenhuma. É o último recurso do tier-guard
// quando nem o mapa do projeto nem a cópia canônica do framework servem (um
// vendor quebrado): o guard segue o fluxo normal com regras vazias. O PO decidiu
// que o último recurso NÃO é negar tudo — isso travaria o conserto
// (`git checkout`, `node aiteam/install.mjs`) — e que também não é liberar tudo.
describe("piso fixo — vale sem regras (último recurso do guard)", () => {
  type Rules = Parameters<typeof guardDecision>[1];
  const NONE = {} as Rules;

  it.each([
    ["rm -rf /"],
    ["rm -fr build"],
    ["rm -r -f dist"],
    ["rm -Recurse -Force dist"],
    ["git push --force origin main"],
    ["git push origin main --force"],
    ["ls && rm -rf /"],
  ])("%s → deny, sem nenhuma regra", (command) => {
    expect(guardDecision(command, NONE, false)).toBe("deny");
  });

  it.each([["ls -la"], ["git status"], ["git checkout -- ."], ["node aiteam/install.mjs"], ["git push --force-with-lease origin x"]])(
    "%s → allow: o conserto não fica travado",
    (command) => {
      expect(guardDecision(command, NONE, false)).toBe("allow");
    }
  );

  // O limite conhecido e decidido: o que só um padrão pega passa sem regras.
  it("drop table e deploy passam sem regras: só o piso protege", () => {
    expect(guardDecision("psql -c 'drop table users'", NONE, false)).toBe("allow");
    expect(guardDecision("gh workflow run deploy.yml -f ref=v1", NONE, false)).toBe("allow");
    expect(guardDecision("npx prisma migrate deploy", NONE, false)).toBe("allow");
  });

  it("o motivo do deny do piso cita o trecho e traz a instrução do break-glass", () => {
    const { culprit, hint } = explainDeny("ls && rm -rf /", NONE);
    expect(culprit).toBe("rm -rf /");
    expect(hint).toMatch(/allow_tier3/);
  });

  it("o break-glass allow_tier3 libera o piso, como libera qualquer regra", () => {
    expect(guardDecision("rm -rf /", NONE, true)).toBe("allow");
  });
});

// Onda 2, item 2 (F3): quando o hook tropeça numa exceção que não esperava, ele não pode
// liberar tudo. floorDenyCulprit é o piso do #49 sozinho, para o caso em que nem o
// classificador completo nem o mapa estão disponíveis: o mesmo piso de guardDecision com
// regras vazias, só que dito em "qual é o trecho".
describe("floorDenyCulprit — o piso fixo quando o classificador lança (F3)", () => {
  it.each([
    ["rm -rf /", "rm -rf /"],
    ["rm -fr build", "rm -fr build"],
    ["rm -r -f dist", "rm -r -f dist"],
    ["rm -Recurse -Force dist", "rm -Recurse -Force dist"],
    ["git push --force origin main", "git push --force origin main"],
    ["git push origin main --force", "git push origin main --force"],
    ["ls && rm -rf /", "rm -rf /"],
    ["echo ok; git push --force origin x", "git push --force origin x"],
  ])("%s → o culpado é o trecho que o piso nega", (command, culprit) => {
    expect(floorDenyCulprit(command)).toBe(culprit);
  });

  it.each([
    ["ls -la"],
    ["git status"],
    ["git push --force-with-lease origin x"],
    // O piso é só rm -rf e force-push: o que um padrão pegaria passa, como no #49.
    ["psql -c 'drop table users'"],
    ["gh workflow run deploy.yml -f ref=v1"],
    // Texto que cita o comando é dado, como no classificador.
    ["echo rm -rf /"],
    ['git commit -m "docs: nao use rm -rf nem git push --force"'],
    [""],
  ])("%s → null (o piso libera o resto)", (command) => {
    expect(floorDenyCulprit(command)).toBeNull();
  });

  it("a conclusão é a de guardDecision com regras vazias, comando a comando", () => {
    const NONE = {} as Parameters<typeof guardDecision>[1];
    for (const command of [
      "rm -rf /",
      "ls",
      "git push --force origin main",
      "git push --force-with-lease origin main",
      "cat > a.md <<'EOF'\nrm -rf /\nEOF",
      "echo $(rm -rf /)",
      "x=$(git push --force)",
    ]) {
      expect(floorDenyCulprit(command) !== null, command).toBe(guardDecision(command, NONE, false) === "deny");
    }
  });

  // Se o divisor também lançar, o piso grosso olha o texto inteiro: pode negar a mais (um
  // `rm -rf` citado), nunca a menos. É o último degrau, só dentro de uma exceção.
  it("se o divisor lança, o piso grosso olha o texto inteiro e nega o que nega o fino", () => {
    const broken = () => {
      throw new Error("split quebrado");
    };
    expect(floorDenyCulprit("ls && rm -rf /", { split: broken })).toBe("ls && rm -rf /");
    expect(floorDenyCulprit("git push --force origin main", { split: broken })).toBe("git push --force origin main");
    expect(floorDenyCulprit("ls -la", { split: broken })).toBeNull();
    expect(floorDenyCulprit("git push --force-with-lease origin x", { split: broken })).toBeNull();
    // Mais grosso que o fino, de propósito.
    expect(floorDenyCulprit("echo rm -rf /", { split: broken })).toBe("echo rm -rf /");
  });

  it("nunca lança, qualquer que seja a entrada", () => {
    for (const input of [undefined, null, 42, {}, "", " ", "\0", "$(".repeat(5000), "`".repeat(1000)]) {
      expect(() => floorDenyCulprit(input as unknown as string)).not.toThrow();
    }
  });
});

// Onda 2, item 5 (A2): `allow_tier3: true` seguido de uma linha MAIS indentada que a chave é um escalar
// de várias linhas para o YAML ("true true", uma string), mas o leitor por linhas via o `true` da
// primeira linha e liberava o break-glass. O que nega é uma continuação de verdade: a próxima linha
// que não é vazia nem comentário e é mais indentada que a chave.
describe("allowTier3FromSpec — o valor que continua na linha seguinte não é `true` (A2)", () => {
  const spec = (...linhas: string[]) => ["---", ...linhas, "---", "", "# Spec", ""].join("\n");
  const crlf = (s: string) => s.replace(/\n/g, "\r\n");
  const yamlSays = (texto: string): unknown => {
    const fm = texto.split("\n").slice(1, texto.split("\n").indexOf("---", 1)).join("\n");
    return (load(fm) as { tier_defaults?: { allow_tier3?: unknown } } | null)?.tier_defaults?.allow_tier3;
  };

  const CONTINUA: Array<[string, string]> = [
    ["a continuação é `true` (o caso do achado: o YAML lê \"true true\")", spec("tier_defaults:", "  allow_tier3: true", "    true")],
    ["a continuação é outra palavra", spec("tier_defaults:", "  allow_tier3: true", "    agora")],
    ["a continuação é bem mais indentada", spec("tier_defaults:", "  allow_tier3: true", "          x")],
    ["a continuação vem depois de um comentário", spec("tier_defaults:", "  allow_tier3: true", "    # c", "    mais")],
    ["a continuação vem depois de linhas em branco", spec("tier_defaults:", "  allow_tier3: true", "", "    mais")],
    ["o flag tem um comentário e depois a continuação", spec("tier_defaults:", "  allow_tier3: true  # ok", "    mais")],
    ["a continuação, e ainda há uma chave irmã depois", spec("tier_defaults:", "  allow_tier3: true", "    true", "  other: 1")],
    ["indentação de 4 espaços por nível", spec("tier_defaults:", "    allow_tier3: true", "        mais")],
  ];
  for (const [caso, texto] of CONTINUA) {
    it(`nega: ${caso}`, () => {
      expect(allowTier3FromSpec(texto), caso).toBe(false);
      expect(allowTier3FromSpec(crlf(texto)), `${caso} (CRLF)`).toBe(false);
    });
  }

  // O irmão do achado, que o varrimento contra o YAML achou: uma linha menos indentada que os filhos
  // mas fora da coluna 0 é um recuo para nível nenhum do bloco, e o YAML recusa o frontmatter.
  it("nega: recuo para um nível que o bloco não tem (o YAML recusa)", () => {
    const texto = spec("tier_defaults:", "  allow_tier3: true", "", " z");
    expect(() => yamlSays(texto)).toThrow();
    expect(allowTier3FromSpec(texto)).toBe(false);
    expect(allowTier3FromSpec(spec("tier_defaults:", "    allow_tier3: true", "  other: 1"))).toBe(false);
  });

  it("o YAML lê \"true true\" (uma string) nesse caso: o guard concorda em não liberar", () => {
    const texto = spec("tier_defaults:", "  allow_tier3: true", "    true");
    expect(yamlSays(texto)).toBe("true true");
    expect(allowTier3FromSpec(texto)).toBe(false);
  });

  // O que NÃO pode virar falso negativo: a próxima linha não é continuação.
  const LIBERA: Array<[string, string]> = [
    ["o flag é a última linha do frontmatter", spec("tier_defaults:", "  allow_tier3: true")],
    ["uma irmã na mesma indentação", spec("tier_defaults:", "  allow_tier3: true", "  other: 1")],
    ["uma chave de coluna 0 depois", spec("tier_defaults:", "  allow_tier3: true", "next: 1")],
    ["um comentário e depois uma irmã", spec("tier_defaults:", "  allow_tier3: true", "    # só um comentário", "  other: 1")],
    ["linhas em branco e depois uma chave de coluna 0", spec("tier_defaults:", "  allow_tier3: true", "", "", "next: 1")],
    ["o flag com comentário, e a irmã depois", spec("tier_defaults:", "  allow_tier3: true  # break-glass", "  other: 1")],
    ["o flag no meio do bloco: continuação NÃO há (a vizinha é irmã)", spec("tier_defaults:", "  other: 1", "  allow_tier3: true", "  more: 2")],
  ];
  for (const [caso, texto] of LIBERA) {
    it(`libera: ${caso}`, () => {
      expect(allowTier3FromSpec(texto), caso).toBe(true);
      expect(allowTier3FromSpec(crlf(texto)), `${caso} (CRLF)`).toBe(true);
      expect(yamlSays(texto), `${caso} (YAML)`).toBe(true);
    });
  }

  // O invariante que o achado quebrou: o guard nunca libera onde o YAML não lê `true`. Varre as
  // combinações de linhas que podem seguir o flag e confere contra o js-yaml.
  it("o guard nunca é mais permissivo que o YAML: todas as combinações de até 2 linhas depois do flag", () => {
    const after = ["", "    x", "    true", "  other: 1", "next: 1", "    # c", "  # c", "# c", "      deep: 1", "   y", " z"];
    let compared = 0;
    for (const first of after) {
      for (const second of [undefined, ...after]) {
        // A mesma linha duas vezes repetiria uma chave, e o YAML recusa chave duplicada: não é o caso.
        if (second !== undefined && second === first) continue;
        const body = ["tier_defaults:", "  allow_tier3: true", first, ...(second === undefined ? [] : [second])];
        const texto = spec(...body);
        let yamlTrue: boolean;
        try {
          yamlTrue = yamlSays(texto) === true;
        } catch {
          // O YAML recusa o frontmatter inteiro (uma chave duplicada, `chave: x` na continuação de
          // outro valor): não há o que o `true` signifique, e quem avisa é o doctor, não o guard.
          continue;
        }
        compared++;
        if (allowTier3FromSpec(texto)) expect(yamlTrue, JSON.stringify(body)).toBe(true);
      }
    }
    expect(compared).toBeGreaterThan(60);
  });
});

// Onda 2, item 6 (A3): um ask_patterns que casa a string vazia (`(?:)`, `^`, `.*`, `x*`, `$`, `(?=)`,
// `\s*`) casa com TODO comando, e o guard dava ASK sempre que ALGUM ask_pattern casava: todo Tier 3
// virava ask, o `drop table` incluído (que só o break-glass libera). Pular o padrão que casa "" não
// bastava: `.`, `[\s\S]` e `\w|\W` casam tudo sem casar "". A regra agora é por identidade, a mesma
// que o doctor confere (ask_patterns ⊆ tier3.patterns): o comando só dá ASK se TODO padrão de
// tier3.patterns que o casa também está em ask_patterns. Um ask_pattern solto não promove nada.
describe("ask_patterns: só promove a ask o padrão de tier3.patterns que está nele (A3)", () => {
  const DROP = "\\bdrop\\s+(table|database)\\b";
  const VERCEL = "vercel\\s+.*--prod\\b";
  const REBOOT = "\\bssh\\b.*\\b(reboot|shutdown|poweroff)\\b";
  const DOCKER = "\\bssh\\b.*\\b(docker|systemctl|service|kubectl)\\b";
  const rules = (ask: string[], patterns = [DROP, VERCEL, REBOOT, DOCKER]) =>
    ({ tier3: { label: "t3", patterns, ask_patterns: ask }, tier2: { label: "t2", patterns: [] } }) as Parameters<typeof guardDecision>[1];

  const EVERYTHING = ["(?:)", "^", ".*", "x*", "$", "(?=)", "\\s*", ".", "[\\s\\S]", "\\w|\\W", "(?!zzzz)", "^.*$", "(?:a|)"];

  it.each(EVERYTHING.map((p) => [p]))("ask_patterns com %s: o drop table segue deny", (junk) => {
    const r = rules([junk, VERCEL]);
    expect(guardDecision("psql -c 'drop table users'", r, false)).toBe("deny");
    expect(guardDecision("ssh vps sudo reboot", r, false)).toBe("deny");
    expect(isAskEligibleTier3("psql -c 'drop table users'", r)).toBe(false);
  });

  it.each(EVERYTHING.map((p) => [p]))("ask_patterns com %s: o deploy legítimo segue ask, e o que não é Tier 3 segue livre", (junk) => {
    const r = rules([junk, VERCEL]);
    expect(guardDecision("vercel deploy --prod", r, false)).toBe("ask");
    expect(guardDecision("ls -la", r, false)).toBe("allow");
    expect(guardDecision("git status", r, false)).toBe("allow");
  });

  it("só o ask_pattern solto, sem o padrão do deploy dele em ask_patterns: o deploy fecha para deny (falha segura)", () => {
    expect(guardDecision("vercel deploy --prod", rules([".*"]), false)).toBe("deny");
  });

  it("a explicação do deny cita o trecho e não promete ask", () => {
    const { culprit } = explainDeny("psql -c 'drop table users'", rules([".*"]));
    expect(culprit).toBe("psql -c 'drop table users'");
  });

  // O irmão do achado: a regra antiga olhava só "algum ask casa", então um comando que casa um padrão
  // de deploy E um de classe deny virava ask pelo primeiro.
  describe("um comando que casa um padrão de ask e outro que não é de ask é deny", () => {
    const r = rules([VERCEL, DOCKER]);
    it("ssh que roda docker e reinicia o host → deny", () => {
      expect(guardDecision('ssh vps "docker ps; sudo reboot"', r, false)).toBe("deny");
      expect(isAskEligibleTier3('ssh vps "docker ps; sudo reboot"', r)).toBe(false);
    });
    it("o mesmo ssh só com docker → ask", () => {
      expect(guardDecision("ssh vps docker compose up -d", r, false)).toBe("ask");
    });
    it("deploy na mesma linha de um drop table: deny (como antes, pelo outro sub-comando)", () => {
      expect(guardDecision("vercel deploy --prod && psql -c 'drop table x'", r, false)).toBe("deny");
    });
  });

  it("com o mapa canônico: o deploy por ssh pergunta, o reboot escondido atrás dele nega", () => {
    const tpl = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "tier-rules.json"), "utf8"));
    expect(guardDecision("ssh vps docker compose up -d", tpl, false)).toBe("ask");
    expect(guardDecision("ssh deploy@vps ./deploy.sh", tpl, false)).toBe("ask");
    expect(guardDecision('ssh vps "docker ps; sudo reboot"', tpl, false)).toBe("deny");
    expect(guardDecision("npx prisma migrate deploy", tpl, false)).toBe("ask");
    expect(guardDecision("gh workflow run deploy.yml -f ref=v1 -f confirm=deploy", tpl, false)).toBe("ask");
  });

  it("o break-glass segue liberando tudo, como sempre", () => {
    expect(guardDecision("psql -c 'drop table users'", rules([".*"]), true)).toBe("allow");
  });
});

// Onda 2, item 8 (A5): o heredoc de um `ssh` é um SCRIPT que roda no host remoto, não texto. Antes o
// `ssh` não era interpretador de stdin, então `ssh host bash -s <<'EOF' … EOF` (e `ssh host <<'EOF'`)
// tratava o corpo como dado e o `rm -rf` ou o deploy lá dentro passavam. Agora o corpo fica no texto
// (cada linha é classificada como comando local, e pega o piso e o `drop table`), e cada linha também
// é classificada como o comando remoto que ela é: `ssh host <linha>`, para os padrões de ssh a pegarem.
describe("ssh recebe o heredoc como script remoto (A5)", () => {
  const RULES = {
    tier3: {
      label: "t3",
      patterns: ["\\bssh\\b.*\\b(docker|systemctl|service|kubectl)\\b", "\\bssh\\b.*\\b(reboot|shutdown|poweroff)\\b", "\\bdrop\\s+table\\b"],
      ask_patterns: ["\\bssh\\b.*\\b(docker|systemctl|service|kubectl)\\b"],
    },
    tier2: { label: "t2", patterns: [] },
  } as Parameters<typeof guardDecision>[1];

  it("o corpo é script: o piso e os padrões locais o enxergam", () => {
    expect(guardDecision("ssh host bash -s <<'EOF'\nrm -rf /srv/app\nEOF", RULES, false)).toBe("deny");
    expect(guardDecision("ssh host <<'EOF'\npsql -c 'drop table users'\nEOF", RULES, false)).toBe("deny");
  });

  it("cada linha do corpo também é o comando remoto `ssh host <linha>`", () => {
    expect(guardDecision("ssh host <<'EOF'\ncd /app\ndocker compose up -d\nEOF", RULES, false)).toBe("ask");
    expect(guardDecision("ssh host bash -s <<'EOF'\nsystemctl restart app\nEOF", RULES, false)).toBe("ask");
    expect(guardDecision("ssh host <<'EOF'\nsudo reboot\nEOF", RULES, false)).toBe("deny");
  });

  it("um corpo sem nada de Tier 3 segue livre, e o ssh puro também", () => {
    expect(guardDecision("ssh host <<'EOF'\nls -la\nuptime\nEOF", RULES, false)).toBe("allow");
    expect(guardDecision("ssh host uptime", RULES, false)).toBe("allow");
    expect(guardDecision("ssh host bash -s <<'EOF'\necho oi\nEOF", RULES, false)).toBe("allow");
  });

  it("splitSubCommands: o corpo vira linhas locais e linhas remotas com o prefixo do ssh, sem o `<<'EOF'`", () => {
    const subs = splitSubCommands("ssh -p 22 host bash -s <<'EOF'\ncd /app\ndocker ps\nEOF");
    expect(subs).toContain("cd /app");
    expect(subs).toContain("docker ps");
    expect(subs).toContain("ssh -p 22 host bash -s docker ps");
    expect(subs).toContain("ssh -p 22 host bash -s cd /app");
    // A linha de abertura continua sendo um sub-comando (com o `<<'EOF'`); as remotas não o carregam.
    expect(subs.filter((s) => s.startsWith("ssh -p 22 host bash -s ") && !s.includes("<<"))).toHaveLength(2);
    expect(subs.filter((s) => s.includes("<<"))).toEqual(["ssh -p 22 host bash -s <<'EOF'"]);
  });

  it("o corpo com operadores é dividido antes de ganhar o prefixo", () => {
    const subs = splitSubCommands("ssh host <<EOF\ncd /app && docker ps; ls\nEOF");
    expect(subs).toContain("ssh host docker ps");
    expect(subs).toContain("ssh host ls");
  });

  it("a mesma linha com outros comandos depois: só a parte do ssh dá o prefixo", () => {
    const subs = splitSubCommands("ssh host <<'EOF' && echo feito\ndocker ps\nEOF");
    expect(subs).toContain("ssh host docker ps");
    expect(subs.some((s) => s.startsWith("ssh host") && s.includes("echo"))).toBe(false);
  });

  it("heredoc de programas que só recebem texto continua sendo dado", () => {
    expect(guardDecision("cat > runbook.md <<'EOF'\nssh host docker ps\nrm -rf /\nEOF", RULES, false)).toBe("allow");
    expect(guardDecision("git commit -F - <<'EOF'\nfix: ssh host docker ps\nEOF", RULES, false)).toBe("allow");
    expect(guardDecision("tee notes.txt <<'EOF'\nsystemctl stop x\nEOF", RULES, false)).toBe("allow");
  });

  it("um ssh em outra posição do pipeline não vira interpretador (só o programa líder da linha)", () => {
    expect(guardDecision("echo ssh <<'EOF'\ndocker ps\nEOF", RULES, false)).toBe("allow");
  });

  it("a substituição dentro do corpo de um heredoc não-ssh continua sendo classificada (sem regressão)", () => {
    expect(guardDecision("cat > f.md <<EOF\n$(psql -c 'drop table x')\nEOF", RULES, false)).toBe("deny");
  });
});

// Revisão de segurança (onda 2): o programa que recebe um heredoc saía da LINHA inteira
// (`leadingProgram(line)`), não do sub-comando que tem o `<<`. `true && bash <<'EOF'` tinha `true` como
// líder, então o corpo virava dado e o destrutivo dentro dele passava; o mesmo em `cd x; sh <<EOF`,
// `echo a | bash <<EOF` e `cat <<'EOF' | bash` (o heredoc vai para o `cat`, e a saída para o shell). A regra
// agora falha FECHADA: se um interpretador (ou o ssh) aparece EM QUALQUER LUGAR da linha de abertura —
// depois de sudo, env, timeout, com caminho, com .exe, ou à direita de um pipe —, o corpo é classificado.
describe("heredoc: o interpretador em qualquer lugar da linha de abertura faz do corpo um script", () => {
  const RULES = {
    tier3: { label: "t3", patterns: ["\\bdrop\\s+table\\b", "\\bssh\\b.*\\b(reboot|shutdown)\\b"], ask_patterns: [] },
    tier2: { label: "t2", patterns: [] },
  } as Parameters<typeof guardDecision>[1];
  const BODY = "rm -rf /srv/app";
  const heredoc = (opening: string, delim = "'EOF'") => `${opening} <<${delim}\n${BODY}\nEOF`;

  it.each([
    ["true && bash"],
    ["cd x; sh"],
    ["cd x && ls && sh"],
    ["echo a | bash"],
    ["false || bash"],
    ["sudo bash"],
    ["sudo -u deploy bash"],
    ["/bin/bash"],
    ["/usr/bin/env bash"],
    ["bash.exe"],
    ["C:\\Program Files\\Git\\bin\\bash.exe"],
    ["env FOO=1 bash"],
    ["FOO=1 bash"],
    ["timeout 5 bash"],
    ["nice -n 5 sh"],
    ["nohup bash"],
    ["exec bash"],
    ["command bash"],
    ["time bash"],
    ["(bash)"],
    ["{ bash; }"],
    ["docker exec -i c sh"],
    ["kubectl exec -i p -- bash"],
    ["ssh h 'bash -s'"],
    ['ssh h "sh -s"'],
    ["ssh h"],
    ["python3 -"],
    ["python3.11 -"],
    ["node -"],
    ["xargs -0"],
    ["eval"],
    ["BASH"],
  ])("%s <<'EOF' + rm -rf → deny (o corpo é classificado)", (opening) => {
    expect(guardDecision(heredoc(opening), RULES, false), opening).toBe("deny");
  });

  it.each([["cat"], ["cat -"], ["tee notes.txt"], ["cat | bash"], ["cat |bash"], ["cat|sh"], ["cat > f.sh | sh"], ["cat && bash -c x"]])(
    "o interpretador à direita de um pipe: %s <<'EOF' → deny",
    (opening) => {
      const text = `${opening} <<'EOF'\n${BODY}\nEOF`;
      // Só os que têm um interpretador depois do `cat` precisam negar; `cat`/`tee` sozinhos são dado.
      const expected = /bash|\bsh\b/.test(opening) ? "deny" : "allow";
      expect(guardDecision(text, RULES, false), opening).toBe(expected);
    }
  );

  it("o delimitador sem aspas e com `-` também", () => {
    expect(guardDecision(`true && bash <<EOF\n${BODY}\nEOF`, RULES, false)).toBe("deny");
    expect(guardDecision(`true && bash <<-EOF\n\t${BODY}\n\tEOF`, RULES, false)).toBe("deny");
    expect(guardDecision(`true && sh << "EOF"\n${BODY}\nEOF`, RULES, false)).toBe("deny");
  });

  it("ssh em qualquer lugar da linha: o corpo é script remoto e cada linha vira `ssh <host> <linha>`", () => {
    expect(guardDecision("true && ssh host <<'EOF'\nsudo reboot\nEOF", RULES, false)).toBe("deny");
    expect(guardDecision("cd x; ssh -p 22 host bash -s <<'EOF'\nsudo reboot\nEOF", RULES, false)).toBe("deny");
    const subs = splitSubCommands("true && ssh -p 22 host <<'EOF'\nuptime\nEOF");
    expect(subs).toContain("ssh -p 22 host uptime");
  });

  // O que continua sendo dado: o programa que recebe o heredoc é um que só guarda o texto.
  it.each([
    ["cat > runbook.md"],
    ["cat > f.md"],
    ["true && cat > f.md"],
    ["cd x; cat > f.md"],
    ["git commit -F -"],
    // (`git commit -F -  # sh <<'EOF'` saiu daqui: o `#` abre um comentário, o `<<` não abre heredoc nenhum e o corpo
    //  são comandos de verdade — QA R3, testado em "o `#` no começo de uma palavra")
    ['git commit -m "use bash" -F -'],
    ["gh pr create --body-file -"],
    ["tee notes.txt"],
    ["echo a | tee f.md"],
    ["cat > bash-notes.md"],
    ["cat > bash.txt"],
    ["cat > deploy.sh"],
    ["cat > ./scripts/sh"],
    ["cp /dev/stdin notes.md"],
    ["dd of=notes.md"],
    ["dd if=/dev/stdin of=notes.md bs=1"],
    ["gh issue comment 3 -F -"],
    ["gh release create v1 --notes-file -"],
    ["git tag -a v1 -F -"],
    ["git notes add -F -"],
    ["git -C sub commit --file=-"],
    ["cat | tee notes.md"],
    ["cat > f.md 2>&1"],
    ["C:\\Git\\usr\\bin\\cat.exe > f.md"],
    ["\\\\server\\tools\\cat.exe > f.md"],
  ])("%s <<'EOF' + rm -rf → allow (o corpo é dado)", (opening) => {
    expect(guardDecision(heredoc(opening), RULES, false), opening).toBe("allow");
  });

  it("a substituição no corpo de um heredoc de dado sem aspas continua sendo classificada", () => {
    expect(guardDecision("true && cat > f.md <<EOF\n$(rm -rf /srv)\nEOF", RULES, false)).toBe("deny");
  });

  it("um operador entre aspas não parte a linha de abertura", () => {
    expect(guardDecision('cat > "a && sh.md" <<\'EOF\'\nrm -rf /srv\nEOF', RULES, false)).toBe("allow");
  });

  // A INVERSÃO (decisão do Orchestrator, na política de falhar fechado do PO): o corpo só é dado quando o
  // programa que o recebe está na allowlist; qualquer outro programa, ou a dúvida, classifica o corpo. A
  // lista de interpretadores esquecia psql, mysql, sqlite3, sqlcmd, wsl, su, `source`, `.`, fish, csh e awk,
  // e um `DROP TABLE` mandado ao psql é exatamente Tier 3.
  describe("o que não está na allowlist tem o corpo classificado", () => {
    const SQL = "DROP TABLE users;";
    const sql = (opening: string) => `${opening} <<'EOF'\n${SQL}\nEOF`;

    it.each([
      ["psql -d app"],
      ["psql -f -"],
      ["psql postgres://u@h/db"],
      ["mysql -u root app"],
      ["mysql -e 'source /dev/stdin'"],
      ["sqlite3 app.db"],
      ["sqlcmd -S srv -d app"],
      ["mongosh"],
      ["redis-cli"],
      ["sudo -u postgres psql"],
      ["docker exec -i db psql -U u"],
      ["kubectl exec -i pod -- psql"],
      ["ssh db psql"],
    ])("%s <<'EOF' + DROP TABLE → deny", (opening) => {
      expect(guardDecision(sql(opening), RULES, false), opening).toBe("deny");
    });

    it.each([
      ["awk -f /dev/stdin"],
      ["gawk -f -"],
      ["wsl bash"],
      ["wsl"],
      ["su -c bash"],
      ["su root"],
      ["sudo -s"],
      ["sudo -i"],
      ["source /dev/stdin"],
      [". /dev/stdin"],
      ["fish"],
      ["csh"],
      ["tcsh"],
      ["zsh"],
      ["dash"],
      ["busybox sh"],
      ["python3 -"],
      ["perl"],
      ["ruby"],
      ["lua -"],
      ["Rscript -"],
      ["pwsh -Command -"],
      ["powershell -NoProfile -Command -"],
      ["cmd /c"],
      ["php"],
      ["xargs -I{} sh -c {}"],
      ["env bash"],
      ["nohup sh"],
      ["unprogramaqualquer"],
      ["./run-it.sh"],
      ["grep -c rm"],
      ["jq ."],
      ["sort"],
      ["mail root"],
    ])("%s <<'EOF' + rm -rf → deny (fora da allowlist: o corpo é classificado)", (opening) => {
      expect(guardDecision(`${opening} <<'EOF'\nrm -rf /srv/app\nEOF`, RULES, false), opening).toBe("deny");
    });

    // Na dúvida, classificado: um nome de programa que não dá para normalizar.
    it.each([
      ["b\\ash"],
      ["ba\\sh"],
      ["$'bash'"],
      ["$SHELL"],
      ["${SHELL}"],
      ["$(which bash)"],
      ["`which sh`"],
      ["ba*h"],
      ["/bin/ba?h"],
      ["/bin/[b]ash"],
      ["{bash,-s}"],
      ["~/bin/bash"],
      ['"bash"'],
      ["'bash'"],
      ["c\\at > f.md"],
      ["$'cat' > f.md"],
      ["$CAT > f.md"],
      ["ca* > f.md"],
      ["(cat > f.md)"],
      ["{ cat > f.md; }"],
    ])("dúvida no nome do programa: %s → o corpo é classificado", (opening) => {
      expect(guardDecision(`${opening} <<'EOF'\nrm -rf /srv/app\nEOF`, RULES, false), opening).toBe("deny");
    });

    it("uma aspa que nunca fecha na linha de abertura: o corpo é classificado", () => {
      expect(guardDecision("cat > 'f.md <<'EOF'\nrm -rf /srv/app\nEOF", RULES, false)).toBe("deny");
      expect(guardDecision('git commit -m "msg <<\'EOF\'\nrm -rf /srv/app\nEOF', RULES, false)).toBe("deny");
    });

    it("mais de um candidato na linha de abertura: tudo o que recebe a saída tem de estar na allowlist", () => {
      expect(guardDecision("cat <<'EOF' | bash\nrm -rf /srv\nEOF", RULES, false)).toBe("deny");
      expect(guardDecision("cat <<'EOF' | psql\nDROP TABLE users;\nEOF", RULES, false)).toBe("deny");
      expect(guardDecision("cat <<'EOF' | tee a.md | sh\nrm -rf /srv\nEOF", RULES, false)).toBe("deny");
      expect(guardDecision("cat <<'EOF' |& bash\nrm -rf /srv\nEOF", RULES, false)).toBe("deny");
      expect(guardDecision("cat <<'EOF' | tee a.md\nrm -rf /srv\nEOF", RULES, false)).toBe("allow");
      expect(guardDecision("cat <<'EOF' | tee a.md | cat > b.md\nrm -rf /srv\nEOF", RULES, false)).toBe("allow");
    });

    it("um argumento ou alvo que roda algo (substituição de processo, subshell) tira o corpo da allowlist", () => {
      expect(guardDecision("tee >(bash) <<'EOF'\nrm -rf /srv\nEOF", RULES, false)).toBe("deny");
      expect(guardDecision("cat > >(sh) <<'EOF'\nrm -rf /srv\nEOF", RULES, false)).toBe("deny");
      expect(guardDecision("cat $(echo x) <<'EOF'\nrm -rf /srv\nEOF", RULES, false)).toBe("deny");
    });

    it("a allowlist exige a forma que lê do stdin: git commit sem -F -, gh sem --body-file -, cp que não é de /dev/stdin", () => {
      expect(guardDecision("git commit -m x <<'EOF'\nrm -rf /srv\nEOF", RULES, false)).toBe("deny");
      expect(guardDecision("git log <<'EOF'\nrm -rf /srv\nEOF", RULES, false)).toBe("deny");
      expect(guardDecision("gh pr create <<'EOF'\nrm -rf /srv\nEOF", RULES, false)).toBe("deny");
      expect(guardDecision("cp a.txt b.txt <<'EOF'\nrm -rf /srv\nEOF", RULES, false)).toBe("deny");
      expect(guardDecision("dd if=/dev/sda of=x <<'EOF'\nrm -rf /srv\nEOF", RULES, false)).toBe("deny");
      expect(guardDecision("dd <<'EOF'\nrm -rf /srv\nEOF", RULES, false)).toBe("deny");
    });
  });

  // O idioma de commit deste harness: `git commit -m "$(cat <<'EOF' … EOF)"`. O heredoc vai para o `cat` DENTRO
  // da substituição, e a saída dele para o que está FORA, que só pode guardar texto.
  describe("o heredoc dentro de uma substituição de comando", () => {
    it.each([
      ['git commit -m "$(cat'],
      ['git commit -a -m "$(cat'],
      ['gh pr create --title t --body "$(cat'],
      ['gh issue comment 3 --body "$(cat'],
      ['git -C sub commit --message "$(cat'],
      ['git commit -am "$(cat'],
      ['git commit --allow-empty --no-verify -s -m "$(cat'],
      ['git commit --message="$(cat'],
      ['git tag -a v1 -m "$(cat'],
      ['git notes add -m "$(cat'],
      ['git merge --no-ff -m "$(cat'],
    ])("%s <<'EOF' + prosa com rm -rf → allow (a mensagem é dado)", (opening) => {
      expect(guardDecision(`${opening} <<'EOF'\n${BODY}\nEOF\n)"`, RULES, false), opening).toBe("allow");
    });

    it("sem aspas em volta da substituição o fechamento é só `)`; com CRLF e recuo também", () => {
      expect(guardDecision(`git commit -m $(cat <<'EOF'\n${BODY}\nEOF\n)`, RULES, false)).toBe("allow");
      expect(guardDecision(`git commit -m "$(cat <<'EOF'\r\n${BODY}\r\nEOF\r\n)"`, RULES, false)).toBe("allow");
      expect(guardDecision(`git commit -m "$(cat <<'EOF'\n${BODY}\nEOF\n  )"  `, RULES, false)).toBe("allow");
      expect(guardDecision(`git commit -m "$(cat <<-'EOF'\n\t${BODY}\n\tEOF\n)"`, RULES, false)).toBe("allow");
    });

    it.each([
      ['bash -c "$(cat'],
      ['sh -c "$(cat'],
      ['eval "$(cat'],
      ['psql -c "$(cat'],
      ['python3 -c "$(cat'],
      ['git commit -m "$(psql <<\'EOF\''.replace(" <<'EOF'", "")],
      ['xargs "$(cat'],
      ['ssh h "$(cat'],
      ["$(cat"],
      ['git config alias.x "$(cat'],
      // echo e printf imprimem o texto, e quem o recebe depois (um pipe, o `$(...)` de outro comando) o executa:
      // fora da allowlist, como qualquer programa que não só guarda o texto.
      ['echo "$(cat'],
      ['echo $(cat'],
      ['printf "%s" "$(cat'],
      ['printf "$(cat'],
    ])("%s <<'EOF' + rm -rf → deny (a saída é executada ou o consumidor é desconhecido)", (opening) => {
      expect(guardDecision(`${opening} <<'EOF'\n${BODY}\nEOF\n)"`, RULES, false), opening).toBe("deny");
    });

    // A substituição só vale como dado quando o comando INTEIRO que a envolve é um consumidor de texto: o que vem
    // depois do `)` que a fecha (a linha de fechamento) também conta, e a saída de um comando de texto, ligada a
    // um interpretador, é um script.
    describe("o comando inteiro em volta da substituição tem de ser o consumidor de texto", () => {
      const wrap = (opening: string, closing: string) => `${opening} <<'EOF'\n${BODY}\nEOF\n${closing}`;

      it.each([
        ['git commit -m x "$(cat', ')"'], // a substituição é um caminho depois da mensagem, não a mensagem
        ['git tag -a v1 -m x "$(cat', ')"'],
        ['git commit -m "$(cat', ')" | bash'],
        ['git commit -m "$(cat', ')" | sh'],
        ['git commit -m "$(cat', ')" | sh -s'],
        ['git commit -m "$(cat', ')" |& bash'],
        ['git commit -m "$(cat', ')" | psql'],
        ['git commit -m "$(cat', ')" > /dev/null; bash'],
        ['git commit -m "$(cat', ')" ; rm -rf build'],
        ['git commit -m "$(cat', ')" && sh'],
        ['git commit -m "$(cat', ')" || sh'],
        ['git commit -m "$(cat', ')" & sh'],
        ['git commit -m "$(cat', ')" --no-verify'],
        ['git commit -m "$(cat', ')" # comentario'],
        ['git commit -m "$(cat', ')" > out.txt'],
        ['git commit -m "$(cat', ')" >> out.txt'],
        ['git commit -m "$(cat', ')" 2> err.txt'],
        ['git commit -m "$(cat', ')" 2>&1 > out.txt'],
        ['git commit -m "$(cat', ')" &> out.txt'],
        ['git commit -m "$(cat', ')" 1>&2'],
        ['git commit -m "$(cat', ')" < /dev/null'],
        // o que SÓ o `2>&1` e o `| tail`/`| head` (com -n N ou -N) deixam passar; o resto da linha classifica o corpo
        ['git commit -m "$(cat', ')" | xargs echo'],
        ['git commit -m "$(cat', ')" | xargs sh -c'],
        ['git commit -m "$(cat', ')" | sh -c "$(cat)"'],
        ['git commit -m "$(cat', ')" | tee out.txt'],
        ['git commit -m "$(cat', ')" | tee'],
        ['git commit -m "$(cat', ')" | tail -f'],
        ['git commit -m "$(cat', ')" | tail -f x.log'],
        ['git commit -m "$(cat', ')" | tail -n +2'],
        ['git commit -m "$(cat', ')" | tail -c 10'],
        ['git commit -m "$(cat', ')" | tail --lines=5'],
        ['git commit -m "$(cat', ')" | tail -n'],
        ['git commit -m "$(cat', ')" | tail -n x'],
        ['git commit -m "$(cat', ')" | tail -5 x.txt'],
        ['git commit -m "$(cat', ')" | tail -5 | bash'],
        ['git commit -m "$(cat', ')" | tail -5 | tee x'],
        ['git commit -m "$(cat', ')" | tail -5 > x'],
        ['git commit -m "$(cat', ')" | tail -5 2> x'],
        ['git commit -m "$(cat', ')" | tail -5 2>&1'],
        ['git commit -m "$(cat', ')" | tail -5 &'],
        ['git commit -m "$(cat', ')" | tail -5; rm -rf build'],
        ['git commit -m "$(cat', ')" | tail -5 && sh'],
        ['git commit -m "$(cat', ')" | tail -5 # x'],
        ['git commit -m "$(cat', ')" | tail -5 | tail -1'],
        ['git commit -m "$(cat', ')" | tail | head'],
        ['git commit -m "$(cat', ')" |& tail -5'],
        ['git commit -m "$(cat', ')" | head -c 10'],
        ['git commit -m "$(cat', ')" | head --lines 5'],
        ['git commit -m "$(cat', ')" | head -n 5 -q'],
        ['git commit -m "$(cat', ')" | tailx'],
        ['git commit -m "$(cat', ')" | tail5'],
        ['git commit -m "$(cat', ')" | /bin/tail -5'],
        ['git commit -m "$(cat', ')" | TAIL -5'],
        ['git commit -m "$(cat', ')" | tail -5$(rm -rf /x)'],
        ['git commit -m "$(cat', ')" 2>&1 | bash'],
        ['git commit -m "$(cat', ')" 2>&1 | sh -c'],
        ['git commit -m "$(cat', ')" 2>&1 | xargs rm'],
        ['git commit -m "$(cat', ')" 2>&1 | tee out.txt'],
        ['git commit -m "$(cat', ')" 2>&1 | tail -5 | sh'],
        ['git commit -m "$(cat', ')" 2>&1 2>&1'],
        ['git commit -m "$(cat', ')" 2>&1; sh'],
        ['git commit -m "$(cat', ')" 2>&1 && sh'],
        ['git commit -m "$(cat', ')" | 2>&1'],
        ['git commit -m "$(cat', ')" "$(cat /x)"'],
        ['git commit -m "$(cat', ')" `cat /x`'],
        ['git commit -m "$(cat', ')" <(cat /x)'],
        ['git commit -m "$(cat', ')"\\'],
        ['git commit -m $(cat', ') | bash'],
        ['echo "$(cat', ')" | sh'],
        ['echo "$(cat', ')" | bash -s'],
        ['printf "%s" "$(cat', ')" | sh'],
        ['$(cat', ') | bash'],
        ['$(cat', ')'],
        ['gh pr create --body "$(cat', ')" | sh'],
        ['gh pr create --body "$(cat', ')" && rm -rf build'],
      ])("%s … %s → deny", (opening, closing) => {
        expect(guardDecision(wrap(opening, closing), RULES, false), `${opening} … ${closing}`).toBe("deny");
      });

      // O que a linha de fechamento pode dizer além de `)"`: `2>&1` e um `| tail` ou `| head` (com `-n N`, `-nN` ou
      // `-N`), nessa ordem — são comandos de uma linha de commit e de PR que só limitam o que se vê da saída. Decisão
      // do PO depois do diferencial nos comandos reais: a prosa que cita um deploy ou um DROP DATABASE num `gh pr
      // create ... )" 2>&1 | tail -5` não pode ser lida como comando. Qualquer outro pipe ou redirecionamento classifica.
      describe("a saída que só se limita (2>&1, | tail, | head) não tira o corpo de ser dado", () => {
        const PROSE = "O passo 5 roda DROP TABLE users num banco de scratch. Não rode rm -rf /srv/app na mão.";
        const prose = (opening: string, closing: string, eol = "\n") =>
          [`${opening} <<'EOF'`, PROSE, "EOF", closing].join(eol);

        it.each([
          [')"'],
          [')" 2>&1'],
          [')" | tail'],
          [')" | tail -5'],
          [')" | tail -n 5'],
          [')" | tail -n5'],
          [')" | tail -n  12'],
          [')" | head'],
          [')" | head -3'],
          [')" | head -n 20'],
          [')" | head -n20'],
          [')" 2>&1 | tail'],
          [')" 2>&1 | tail -5'],
          [')" 2>&1 | tail -n 5'],
          [')" 2>&1 | head -n 3'],
          [')" 2>&1 | head -1'],
          [')"   2>&1   |   tail   -5   '],
          [')"\t2>&1 | tail -5'],
          [")"],
          [") 2>&1"],
          [") 2>&1 | tail -1"],
        ])("commit: %s → allow (o corpo é prosa)", (closing) => {
          const opening = closing.startsWith(')"') ? 'git commit -m "$(cat' : "git commit -m $(cat";
          expect(guardDecision(prose(opening, closing), RULES, false), closing).toBe("allow");
          expect(guardDecision(prose(opening, closing, "\r\n"), RULES, false), `${closing} (CRLF)`).toBe("allow");
        });

        it("o `gh pr create` real: a prosa cita DROP DATABASE e o fechamento é `)\" 2>&1 | tail -5` → allow", () => {
          const real = [
            "cd C:/devops/source/jusbraz/crm && gh pr create --base main --head spec/287-estado --title \"fix(docs): o restore lia do caminho errado\" --body \"$(cat <<'EOF'",
            "## O que muda",
            "O DROP TABLE e o DROP DATABASE do passo 5 são Tier 3, human-run pelo próprio runbook.",
            "Só documentação.",
            "EOF",
            ')" 2>&1 | tail -3',
          ].join("\n");
          expect(guardDecision(real, RULES, false)).toBe("allow");
        });

        it.each([
          ['gh pr create --title t --body "$(cat'],
          ['gh issue comment 3 --body "$(cat'],
          ['git tag -a v1 -m "$(cat'],
          ['git -C sub commit -am "$(cat'],
        ])("%s … )\" 2>&1 | tail -5 → allow", (opening) => {
          expect(guardDecision(prose(opening, ')" 2>&1 | tail -5'), RULES, false), opening).toBe("allow");
        });

        // O que a linha de fechamento diz fora dessa lista continua tirando o corpo de ser dado: a prosa vira script.
        it.each([
          [')" | bash'],
          [')" | sh -c'],
          [')" | xargs rm'],
          [')" > arquivo'],
          [')" | tee out.txt'],
          [')" | tail -f'],
          [')" | tail -5 | bash'],
          [')" 2>&1 | sh'],
          [')" 2>&1 > out.txt'],
        ])("commit: %s → deny (a prosa é lida e cita um comando proibido)", (closing) => {
          expect(guardDecision(prose('git commit -m "$(cat', closing), RULES, false), closing).toBe("deny");
        });

        it("`2>&1` e `| tail` não destravam um consumidor que não é de texto, nem uma mensagem que não é a última palavra", () => {
          expect(guardDecision(prose('bash -c "$(cat', ')" 2>&1 | tail -5'), RULES, false)).toBe("deny");
          expect(guardDecision(prose('echo "$(cat', ')" 2>&1 | tail -5'), RULES, false)).toBe("deny");
          expect(guardDecision(prose('git commit -m x "$(cat', ')" 2>&1 | tail -5'), RULES, false)).toBe("deny");
          expect(guardDecision(prose('git -c core.editor=sh commit -m "$(cat', ')" 2>&1 | tail -5'), RULES, false)).toBe("deny");
        });

        it("a linha que fecha só diz isso: uma segunda linha depois dela é outro comando, e é classificado", () => {
          expect(guardDecision(`${prose('git commit -m "$(cat', ')" 2>&1 | tail -5')}\nrm -rf /srv/app`, RULES, false)).toBe("deny");
        });
      });

      it("sem linha de fechamento nenhuma (o heredoc é a última linha) → deny", () => {
        expect(guardDecision(`git commit -m "$(cat <<'EOF'\n${BODY}\nEOF`, RULES, false)).toBe("deny");
        expect(guardDecision(`git commit -m "$(cat <<'EOF'\n${BODY}`, RULES, false)).toBe("deny");
      });

      it("a linha que fecha tem de fechar a aspa que abriu: `)` onde era `)\"` (e o contrário) → deny", () => {
        expect(guardDecision(wrap('git commit -m "$(cat', ")"), RULES, false)).toBe("deny");
        expect(guardDecision(wrap("git commit -m $(cat", ')"'), RULES, false)).toBe("deny");
      });

      it("a saída do comando de texto ligada a um interpretador na MESMA linha de abertura → deny", () => {
        expect(guardDecision(`git commit -m "$(cat <<'EOF' | bash\n${BODY}\nEOF\n)"`, RULES, false)).toBe("deny");
        expect(guardDecision(`git commit -m "$(cat <<'EOF'; bash\n${BODY}\nEOF\n)"`, RULES, false)).toBe("deny");
        expect(guardDecision(`git commit -m "$(cat <<'EOF') | bash\n${BODY}\nEOF\n"`, RULES, false)).toBe("deny");
      });

      // Mais de um nível de substituição, ou outra coisa que roda em volta: dúvida, o corpo é classificado.
      it.each([
        ['git commit -m "$(echo $(cat'],
        ['git commit -m "$(echo "$(cat'],
        ['git commit -m "$(printf %s "$(cat'],
        ['git commit -m "$(true; cat'],
        ['bash <(git commit -m "$(cat'],
        ['bash -c "git commit -m \\"$(cat'],
        ['(git commit -m "$(cat'],
        ['{ git commit -m "$(cat'],
        ['x=$(git commit -m "$(cat'],
        ['`git commit -m "$(cat'],
        ['git commit -m "`git commit -m $(cat'],
        ['git commit -m "$(cat <(cat'],
      ])("em volta de %s: mais do que o consumidor de texto → deny", (opening) => {
        expect(guardDecision(wrap(opening, ')")'), RULES, false), opening).toBe("deny");
        expect(guardDecision(wrap(opening, ")"), RULES, false), opening).toBe("deny");
      });
    });

    // git na allowlist só com um conjunto FECHADO de opções: uma opção global que roda código (`-c`, `--exec-path`,
    // `--git-dir`...) ou aponta para outro repo e a sua configuração, ou uma opção que abre o editor, tira o git
    // da allowlist. Vale nas três formas: heredoc em -F -, a substituição em -m e o here-string.
    describe("git: o conjunto fechado de opções", () => {
      const stdin = (git: string) => `${git} <<'EOF'\n${BODY}\nEOF`;
      const subst = (git: string) => `${git} <<'EOF'\n${BODY}\nEOF\n)"`;

      it.each([
        ["git commit -F -"],
        ["git commit -q -F -"],
        ["git commit -s --allow-empty --allow-empty-message --no-verify -F -"],
        ["git commit -F - -sq"], // abreviações: cada letra é uma opção do commit que está no conjunto
        ["git commit --amend --no-edit -a -F -"],
        ["git commit -F - -- notes.md"],
        ["git commit --file=-"],
        ["git commit -F-"],
        ["git -C sub commit -F -"],
        ["git --no-pager commit -F -"],
        ["git tag -a v1 -F -"],
        ["git tag -f -a v1 --file=-"],
        ["git notes add -F -"],
        ["git notes add -f -F - HEAD"],
        ["git merge --no-ff -F - topo"],
      ])("%s <<'EOF' + rm -rf → allow", (opening) => {
        expect(guardDecision(stdin(opening), RULES, false), opening).toBe("allow");
      });

      it.each([
        // opções globais que executam código ou trocam o repo/a configuração
        ["git -c core.editor=sh commit -F -"],
        ["git -c alias.x=!sh commit -F -"],
        ["git -c user.name=x commit -F -"],
        ["git -ccore.editor=sh commit -F -"],
        ["git --config-env=core.editor=ED commit -F -"],
        ["git --config-env core.editor=ED commit -F -"],
        ["git --exec-path=/tmp/x commit -F -"],
        ["git --exec-path /tmp/x commit -F -"],
        ["git --git-dir=/x/.git commit -F -"],
        ["git --git-dir /x/.git commit -F -"],
        ["git --work-tree=/x commit -F -"],
        ["git --work-tree /x commit -F -"],
        ["git --namespace=n commit -F -"],
        ["git --super-prefix=x commit -F -"],
        ["git -p commit -F -"],
        ["git --paginate commit -F -"],
        ["git --bare commit -F -"],
        ["git -C"],
        // opções do subcomando que abrem o editor ou mexem no que roda
        ["git commit -e -F -"],
        ["git commit --edit -F -"],
        ["git commit -F - --template=t.txt"],
        ["git commit -F - -S"],
        ["git commit -F - --gpg-sign=k"],
        ["git commit -F - --author=x"],
        ["git commit -F - -c HEAD"],
        ["git commit -F - -C HEAD"],
        ["git commit -F - --fixup=HEAD"],
        ["git commit -F - --cleanup=verbatim"],
        ["git commit -F - -i"],
        ["git commit -F - --interactive"],
        ["git commit -F - -p"],
        ["git commit -F - --verbose"],
        ["git commit -F - --exec=x"],
        ["git commit -F - -sS"], // uma letra que o conjunto não conhece derruba a abreviação inteira
        ["git tag -a v1 -F - -s"],
        ["git tag -a v1 -F - -u key"],
        ["git tag -a v1 -F - -e"],
        ["git notes edit -F - -e"],
        ["git merge -F - --edit topo"],
        ["git merge -F - -e topo"],
        ["git merge -F - -s ours -X x topo"],
        // outros subcomandos, e o programa que não é git
        ["git log -F -"],
        ["git commit-tree -F -"],
        ["git filter-branch -F -"],
        ["git -F -"],
        ["git ./commit -F -"],
        ["GIT_EDITOR=sh git commit -F -"],
        ["GIT_SSH_COMMAND=x git commit -F -"],
        ["env git commit -F -"],
        ["sudo git commit -F -"],
      ])("%s <<'EOF' + rm -rf → deny (fora do conjunto fechado)", (opening) => {
        expect(guardDecision(stdin(opening), RULES, false), opening).toBe("deny");
      });

      it.each([
        ["git commit -m"],
        ["git commit -a -m"],
        ["git commit -s -q --no-verify --allow-empty -m"],
        ["git commit --message"],
        ["git -C sub commit -m"],
        ["git tag -a v1 -m"],
        ["git notes add -m"],
        ["git merge --no-ff -m"],
      ])('%s "$(cat … → allow', (opening) => {
        expect(guardDecision(subst(`${opening} "$(cat`), RULES, false), opening).toBe("allow");
      });

      it.each([
        ["git -c core.editor=sh commit -m"],
        ["git -c alias.x=!sh commit -m"],
        ["git --config-env=core.editor=ED commit -m"],
        ["git --exec-path=/x commit -m"],
        ["git --git-dir=/x commit -m"],
        ["git --work-tree=/x commit -m"],
        ["git commit -e -m"],
        ["git commit --edit -m"],
        ["git commit --template=t -m"],
        ["git commit -S -m"],
        ["git commit --gpg-sign -m"],
        ["git commit --author=x -m"],
        ["git commit -C HEAD -m"],
        ["git commit -F x -m"],
        ["git commit -m x -F"], // a mensagem não é a última palavra
        ["git commit -t"],
        ["git log --format"],
        ["git config -m"],
        ["sudo git commit -m"],
        ["GIT_EDITOR=sh git commit -m"],
      ])('%s "$(cat … → deny', (opening) => {
        expect(guardDecision(subst(`${opening} "$(cat`), RULES, false), opening).toBe("deny");
      });
    });
  });

  describe("o que vem depois da substituição, e dentro dela", () => {

    it("o que vem depois da substituição continua sendo classificado", () => {
      expect(guardDecision(`git commit -m "$(cat <<'EOF'\n${BODY}\nEOF\n)" && rm -rf build`, RULES, false)).toBe("deny");
    });

    it("dentro da substituição, o receptor tem de estar na allowlist (psql não)", () => {
      expect(guardDecision(`git commit -m "$(psql <<'EOF'\nDROP TABLE users;\nEOF\n)"`, RULES, false)).toBe("deny");
    });
  });
});

// O here-string do PowerShell (`@'…'@`, `@"…"@`) NÃO é dado. Decisão do PO, depois de três achados HIGH da revisão
// automática no tratamento que a onda 2 (A6) lhe deu: o corpo é classificado em qualquer ferramenta, como na main. No
// bash `@'` é uma aspa comum (o primeiro `'` do corpo a fecha e o que vem depois roda), um `#` ou um `$'` na linha de
// abertura faz o bash e o guard lerem a linha de jeitos diferentes, e o guard não sabe qual shell lê o texto. A saída para
// uma mensagem que cita um comando destrutivo é `git commit -F <arquivo>` ou `gh … --body-file`; o `-m @'…'@` segue pela
// opção de texto fechada (INERT_TEXT_OPTIONS), como já seguia.
describe("here-string do PowerShell: não é dado, o corpo é classificado (como na main)", () => {
  const RULES = {
    tier3: { label: "t3", patterns: ["\\bdrop\\s+table\\b", "vercel\\s+.*--prod\\b"], ask_patterns: [] },
    tier2: { label: "t2", patterns: [] },
  } as Parameters<typeof guardDecision>[1];
  const PROSE = "Para limpar, rode rm -rf build e depois drop table users.\nNão rode vercel --prod na mão.";
  const DROP = "psql -c 'DROP TABLE users'";
  const lf = (s: string) => s;
  const crlf = (s: string) => s.replace(/\n/g, "\r\n");

  describe.each([["LF", lf], ["CRLF", crlf]])("quebras de linha %s", (_name, eol) => {
    // A prosa que cita um comando proibido nega, qualquer que seja quem recebe o here-string.
    it.each([
      [`@'\n${PROSE}\n'@ | Set-Content notes.md`],
      [`@"\n${PROSE}\n"@ | Set-Content notes.md`],
      [`@'\n${PROSE}\n'@ | Out-File -FilePath runbook.md -Encoding utf8`],
      [`Set-Content -Path notes.md -Value @'\n${PROSE}\n'@`],
      [`Add-Content notes.md @"\n${PROSE}\n"@`],
      [`@'\n${PROSE}\n'@ > notes.md`],
      [`@'\n${PROSE}\n'@`],
      [`@'\n${PROSE}\n'@ | Set-Content a.md\n@'\n${PROSE}\n'@ | Set-Content b.md`],
      [`Out-File notes.md -InputObject @'\n${PROSE}\n'@ -Encoding utf8`],
      [`git commit -am @'\n${PROSE}\n'@`],
    ])("a prosa que cita um comando proibido é classificada → deny: %j", (command) => {
      expect(guardDecision(eol(command), RULES, false), command).toBe("deny");
    });

    it("um comando real fora do corpo continua negado, antes e depois", () => {
      expect(guardDecision(eol(`@'\nprosa\n'@ | Set-Content notes.md; rm -rf build`), RULES, false)).toBe("deny");
      expect(guardDecision(eol(`rm -rf build; @'\nprosa\n'@ | Set-Content notes.md`), RULES, false)).toBe("deny");
    });

    it("o corpo sem nada proibido segue allow: classificar não nega o que não cita nada", () => {
      expect(guardDecision(eol(`@'\nso uma nota sem comando nenhum\n'@ | Set-Content notes.md`), RULES, false)).toBe("allow");
      expect(guardDecision(eol(`Set-Content notes.md @'\nlinha 1\nlinha 2\n'@`), RULES, false)).toBe("allow");
    });
  });

  // O que a main já fazia, e continua: o valor de `-m`, `--body`, `--notes`... é texto (INERT_TEXT_OPTIONS), com o
  // here-string ou sem ele; um `$(...)` dentro dele ainda conta.
  it("o here-string no -m do git commit e no --body do gh segue como antes (opção de texto, não receptor de dado)", () => {
    expect(guardDecision(`git commit -m @'\nfix: ${PROSE.split("\n")[0]}\n'@`, RULES, false)).toBe("allow");
    expect(guardDecision(`gh pr create --title 'x' --body @'\n${PROSE}\n'@`, RULES, false)).toBe("allow");
    expect(guardDecision(`git tag -a v1 -m @'\n${PROSE}\n'@`, RULES, false)).toBe("allow");
    expect(guardDecision(`gh release create v1 --notes @'\n${PROSE}\n'@`, RULES, false)).toBe("allow");
    expect(guardDecision("git commit -m @'\n$(vercel --prod)\n'@", RULES, false)).toBe("deny");
    // a opção de texto vale seja qual for o resto da linha de git (é o strip de main, não um receptor de dado)
    expect(guardDecision(`git -C sub commit -m @'\n${PROSE}\n'@ --no-verify`, RULES, false)).toBe("allow");
    expect(guardDecision("git -c core.editor=sh commit -m @'\nrm -rf /\n'@", RULES, false)).toBe("allow");
    expect(guardDecision("git commit -e -m @'\nrm -rf /\n'@", RULES, false)).toBe("allow");
  });

  // As sondas do QA (frente A): o primeiro `'` do corpo fecha a aspa no bash, e o que vem depois roda.
  describe("o `'` no corpo fecha a aspa no bash: o que vem depois roda", () => {
    it.each([
      [`git commit -m @'\n' ; ${DROP} ; echo '\n'@`],
      [`gh pr create --body @'\n' ; ${DROP} ; echo '\n'@`],
      [`gh pr create --title t --body @'\nx' ; ${DROP} ; echo 'y\n'@`],
      [`Set-Content x @'\n' ; ${DROP} ; echo '\n'@`],
      [`@'\n' ; ${DROP} ; echo '\n'@`],
      [`@'\n' ; ${DROP} ; echo '\n'@ | Set-Content x`],
      [`@'\n' ; ${DROP} ; echo '\n'@ > x.txt`],
      [`git commit -m @"\n" ; ${DROP} ; echo "\n"@`],
      [`@"\n" ; ${DROP} ; echo "\n"@`],
      [`@"\n" ; ${DROP} ; echo "\n"@ | Set-Content x`],
      [`Add-Content x @'\numa linha com ' no meio ; ${DROP}\n'@`],
      [`Out-File x -InputObject @"\numa linha com " no meio ; ${DROP}\n"@`],
    ])("%j → deny", (command) => {
      for (const c of [command, crlf(command)]) expect(guardDecision(c, RULES, false), command).toBe("deny");
    });
  });

  // O `#` e o `$'`/`$"` na linha de abertura: o bash lê o `@'` como comentário ou como outra aspa, e o corpo roda.
  describe("o `#` e o `$'`/`$\"` na linha de abertura", () => {
    it.each([
      ["git commit -m x # @'\nDROP TABLE users\n'@"],
      ["Set-Content x # @'\nDROP TABLE users\n'@"],
      ["gh pr create --body # @'\nDROP TABLE users\n'@"],
      ["git commit -m x # @\"\nDROP TABLE users\n\"@"],
      ["git commit -m $'x' @'\nDROP TABLE users\n'@"],
      ["git commit -m $\"x\" @'\nDROP TABLE users\n'@"],
      ["Set-Content $'x' @'\nDROP TABLE users\n'@"],
    ])("%j → deny", (command) => {
      for (const c of [command, crlf(command)]) expect(guardDecision(c, RULES, false), command).toBe("deny");
    });
  });

  // O corpo é executado quando a linha de abertura ou a de fechamento o manda a um executor.
  it.each([
    ["@'\nrm -rf /\n'@ | iex"],
    ["@'\nrm -rf /\n'@ | Invoke-Expression"],
    ["@'\nrm -rf /\n'@ | powershell -Command -"],
    ["@'\nrm -rf /\n'@ | pwsh -c -"],
    ["@'\nrm -rf /\n'@ | & powershell -NoProfile -Command -"],
    ["@'\nrm -rf /\n'@ | bash"],
    ["@'\nrm -rf /\n'@ | cmd /c"],
    ["@\"\nrm -rf /\n\"@ | iex"],
    ["Invoke-Expression @'\nrm -rf /\n'@"],
    ["iex (@'\nrm -rf /\n'@)"],
    ["powershell -Command @'\nrm -rf /\n'@"],
    ["& bash -c @'\nrm -rf /\n'@"],
    ["true && iex @'\nrm -rf /\n'@"],
    ["@'\ndrop table users\n'@ | iex"],
    ["$texto = @'\nrm -rf /\n'@"],
    ["New-Item notes.md -Value @'\nrm -rf /\n'@ -Force"],
    ["psql -c @'\nDROP TABLE users;\n'@"],
    ["Invoke-Sqlcmd -Query @'\nDROP TABLE users;\n'@"],
    ["& $programa @'\nrm -rf /\n'@"],
    ["@'\nrm -rf /\n'@ | Set-Content a.md | iex"],
    ["@'\nrm -rf /\n'@ | sc notes.md"],
    ["sc create svc binPath= @'\nrm -rf /\n'@"],
  ])("o corpo é script → deny: %j", (command) => {
    expect(guardDecision(command, RULES, false), command).toBe("deny");
    expect(guardDecision(command.replace(/\n/g, "\r\n"), RULES, false), `${command} (CRLF)`).toBe("deny");
  });

  it("um executor em outro here-string da mesma linha de comando não contamina o primeiro", () => {
    expect(guardDecision(`@'\nprosa\n'@ | Set-Content notes.md\n@'\nrm -rf /\n'@ | iex`, RULES, false)).toBe("deny");
    expect(guardDecision(`@'\nrm -rf /\n'@ | iex\n@'\nprosa\n'@ | Set-Content notes.md`, RULES, false)).toBe("deny");
  });

  // Falha fechada: o que não fecha como um here-string de verdade continua sendo classificado.
  it.each([
    ["@'\nrm -rf /\n", "sem fechamento"],
    ["@'\nrm -rf /\n  '@ | Set-Content notes.md", "o fechamento não abre a linha"],
    ["@'\nrm -rf /\n\"@ | Set-Content notes.md", "o fechamento é de outra aspa"],
    ["Write-Host @'x rm -rf /'@", "uma linha só: é um string comum"],
  ])("%j (%s) → o texto segue classificado", (command) => {
    expect(guardDecision(command, RULES, false), command).toBe("deny");
  });

  it("um heredoc do bash na mesma linha de comando não é confundido com o here-string", () => {
    expect(guardDecision("cat > f.md <<'EOF'\nrm -rf /\nEOF", RULES, false)).toBe("allow");
    expect(guardDecision("bash <<'EOF'\nrm -rf /\nEOF", RULES, false)).toBe("deny");
  });

  it("não há aspa no corpo, mas o heredoc é que decide: `cat > f <<'EOF'` com um `@'` na prosa segue dado", () => {
    expect(guardDecision("cat > f.md <<'EOF'\nusa @' para abrir\nrm -rf /srv\nEOF", RULES, false)).toBe("allow");
  });
});

// Revisão do QA da frente A (R1, R2, R3, A2): quatro furos que as endurecidas da allowlist abriram ou deixaram.
describe("QA frente A — chave de protótipo, aspa do bash, continuação de linha, comentário e regex que lança", () => {
  const RULES = {
    tier3: { label: "t3", patterns: ["\\bdrop\\s+table\\b"], ask_patterns: [] },
    tier2: { label: "t2", patterns: [] },
  } as Parameters<typeof guardDecision>[1];
  const DROP = "psql -c 'DROP TABLE users'";
  const eols = (command: string): Array<[string, string]> => [[command, "LF"], [command.replace(/\n/g, "\r\n"), "CRLF"]];

  // R1: um objeto literal indexado pelo texto do comando devolve um membro herdado (`constructor`, `__proto__`,
  // `toString`...), que depois lança. A exceção cai no piso (F3), que libera tudo o que não é rm -rf ou force-push.
  describe("R1 — o subcomando do git que é nome de um membro herdado de Object", () => {
    const KEYS = ["constructor", "__proto__", "hasOwnProperty", "toString", "valueOf", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "__defineGetter__", "__lookupGetter__"];

    it.each(KEYS.flatMap((key) => [[`git ${key} --x <<'EOF'\nhi\nEOF\n${DROP}`], [`git ${key} -am <<EOF\nhi\nEOF\n${DROP}`], [`git ${key} -F - <<'EOF'\nhi\nEOF\n${DROP}`], [`git -C sub ${key} -m <<'EOF'\nhi\nEOF\n${DROP}`]]))(
      "%j → deny, sem exceção",
      (command) => {
        expect(() => splitSubCommands(command)).not.toThrow();
        expect(() => guardDecision(command, RULES, false)).not.toThrow();
        expect(guardDecision(command, RULES, false), command).toBe("deny");
        expect(explainDeny(command, RULES).culprit).toContain("DROP TABLE");
      }
    );

    it.each(KEYS.map((key) => [`git ${key} --x <<'EOF'\nrm -rf /srv/app\nEOF`]))("%j → o corpo é classificado: deny", (command) => {
      expect(guardDecision(command, RULES, false), command).toBe("deny");
    });

    it("o git de verdade segue igual: commit com -F - e o corpo como dado", () => {
      expect(guardDecision("git commit -F - <<'EOF'\nrm -rf /srv\nEOF", RULES, false)).toBe("allow");
    });
  });

  // R3: o shell junta `cat <<'EOF' \` com a linha seguinte (`cat <<'EOF' | bash`); o corpo é então o script de um shell.
  describe("R3 — a linha de abertura que termina em `\\` continua na próxima", () => {
    it.each([
      ["cat <<'EOF' \\\n| bash\nrm -rf /tmp/x\nEOF"],
      ["cat <<'EOF' \\\n | bash\nrm -rf /tmp/x\nEOF"],
      [`cat <<'EOF' \\\n| bash\n${DROP}\nEOF`],
      ["cat <<'EOF' \\\n| bash\nDROP TABLE users;\nEOF"],
      ["cat <<'EOF' | \\\nbash\nrm -rf /tmp/x\nEOF"],
      ["cat > f.md <<'EOF' \\\n&& bash\nrm -rf /tmp/x\nEOF"],
      ["cat <<'EOF' \\\\\\\n| bash\nrm -rf /tmp/x\nEOF"], // três barras: a última escapa a quebra de linha
      ["tee a.md <<'EOF' \\\n| sh\nrm -rf /srv\nEOF"],
      ["git commit -F - <<'EOF' \\\n| bash\nrm -rf /srv\nEOF"],
      ["cat <<-'EOF' \\\n| bash\n\trm -rf /srv\n\tEOF"],
      ["cat <<EOF \\\n| bash\nrm -rf /srv\nEOF"],
      ["true && cat <<'EOF' \\\n| bash\nrm -rf /srv\nEOF"],
    ])("%j → deny", (command) => {
      for (const [c, eol] of eols(command)) expect(guardDecision(c, RULES, false), `${command} (${eol})`).toBe("deny");
    });

    it("um número par de barras não continua a linha: o heredoc segue sendo dado", () => {
      expect(guardDecision("cat > runbook.md <<'EOF' \\\\\nrm -rf /srv/app\nEOF", RULES, false)).toBe("allow");
      expect(guardDecision("cat > runbook.md <<'EOF'\nrm -rf /srv/app\nEOF", RULES, false)).toBe("allow");
    });

    it("a barra no meio da linha de abertura (não no fim) não muda nada", () => {
      expect(guardDecision("cat > a\\ b.md <<'EOF'\nrm -rf /srv/app\nEOF", RULES, false)).toBe("allow");
    });
  });

  // O comentário que esconde o heredoc: `cat # <<'EOF'` não abre nada, e o que vem depois são comandos de verdade.
  describe("R3 — `#` no começo de uma palavra, antes do `<<`, é comentário", () => {
    it.each([
      [`cat # <<'EOF'\n${DROP}\nEOF`],
      [`cat # <<'EOF'\nrm -rf /srv/app\nEOF`],
      [`cat > f.md # <<'EOF'\nrm -rf /srv/app\nEOF`],
      [`true;# <<'EOF'\nrm -rf /srv/app\nEOF`],
      [`cat\t#<<'EOF'\nrm -rf /srv/app\nEOF`],
      [`# cat <<'EOF'\nrm -rf /srv/app\nEOF`],
      [`git commit -F - # <<'EOF'\nrm -rf /srv/app\nEOF`],
    ])("%j → deny", (command) => {
      for (const [c, eol] of eols(command)) expect(guardDecision(c, RULES, false), `${command} (${eol})`).toBe("deny");
    });

    it("o `#` dentro de uma palavra, entre aspas ou como `$#` não é comentário: o heredoc é dado", () => {
      for (const command of [
        "echo a#b; cat > f.md <<'EOF'\nrm -rf /srv/app\nEOF",
        "echo \"# não é comentário\"; cat > f.md <<'EOF'\nrm -rf /srv/app\nEOF",
        "echo '# nem este'; cat > f.md <<'EOF'\nrm -rf /srv/app\nEOF",
        "echo $# $#; cat > f.md <<'EOF'\nrm -rf /srv/app\nEOF",
        "cat > f#1.md <<'EOF'\nrm -rf /srv/app\nEOF",
      ]) expect(guardDecision(command, RULES, false), command).toBe("allow");
    });
  });

  // A linha de abertura com um `#` em começo de palavra fora de aspas (comentário no bash) ou um `$'`/`$"` (ANSI-C e
  // tradução): o lexer não modela nenhum dos dois, então o bash e o guard leem a linha de jeitos diferentes. É dúvida,
  // e o corpo é classificado.
  describe("R3d — `#` e `$'`/`$\"` na linha de abertura de um heredoc", () => {
    it.each([
      // heredoc: o `#` antes e depois do `<<`
      ["cat > f.md <<'EOF' # nota\nrm -rf /srv/app\nEOF"],
      ["cat > f.md <<'EOF' #\nrm -rf /srv/app\nEOF"],
      ["cat <<'EOF' # | bash\nrm -rf /srv/app\nEOF"],
      ["cat > f.md # <<'EOF'\nrm -rf /srv/app\nEOF"],
      ["git commit -F - <<'EOF' # x\nrm -rf /srv/app\nEOF"],
      ["tee a.md <<'EOF' #x\nrm -rf /srv/app\nEOF"],
      [`cat > f.md <<'EOF' # nota\n${DROP}\nEOF`],
      // heredoc: `$'` e `$"`
      ["cat > $'f.md' <<'EOF'\nrm -rf /srv/app\nEOF"],
      ["cat > $\"f.md\" <<'EOF'\nrm -rf /srv/app\nEOF"],
      ["cat $'a\\'b' > f.md <<'EOF'\nrm -rf /srv/app\nEOF"],
      ["cat > f.md <<'EOF' $'x'\nrm -rf /srv/app\nEOF"],
      ["git commit -m $'msg' -F - <<'EOF'\nrm -rf /srv/app\nEOF"],
      ["git commit -m $\"msg\" -F - <<'EOF'\nrm -rf /srv/app\nEOF"],
      [`cat > $'f.md' <<'EOF'\n${DROP}\nEOF`],
    ])("%j → deny", (command) => {
      for (const [c, eol] of eols(command)) expect(guardDecision(c, RULES, false), `${command} (${eol})`).toBe("deny");
    });

    it("o `#` e o `$'` entre aspas, dentro de uma palavra ou como `$#` não contam: o corpo segue dado", () => {
      for (const command of [
        "git commit -m \"fix #123 e $'x'\" -F - <<'EOF'\nrm -rf /srv/app\nEOF",
        "git commit -m 'fix #123' -F - <<'EOF'\nrm -rf /srv/app\nEOF",
        "cat > f#1.md <<'EOF'\nrm -rf /srv/app\nEOF",
        "echo $# > f.md; cat > g.md <<'EOF'\nrm -rf /srv/app\nEOF",
      ]) expect(guardDecision(command, RULES, false), command).toBe("allow");
    });
  });

  // Uma aspa aberta numa linha engole o `<<` das seguintes: o `cat <<EOF` é texto, e o que vem depois da aspa roda.
  describe("R3 — aspa aberta e não fechada antes do `<<`", () => {
    it.each([
      [`echo '\ncat <<EOF\n'\n${DROP}\nEOF`],
      [`echo "\ncat <<EOF\n"\n${DROP}\nEOF`],
      [`echo '\ncat > f.md <<'EOF'\n'\nrm -rf /srv/app\nEOF`],
      [`echo 'a\nb\nc\ncat <<EOF\n'\n${DROP}\nEOF`],
      [`git commit -m "x\ncat > f.md <<'EOF'\n"\nrm -rf /srv/app\nEOF`],
      [`echo '\ncat <<EOF\n'; rm -rf /srv/app\nEOF`],
    ])("%j → deny", (command) => {
      for (const [c, eol] of eols(command)) expect(guardDecision(c, RULES, false), `${command} (${eol})`).toBe("deny");
    });

    // O `$(` ou a crase aberta numa linha anterior: o `cat <<EOF` da linha seguinte está DENTRO da substituição, e o que o
    // comando em volta faz com a saída (`| bash`) não aparece na linha de abertura.
    it.each([
      ["echo \"$(\ncat <<'EOF'\nrm -rf /srv/app\nEOF\n)\" | bash"],
      ["bash -c \"$(\ncat <<'EOF'\nrm -rf /srv/app\nEOF\n)\""],
      ["x=$(\ncat <<'EOF'\nrm -rf /srv/app\nEOF\n)\nbash -c \"$x\""],
      ["echo `\ncat <<'EOF'\nrm -rf /srv/app\nEOF\n` | bash"],
      [`eval "$(\ncat <<'EOF'\n${DROP}\nEOF\n)"`],
      ["(\ncat <<'EOF' | bash\nrm -rf /srv/app\nEOF\n)"],
      ["bash <(\ncat <<'EOF'\nrm -rf /srv/app\nEOF\n)"],
    ])("%j → deny (a substituição aberta numa linha anterior)", (command) => {
      for (const [c, eol] of eols(command)) expect(guardDecision(c, RULES, false), `${command} (${eol})`).toBe("deny");
    });

    // Um `$'` ou `$"` numa linha anterior: o scanShell não o modela, então o estado das aspas dali em diante é desconhecido
    // (`$'\'` abre uma string ANSI-C que atravessa as linhas até o próximo `'`). Todo heredoc seguinte é dúvida.
    it.each([
      ["echo $'\\'\ncat <<EOF\n'\n" + DROP + "\nEOF"],
      ["echo $\"\\\"\ncat <<EOF\n\"\n" + DROP + "\nEOF"],
      ["echo $'a'\ncat <<EOF\nrm -rf /srv/app\nEOF"],
      ["x=$'a'; echo ok\ncat > f.md <<'EOF'\nrm -rf /srv/app\nEOF"],
      ["echo $'a'\necho b\necho c\ncat > f.md <<'EOF'\nrm -rf /srv/app\nEOF"],
      ["echo ok # $'\ncat > f.md <<'EOF'\nrm -rf /srv/app\nEOF\necho $'x'\ncat > g.md <<'EOF'\nrm -rf /srv/app\nEOF"],
      // o `$'` na linha de abertura de um heredoc, e no corpo de um heredoc em dúvida: o estado de depois também é desconhecido
      ["cat > $'a' <<'EOF'\nx\nEOF\ncat > g.md <<'EOF'\nrm -rf /srv/app\nEOF"],
      ["cat # <<'EOF'\necho $'x'\nEOF\ncat > g.md <<'EOF'\nrm -rf /srv/app\nEOF"],
    ])("%j → deny (um `$'` antes envenena o estado: o heredoc é dúvida)", (command) => {
      for (const [c, eol] of eols(command)) expect(guardDecision(c, RULES, false), `${command} (${eol})`).toBe("deny");
    });

    it("o `$'` só entre aspas ou como `$#` não envenena nada: o heredoc seguinte segue dado", () => {
      for (const command of [
        "echo \"$'a'\"\ncat > f.md <<'EOF'\nrm -rf /srv/app\nEOF",
        "echo $#\ncat > f.md <<'EOF'\nrm -rf /srv/app\nEOF",
      ]) expect(guardDecision(command, RULES, false), command).toBe("allow");
    });

    it("o estado das aspas acompanha as linhas que o heredoc em dúvida deixou inline: depois de a aspa fechar, um heredoc de verdade volta a ser dado", () => {
      const command = "echo '\ncat <<EOF\n'\nEOF\ncat > f.md <<'EOF2'\nrm -rf /srv/app\nEOF2";
      for (const [c, eol] of eols(command)) expect(guardDecision(c, RULES, false), eol).toBe("allow");
    });

    it("a aspa que abre numa linha e fecha antes do heredoc não atrapalha: o heredoc segue dado", () => {
      for (const command of [
        "echo 'a\nb'\ncat > f.md <<'EOF'\nrm -rf /srv/app\nEOF",
        "git commit -m \"linha 1\nlinha 2\"\ncat > f.md <<'EOF'\nrm -rf /srv/app\nEOF",
        "echo \"it's\"\ncat > f.md <<'EOF'\nrm -rf /srv/app\nEOF",
        "# don't\ncat > f.md <<'EOF'\nrm -rf /srv/app\nEOF",
        "echo don\\'t\ncat > f.md <<'EOF'\nrm -rf /srv/app\nEOF",
      ]) expect(guardDecision(command, RULES, false), command).toBe("allow");
    });

    it("depois do idioma de commit (a substituição fecha na linha seguinte), outro heredoc volta a ser dado", () => {
      const command = `git commit -m "$(cat <<'EOF'\nfeat: x\nEOF\n)"\ncat > f.md <<'EOF'\nrm -rf /srv/app\nEOF`;
      for (const [c, eol] of eols(command)) expect(guardDecision(c, RULES, false), eol).toBe("allow");
    });

    it("o idioma de commit com substituição não é confundido com uma aspa aberta", () => {
      expect(guardDecision(`git commit -m "$(cat <<'EOF'\nrm -rf /srv/app\nEOF\n)"`, RULES, false)).toBe("allow");
      expect(guardDecision(`echo "feito"\ngit commit -m "$(cat <<'EOF'\nrm -rf /srv/app\nEOF\n)" 2>&1 | tail -3`, RULES, false)).toBe("allow");
    });
  });

  // A2: um padrão que compila mas lança no primeiro `.test` ("Regular expression too large") jogava todo comando no
  // caminho de exceção do hook, e o piso libera tudo o que não é rm -rf.
  describe("A2 — um padrão que compila e lança no primeiro uso é descartado", () => {
    const TOO_LARGE = "a?".repeat(200_000);

    it("o próprio padrão: compila, e o `.test` lança (a premissa do teste)", () => {
      const re = new RegExp(TOO_LARGE, "i");
      expect(() => re.test("")).toThrow(/too large|stack overflow/i); // a mensagem depende da pilha do ambiente
    });

    it("tier3.patterns: o que lança é descartado e os outros seguem negando", () => {
      const rules = { tier3: { label: "t3", patterns: [TOO_LARGE, "\\bdrop\\s+table\\b"], ask_patterns: [] }, tier2: { label: "t2", patterns: [] } } as Parameters<typeof guardDecision>[1];
      expect(() => guardDecision("ls -la", rules, false)).not.toThrow();
      expect(guardDecision("ls -la", rules, false)).toBe("allow");
      expect(guardDecision(DROP, rules, false)).toBe("deny");
      expect(() => explainDeny(DROP, rules)).not.toThrow();
      expect(explainDeny(DROP, rules).culprit).toBe(DROP);
    });

    it("ask_patterns e tier2.patterns: o mesmo", () => {
      const DEPLOY = "\\bgh\\s+workflow\\s+run\\s+\\S*deploy";
      const rules = { tier3: { label: "t3", patterns: [DEPLOY], ask_patterns: [TOO_LARGE, DEPLOY] }, tier2: { label: "t2", patterns: [TOO_LARGE, "\\bgit\\s+commit\\b"] } } as Parameters<typeof guardDecision>[1];
      expect(() => guardDecision("git commit -m x", rules, false)).not.toThrow();
      expect(guardDecision("gh workflow run deploy.yml -f ref=v1", rules, false)).toBe("ask");
      expect(classifyTier("git commit -m x", rules)).toBe(2);
    });

    it("countCompilablePatterns não conta o que lança (o loader recusa um mapa que só tem esses)", () => {
      expect(countCompilablePatterns([TOO_LARGE])).toBe(0);
      expect(countCompilablePatterns([TOO_LARGE, "\\bdrop\\b"])).toBe(1);
    });

    it("um mapa em que TODOS os padrões Tier 3 lançam não vira exceção: só o piso vale, sem lançar", () => {
      const rules = { tier3: { label: "t3", patterns: [TOO_LARGE], ask_patterns: [] }, tier2: { label: "t2", patterns: [] } } as Parameters<typeof guardDecision>[1];
      expect(() => guardDecision("rm -rf build", rules, false)).not.toThrow();
      expect(guardDecision("rm -rf build", rules, false)).toBe("deny");
    });
  });

  // Um padrão que passa pelo `.test("")` e lança só com um comando específico (a pilha de retrocesso do V8 estoura numa
  // entrada de milhões de caracteres): o guard o conta como CASADO — deny para um Tier 3, ask para um padrão que também
  // está em ask_patterns —, em vez de deixar a exceção cair no piso, que libera tudo o que não é rm -rf.
  describe("A2b — um padrão que lança com um comando específico conta como casado (falha fechada)", () => {
    const RE_TEST = RegExp.prototype.test;
    const throwOn = (source: string, trigger: string) => {
      RegExp.prototype.test = function (this: RegExp, text: string): boolean {
        if (this.source === source && String(text).includes(trigger)) throw new RangeError("Maximum call stack size exceeded");
        return RE_TEST.call(this, text);
      };
    };
    const restore = () => {
      RegExp.prototype.test = RE_TEST;
    };
    const rulesOf = (tier3: string[], ask: string[], tier2: string[]) => ({ tier3: { label: "t3", patterns: tier3, ask_patterns: ask }, tier2: { label: "t2", patterns: tier2 } }) as Parameters<typeof guardDecision>[1];

    it("tier3.patterns: o padrão que lança com este comando → deny; com outro comando o padrão segue valendo normalmente", () => {
      const rules = rulesOf(["\\bboom\\b", "\\bdrop\\s+table\\b"], [], []);
      throwOn("\\bboom\\b", "trigger");
      try {
        expect(() => guardDecision("run-it trigger", rules, false)).not.toThrow();
        expect(guardDecision("run-it trigger", rules, false)).toBe("deny");
        expect(guardDecision("ls -la", rules, false)).toBe("allow");
        expect(guardDecision("psql -c 'drop table x'", rules, false)).toBe("deny");
        expect(() => explainDeny("run-it trigger", rules)).not.toThrow();
        expect(explainDeny("run-it trigger", rules).culprit).toContain("trigger");
        expect(() => classifyTier("run-it trigger", rules)).not.toThrow();
        expect(classifyTier("run-it trigger", rules)).toBe(3);
      } finally {
        restore();
      }
    });

    it("o padrão que lança e também está em ask_patterns → ask (casou, e é um deploy que pede aprovação)", () => {
      const rules = rulesOf(["\\bboom\\b"], ["\\bboom\\b"], []);
      throwOn("\\bboom\\b", "trigger");
      try {
        expect(guardDecision("run-it trigger", rules, false)).toBe("ask");
        expect(guardDecision("ls -la", rules, false)).toBe("allow");
      } finally {
        restore();
      }
    });

    it("tier2.patterns que lança → tier 2 (casou); o resto não muda", () => {
      const rules = rulesOf(["\\bdrop\\s+table\\b"], [], ["\\bboom\\b"]);
      throwOn("\\bboom\\b", "trigger");
      try {
        expect(() => classifyTier("run-it trigger", rules)).not.toThrow();
        expect(classifyTier("run-it trigger", rules)).toBe(2);
        expect(classifyTier("ls -la", rules)).toBe(1);
      } finally {
        restore();
      }
    });

    it("um deny_hint cujo padrão lança é pulado, e a dica vem do próximo (ou do padrão)", () => {
      const rules = {
        tier3: { label: "t3", patterns: ["\\bdrop\\s+table\\b"], ask_patterns: [], deny_hints: [{ match: "\\bboom\\b", hint: "H1" }, { match: "drop", hint: "H2" }] },
        tier2: { label: "t2", patterns: [] },
      } as Parameters<typeof guardDecision>[1];
      throwOn("\\bboom\\b", "drop table");
      try {
        expect(() => explainDeny("psql -c 'drop table x'", rules)).not.toThrow();
        expect(explainDeny("psql -c 'drop table x'", rules).hint).toBe("H2");
      } finally {
        restore();
      }
    });
  });
});

// O `&` simples manda o comando da esquerda para o fundo e segue para o da direita: é um separador como o `;`. Sem
// cortar nele, `echo ok & gh workflow run deploy.yml` era UM sub-comando que começa por `echo` (inerte), e o deploy e o
// `rm -rf` passavam pelo único gate (furo do Tier 3).
describe("o `&` simples separa sub-comandos, como o `;`", () => {
  const TEMPLATE = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "tier-rules.json"), "utf8"));
  const D = "gh workflow run deploy.yml -f ref=v1 -f confirm=deploy";

  it.each([
    ["echo ok & rm -rf build", ["echo ok", "rm -rf build"]],
    ["a & b & c", ["a", "b", "c"]],
    ["a &b", ["a", "b"]],
    ["a& b", ["a", "b"]],
    ["cmd &", ["cmd"]],
    ["cmd & ", ["cmd"]],
    ["a & b && c | d ; e", ["a", "b", "c", "d", "e"]],
    ["a &\nb", ["a", "b"]],
    ["sleep 1 & psql -c 'DROP TABLE users'", ["sleep 1", "psql -c 'DROP TABLE users'"]],
    ["curl http://x/?a=1&b=2", ["curl http://x/?a=1", "b=2"]],
  ])("%j → %j", (command, expected) => {
    expect(splitSubCommands(command)).toEqual(expected);
  });

  it.each([
    ["a && b", ["a", "b"]],
    ["a || b", ["a", "b"]],
    ["make 2>&1", ["make 2>&1"]],
    ["make 2>&1 | tail", ["make 2>&1", "tail"]],
    ["echo x >&2", ["echo x >&2"]],
    ["echo x 1>&2", ["echo x 1>&2"]],
    ["cat <&3", ["cat <&3"]],
    ["make &> out.log", ["make &> out.log"]],
    ["make &>> out.log", ["make &>> out.log"]],
    ["make |& tee out.log", ["make", "tee out.log"]],
    ["make >&- ", ["make >&-"]],
    ["echo 'a & b'", ["echo 'a & b'"]],
    ['echo "a & b"', ['echo "a & b"']],
    ['echo "a & b" && c', ['echo "a & b"', "c"]],
  ])("sem mudança: %j → %j", (command, expected) => {
    expect(splitSubCommands(command)).toEqual(expected);
  });

  it("o corpo de um heredoc é dado, e o `&` dentro dele não corta nada", () => {
    const withAmp = splitSubCommands("cat > f.md <<'EOF'\na & rm -rf /\nEOF");
    expect(withAmp).toEqual(splitSubCommands("cat > f.md <<'EOF'\na ; rm -rf /\nEOF"));
    expect(withAmp.some((sub) => /rm -rf/.test(sub))).toBe(false);
    expect(guardDecision("cat > f.md <<'EOF'\necho a & rm -rf /\nEOF", TEMPLATE, false)).toBe("allow");
  });

  it("dentro de $(…) e de crases o corpo é dividido como script, `&` inclusive", () => {
    expect(splitSubCommands('echo "$(a & b)"')).toEqual(['echo "$(a & b)"', "a", "b"]);
    expect(splitSubCommands('echo "`a & b`"')).toEqual(['echo "`a & b`"', "a", "b"]);
  });

  it.each([
    [`echo ok & ${D}`, "ask"],
    [`true & ${D}`, "ask"],
    [`ls & ${D} & echo done`, "ask"],
    [`${D} &`, "ask"],
    ["echo ok & rm -rf build", "deny"],
    ["ls & rm -rf build", "deny"],
    ["true & git push --force origin main", "deny"],
    ["sleep 1 & psql -c 'DROP TABLE users'", "deny"],
    [`echo ok & ${D} & rm -rf build`, "deny"],
  ])("regras do template: %j → %s", (command, expected) => {
    expect(guardDecision(command, TEMPLATE, false)).toBe(expected);
  });

  it.each([
    ["echo ok & ls", "allow"],
    ["make 2>&1 | tail", "allow"],
    ["npm test &> out.log", "allow"],
    ["git status 2>&1", "allow"],
    ["echo 'a & rm -rf build'", "allow"],
    ['echo "ok & gh workflow run deploy.yml"', "allow"],
    ["npm run dev & npm run worker", "allow"],
  ])("não passa a negar o que era livre: %j → %s", (command, expected) => {
    expect(guardDecision(command, TEMPLATE, false)).toBe(expected);
  });

  it("o piso fixo vê o que vem depois do `&`, sem regra nenhuma", () => {
    const NONE = {} as Parameters<typeof guardDecision>[1];
    expect(guardDecision("echo ok & rm -rf build", NONE, false)).toBe("deny");
    expect(floorDenyCulprit("true & git push --force origin main")).toBe("git push --force origin main");
  });
});

// Fora de aspas, o `\` torna literal o caractere seguinte (`\&`, `\;`, `\|`, `\>`, `\<`, `\"`): a decisão de separar nunca
// depende de um caractere escapado. O `\&` de `ssh host cmd \& sudo reboot` vai para o shell REMOTO, que o lê como
// operador; cortar a linha aqui tirava o `ssh` da frente do `sudo reboot` e ele escapava dos padrões de ssh. E o
// `>` escapado de `echo \>& rm -rf x` é um argumento: o `&` que vem depois separa no bash. Como o PowerShell não escapa
// com a barra invertida (`C:\x\; rm -rf y` tem um `;` de verdade depois do caminho), o corte de antes fica também: o
// conjunto de sub-comandos é a união das duas leituras, nunca uma só.
describe("o `\\` fora de aspas: a decisão de separar não depende de um caractere escapado", () => {
  const TEMPLATE = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "tier-rules.json"), "utf8"));
  const D = "gh workflow run deploy.yml -f ref=v1 -f confirm=deploy";

  it.each([
    ["ssh prod true \\& sudo reboot", "deny"],
    ["ssh prod cd /srv \\& npm run deploy", "ask"],
    ["ssh prod true \\; sudo reboot", "deny"],
    ["ssh prod true \\| sudo reboot", "deny"],
    ["ssh prod docker ps \\& echo ok", "ask"],
    ["echo \\>& rm -rf build", "deny"],
    [`true \\<& ${D}`, "ask"],
    ["echo \\>& psql -c 'DROP TABLE users'", "deny"],
    // um `\"` não abre aspas no bash: o que vem depois roda
    ['echo \\" ; rm -rf build ; echo \\"', "deny"],
    [`echo \\" ; ${D} ; echo \\"`, "ask"],
    // no PowerShell o `\;` NÃO escapa: o `;` depois do caminho separa de verdade
    ["echo C:\\x\\; rm -rf build", "deny"],
    [`echo C:\\x\\; ${D}`, "ask"],
    ["echo C:\\x\\& rm -rf build", "deny"],
    ["echo C:\\x\\| rm -rf build", "deny"],
  ])("regras do template: %j → %s", (command, expected) => {
    expect(guardDecision(command, TEMPLATE, false)).toBe(expected);
  });

  it("a linha inteira é um dos sub-comandos (o que o shell remoto lê), e o corte de antes também", () => {
    const subs = splitSubCommands("ssh prod true \\& sudo reboot");
    expect(subs).toContain("ssh prod true \\& sudo reboot");
    expect(subs).toContain("sudo reboot");
  });

  it.each([
    ["echo a\\;b", "allow"],
    ["grep 'a' f \\| wc -l", "allow"],
    ["echo \\& ok", "allow"],
    ["ls C:\\Users\\x\\", "allow"],
    ["git status C:\\repo\\sub", "allow"],
    ["find . -name '*.js' -exec echo {} \\;", "allow"],
  ])("não passa a negar o que era livre: %j → %s", (command, expected) => {
    expect(guardDecision(command, TEMPLATE, false)).toBe(expected);
  });

  it("uma barra invertida no fim do texto não acrescenta nada à linha", () => {
    expect(splitSubCommands("echo a\\")).toEqual(["echo a\\"]);
    expect(splitSubCommands("echo a \\")).toEqual(["echo a \\"]);
    expect(splitSubCommands("\\")).toEqual(["\\"]);
  });

  it("sem barra invertida o resultado é o de sempre, na mesma ordem", () => {
    expect(splitSubCommands("a & b && c | d ; e")).toEqual(["a", "b", "c", "d", "e"]);
    expect(splitSubCommands("make 2>&1 | tail")).toEqual(["make 2>&1", "tail"]);
  });

  it("o corpo de um $(…) com barra invertida também vale pelas duas leituras", () => {
    expect(guardDecision('echo "$(ssh prod true \\& sudo reboot)"', TEMPLATE, false)).toBe("deny");
  });

  it("uma cadeia de $(…) com barras invertidas aninhadas não explode em tempo", () => {
    const nested = "$(echo a \\& ".repeat(14) + "x" + ")".repeat(14);
    const t0 = performance.now();
    expect(() => splitSubCommands(nested)).not.toThrow();
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

// O piso fixo e o padrão do template só reconheciam `--force`. `-f` sozinho ou agrupado (`-uf`, `-fu`) e o refspec com `+`
// (`+main`, `+HEAD:main`) forçam do mesmo jeito. `--force-with-lease` e `--force-if-includes` não forçam sem o lease.
describe("push forçado nas formas curta e `+ref`", () => {
  const TEMPLATE = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "tier-rules.json"), "utf8"));
  const NONE = {} as Parameters<typeof guardDecision>[1];

  const FORCED = [
    "git push --force origin main",
    "git push origin main --force",
    "git push -f origin main",
    "git push origin main -f",
    "git push -f",
    "git push -uf origin x",
    "git push -fu origin x",
    "git push -vf origin x",
    "git push -nf origin x",
    "git push -u -f origin x",
    "git push origin +main",
    "git push origin +HEAD:main",
    "git push origin +refs/heads/x:refs/heads/x",
    "git push +main",
    'git push origin "+main"',
    "git push origin '+main'",
    "git push --force-with-lease origin +main",
    "git push --force-with-lease --force origin x",
    // `--mirror` sobrescreve (e apaga) todas as refs do remoto: força todas de uma vez
    "git push --mirror",
    "git push --mirror origin",
    "git push origin --mirror",
    "git -C ../outro push --mirror backup",
    "git push --dry-run origin +main",
    "git push -- origin +main",
    "git -C ../outro push -f origin x",
    "git --no-pager push -f origin x",
    "git -c user.name=x push -uf origin x",
    "sudo git push -f origin main",
    "FOO=1 git push -f origin main",
    "ls && git push -f origin main",
    "echo ok & git push -f origin main",
    "git.exe push -f origin main",
    "GIT push -f origin main",
  ];
  const NOT_FORCED = [
    "git push",
    "git push origin main",
    "git push -u origin feat/x",
    "git push --set-upstream origin feat/x",
    "git push --force-with-lease",
    "git push --force-with-lease origin x",
    "git push --force-with-lease=main:abc123 origin x",
    "git push --force-if-includes",
    "git push --force-with-lease --force-if-includes origin x",
    "git push -n origin x",
    "git push -v origin x",
    "git push --follow-tags origin main",
    "git push --tags",
    "git push -o ci.skip origin x",
    "git push -ofix origin x",
    "git push origin HEAD:refs/heads/a+b",
    "git push origin feature/a+b",
    "git push origin feat/fix-the-thing",
    "git push --delete origin old",
    "git push origin :old",
    "git push origin +",
    "git fetch -f origin push-branch",
    "git fetch -f",
    "git pull --ff-only",
    "git checkout -f main",
    "git log -f push",
    "git commit -m 'docs: git push -f e git push origin +main'",
    "echo git push -f origin main",
  ];

  it.each(FORCED)("piso, sem regra nenhuma: %s → deny", (command) => {
    expect(guardDecision(command, NONE, false), command).toBe("deny");
  });
  it.each(FORCED)("regras do template: %s → deny", (command) => {
    expect(guardDecision(command, TEMPLATE, false), command).toBe("deny");
  });
  it.each(NOT_FORCED)("piso, sem regra nenhuma: %s → allow", (command) => {
    expect(guardDecision(command, NONE, false), command).toBe("allow");
  });
  it.each(NOT_FORCED)("regras do template: %s → allow", (command) => {
    expect(guardDecision(command, TEMPLATE, false), command).toBe("allow");
  });

  // O valor de `-o` / `--push-option` não é uma flag: o piso o pula. (O padrão do template olha a linha inteira e, de
  // propósito, é mais grosso: um ` -f` solto numa linha de `git push` pede deny ali.)
  it.each([["git push -o -f origin x"], ["git push --push-option -f origin x"], ["git push -o +x origin x"]])("piso: o valor de uma opção que leva valor não é flag: %s → allow", (command) => {
    expect(guardDecision(command, NONE, false), command).toBe("allow");
  });

  it("o break-glass allow_tier3 libera, como libera o resto do piso", () => {
    expect(guardDecision("git push -f origin main", TEMPLATE, true)).toBe("allow");
    expect(guardDecision("git push origin +main", NONE, true)).toBe("allow");
  });

  it("floorDenyCulprit (o piso quando o classificador lança) nomeia o trecho", () => {
    expect(floorDenyCulprit("ls && git push -f origin main")).toBe("git push -f origin main");
    expect(floorDenyCulprit("git push origin +main")).toBe("git push origin +main");
    expect(floorDenyCulprit("git push -u origin feat/x")).toBeNull();
    expect(floorDenyCulprit("git push --force-with-lease origin x")).toBeNull();
  });

  it("se o divisor lança, o piso grosso olha o texto inteiro e também pega as formas novas", () => {
    const broken = () => {
      throw new Error("split quebrado");
    };
    expect(floorDenyCulprit("git push -f origin main", { split: broken })).toBe("git push -f origin main");
    expect(floorDenyCulprit("git push origin +main", { split: broken })).toBe("git push origin +main");
    expect(floorDenyCulprit("git push -u origin x", { split: broken })).toBeNull();
  });
});
