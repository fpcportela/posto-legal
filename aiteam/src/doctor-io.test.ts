import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkUpstreamFlag } from "./doctor-core.mjs";
import { readGateEditDecision, readMergeDriverFacts, readTierGuardDecision, readTierRulesFacts, readTierRulesProbe, readUpstreamFacts } from "./doctor-io.mjs";
import { repoRoot } from "./repo-root.js";
import { readTierRulesFile, TEMPLATE_PATH } from "./tier-rules-loader.mjs";

// A cola do doctor com o mundo: o registro do driver no .git/config, o
// .gitattributes da raiz e os caminhos do driver que existem. O doctor.mjs roda
// sobre o repo que contém aiteam/, então a cola não se testa por ele — por isso
// vive em doctor-io.mjs, e aqui roda num repo temporário de verdade.

const DRIVER_BLOCK = [
  "# Conflict-free merges for the Bead Board memory files (Blueprint 8.1).",
  "# Union by task id, newest updated_at wins — see aiteam/scripts/beads-merge.ts.",
  "# The driver is registered by aiteam/githooks/post-checkout (git config merge.beads-yaml.*).",
  ".beads/active.yaml merge=beads-yaml",
  ".beads/*.yaml merge=beads-yaml",
  "",
].join("\n");

const OTHER_RULE_PARAGRAPH = [
  "# NOT beads-yaml, and not a wildcard over archive/: index.yaml is a FLAT list of",
  "# entries with no `tasks:` key (infra-beads-merge-driver-ressuscita-arquivadas).",
  ".beads/archive/index.yaml merge=union",
  "",
].join("\n");

const REGISTERED = '"tsx" "aiteam/scripts/beads-merge.ts" %A %O %B';

let dir: string;
const git = (...args: string[]): void => {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
};
const attrs = (content: string): void => fs.writeFileSync(path.join(dir, ".gitattributes"), content);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-io-"));
  git("init", "-q");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("readMergeDriverFacts — o que o doctor lê do repo sobre o driver antigo", () => {
  it("sem registro e sem .gitattributes → nada", () => {
    expect(readMergeDriverFacts(dir)).toEqual({ driver: null, missing: [], mapped: false, cited: false });
  });

  it("registrado, com o bloco antigo no .gitattributes e o script ausente → mapeado, citado e com o caminho que falta", () => {
    git("config", "merge.beads-yaml.driver", REGISTERED);
    attrs(DRIVER_BLOCK + "*.mjs text eol=lf\n");
    expect(readMergeDriverFacts(dir)).toEqual({
      driver: REGISTERED,
      missing: ["aiteam/scripts/beads-merge.ts"],
      mapped: true,
      cited: true,
    });
  });

  it("o script existe → não falta nada (caminho relativo resolvido na raiz do repo)", () => {
    git("config", "merge.beads-yaml.driver", REGISTERED);
    fs.mkdirSync(path.join(dir, "aiteam", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "aiteam", "scripts", "beads-merge.ts"), "");
    expect(readMergeDriverFacts(dir).missing).toEqual([]);
  });

  it("mapeamento tirado, mas o parágrafo de outra regra ainda cita beads-yaml → não mapeado, citado", () => {
    git("config", "merge.beads-yaml.driver", REGISTERED);
    attrs("*.mjs text eol=lf\n" + OTHER_RULE_PARAGRAPH);
    const f = readMergeDriverFacts(dir);
    expect(f.mapped).toBe(false);
    expect(f.cited).toBe(true);
    expect(f.driver).toBe(REGISTERED);
  });

  it("bloco inteiro fora → nem mapeado nem citado; o registro sobra, inerte", () => {
    git("config", "merge.beads-yaml.driver", REGISTERED);
    attrs("*.mjs text eol=lf\n.beads/archive/index.yaml merge=union\n");
    expect(readMergeDriverFacts(dir)).toMatchObject({ driver: REGISTERED, mapped: false, cited: false });
  });

  it("CRLF no .gitattributes não esconde o mapeamento", () => {
    attrs((DRIVER_BLOCK + "*.mjs text eol=lf\n").replace(/\n/g, "\r\n"));
    expect(readMergeDriverFacts(dir)).toMatchObject({ mapped: true, cited: true });
  });
});

// O mapa de tiers do projeto e a cópia canônica do framework: o doctor lê os
// dois com o mesmo carregador do guard (tier-rules-loader.mjs), para julgar o
// que o guard realmente enxerga.
describe("readTierRulesFacts — o mapa do projeto e a cópia canônica, como o guard os lê", () => {
  const RULES = { tier3: { label: "t3", patterns: ["\\bmeu\\b"] }, tier2: { label: "t2", patterns: [] } };
  const write = (text: string): void => {
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".claude", "tier-rules.json"), text);
  };

  it("sem o arquivo do projeto → missing; a cópia canônica lê", () => {
    const f = readTierRulesFacts(dir);
    expect(f.project).toMatchObject({ rules: null, problem: "missing" });
    expect(f.canonical.problem).toBeNull();
    expect(f.canonical.rules?.tier3.patterns.length).toBeGreaterThan(0);
  });

  it("arquivo válido → as regras do projeto", () => {
    write(JSON.stringify(RULES));
    expect(readTierRulesFacts(dir).project).toEqual({ rules: RULES, problem: null, detail: null });
  });

  it("JSON inválido e estrutura inválida → unreadable, com o motivo", () => {
    write("{ nope");
    expect(readTierRulesFacts(dir).project).toMatchObject({ rules: null, problem: "unreadable" });
    write(JSON.stringify({ tier3: { patterns: "x" } }));
    const f = readTierRulesFacts(dir);
    expect(f.project.problem).toBe("unreadable");
    expect(f.project.detail).toMatch(/tier3\.patterns/);
  });

  it("tier3.patterns sem nenhum padrão que compile → unreadable: é o que o guard enxerga (usa a canônica)", () => {
    write(JSON.stringify({ tier3: { patterns: ["(", "[a-"] }, tier2: { patterns: [] } }));
    const f = readTierRulesFacts(dir);
    expect(f.project).toMatchObject({ rules: null, problem: "unreadable" });
    expect(f.project.detail).toContain("tier3.patterns não tem nenhum padrão que compile");
  });

  it("a cópia canônica ilegível aparece como problema dela, sem derrubar a leitura do projeto", () => {
    write(JSON.stringify(RULES));
    const f = readTierRulesFacts(dir, { templatePath: path.join(dir, "nao-existe.json") });
    expect(f.canonical).toMatchObject({ rules: null, problem: "missing" });
    expect(f.project.rules).toEqual(RULES);
  });
});

// A sondagem de ReDoS dos padrões do arquivo do projeto roda num processo filho
// (scripts/regex-probe.mjs): um padrão exponencial não pode pendurar o doctor, e o
// único jeito de interromper um regex em andamento é matar o processo. Aqui o
// filho de verdade; o que trava é um filho falso que fica num laço.
describe("readTierRulesProbe — a sondagem de ReDoS dos padrões do projeto, num processo filho", () => {
  const OLD_SSH: string = JSON.parse(
    fs.readFileSync(path.resolve(repoRoot(), "aiteam", "src", "__fixtures__", "legacy-tier-patterns.json"), "utf8"),
  ).sshScriptByPath;
  const canonical = (): any => readTierRulesFile(TEMPLATE_PATH).rules;
  // O arquivo do projeto de um consumidor que sincronizou o vendor mas não o mapa: o padrão antigo no lugar do novo.
  const withOldSsh = (): any => {
    const rules = JSON.parse(JSON.stringify(canonical()));
    const swap = (list: string[]): void => {
      const i = list.findIndex((p) => p.includes("[~./]"));
      if (i >= 0) list[i] = OLD_SSH;
    };
    swap(rules.tier3.patterns);
    swap(rules.tier3.ask_patterns);
    return rules;
  };

  it("a cópia canônica não tem padrão catastrófico (e todos foram sondados)", () => {
    const p = readTierRulesProbe(canonical());
    expect(p).toMatchObject({ findings: [], hung: [], unprobed: [], error: null });
    expect(p.probed).toBeGreaterThan(15);
  });

  it("o padrão de ssh antigo é achado, com as duas listas onde ele mora", () => {
    const rules = withOldSsh();
    const p = readTierRulesProbe(rules);
    expect(p.error).toBeNull();
    expect(p.findings).toHaveLength(1);
    const f = p.findings[0]!;
    expect(f.source).toBe(OLD_SSH);
    expect(f.where).toEqual([
      `tier3.patterns[${rules.tier3.patterns.indexOf(OLD_SSH)}]`,
      `tier3.ask_patterns[${rules.tier3.ask_patterns.indexOf(OLD_SSH)}]`,
    ]);
    expect(["growth", "budget"]).toContain(f.reason);
    expect(f.size).toBeLessThan(400);
  });

  // Onda 2, item 4: o cúbico de ssh+shell tem de ser achado nas opções do doctor (antes era 512
  // bytes, onde ele leva 0,3 ms), com as duas listas onde ele mora, e sem a sondagem custar mais
  // que os poucos segundos que o teto do filho (10 s) comporta.
  it("o padrão cúbico de ssh+shell antigo é achado, com as duas listas onde ele mora", () => {
    const OLD_CUBIC: string = JSON.parse(
      fs.readFileSync(path.resolve(repoRoot(), "aiteam", "src", "__fixtures__", "legacy-tier-patterns.json"), "utf8"),
    ).sshShellScriptCubic;
    const rules = JSON.parse(JSON.stringify(canonical()));
    const swap = (list: string[]): void => {
      const i = list.findIndex((p) => p.includes("(?!\\b(?:bash|sh|zsh)\\s)"));
      expect(i).toBeGreaterThanOrEqual(0);
      list[i] = OLD_CUBIC;
    };
    swap(rules.tier3.patterns);
    swap(rules.tier3.ask_patterns);
    const started = Date.now();
    const p = readTierRulesProbe(rules);
    expect(p.error).toBeNull();
    expect(p.hung).toEqual([]);
    expect(p.findings).toHaveLength(1);
    const f = p.findings[0]!;
    expect(f.source).toBe(OLD_CUBIC);
    expect(f.where).toEqual([
      `tier3.patterns[${rules.tier3.patterns.indexOf(OLD_CUBIC)}]`,
      `tier3.ask_patterns[${rules.tier3.ask_patterns.indexOf(OLD_CUBIC)}]`,
    ]);
    expect(["growth", "budget"]).toContain(f.reason);
    expect(Date.now() - started).toBeLessThan(9_000);
  });

  it("a sondagem do mapa canônico inteiro cabe com folga no teto do filho (10 s)", () => {
    const started = Date.now();
    const p = readTierRulesProbe(canonical());
    expect(p).toMatchObject({ findings: [], hung: [], unprobed: [], error: null });
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it("um padrão do próprio projeto (tier2, deny_hints) também é sondado", () => {
    const rules = JSON.parse(JSON.stringify(canonical()));
    rules.tier2.patterns.push("^(a+)+$");
    rules.tier3.deny_hints.push({ match: "(x+x+)+y", hint: "h" });
    const p = readTierRulesProbe(rules);
    expect(p.findings.map((f) => f.source).sort()).toEqual(["(x+x+)+y", "^(a+)+$"]);
    const tier2 = p.findings.find((f) => f.source === "^(a+)+$")!;
    expect(tier2.where).toEqual([`tier2.patterns[${rules.tier2.patterns.length - 1}]`]);
  });

  it("padrão que não compila não é achado aqui (quem o nomeia é o checkTierRules)", () => {
    const p = readTierRulesProbe({ tier3: { patterns: ["(", "\\bdrop\\b"] }, tier2: { patterns: [] } });
    expect(p).toMatchObject({ findings: [], hung: [], unprobed: [], error: null, probed: 2 });
  });

  // O filho falso lê as entradas como o de verdade e fica num laço no padrão HANG.
  function fakeChild(): string {
    const file = path.join(dir, "fake-probe.mjs");
    fs.writeFileSync(
      file,
      [
        'import { readFileSync, writeSync } from "node:fs";',
        'const { entries } = JSON.parse(readFileSync(0, "utf8"));',
        'const emit = (o) => writeSync(1, JSON.stringify(o) + "\\n");',
        "entries.forEach((e, i) => {",
        "  emit({ start: i });",
        '  if (e.source === "HANG") for (;;) {}',
        '  emit({ done: i, result: { ok: true, worstMs: 0, worstSize: 0, worstLabel: "" } });',
        "});",
        "",
      ].join("\n"),
    );
    return file;
  }

  it("o filho que trava é morto no timeout, o padrão é nomeado e a sondagem segue com os outros", () => {
    const rules = { tier3: { patterns: ["A", "HANG", "B"] }, tier2: { patterns: ["C"] } };
    const started = Date.now();
    const p = readTierRulesProbe(rules, { script: fakeChild(), timeoutMs: 1200 });
    expect(p.hung).toEqual([{ source: "HANG", where: ["tier3.patterns[1]"] }]);
    expect(p.probed).toBe(3); // A, B e C; o HANG não conta
    expect(p.findings).toEqual([]);
    expect(p.unprobed).toEqual([]);
    expect(p.error).toBeNull();
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("o orçamento total vale: sem tempo, o que sobrou fica em unprobed, e o doctor não pendura", () => {
    const rules = { tier3: { patterns: ["A", "B"] }, tier2: { patterns: [] } };
    const p = readTierRulesProbe(rules, { script: fakeChild(), totalMs: 0 });
    expect(p.unprobed.map((e) => e.source)).toEqual(["A", "B"]);
    expect(p.probed).toBe(0);
  });

  it("o filho que não sobe vira erro com o motivo, sem lançar", () => {
    const p = readTierRulesProbe({ tier3: { patterns: ["A"] }, tier2: { patterns: [] } }, { script: path.join(dir, "nao-existe.mjs") });
    expect(p.error).toMatch(/status 1|Cannot find module|nao-existe/);
    expect(p.findings).toEqual([]);
  });
});

// A checagem dinâmica do doctor roda o hook de verdade com um payload por ferramenta.
// O hook despacha pelo nome da ferramenta, então é a ferramenta que o payload carrega
// que decide se um despacho esquecido do PowerShell aparece.
describe("readTierGuardDecision — o que o hook decide, ferramenta por ferramenta", () => {
  const HOOK = path.resolve(repoRoot(), "aiteam", "hooks", "tier-guard.mjs");
  // Uma raiz com o SPEC.md de gate fechado e sem o .claude/tier-rules.json: o hook usa a cópia canônica.
  beforeEach(() => {
    fs.writeFileSync(path.join(dir, "SPEC.md"), "---\ntier_defaults:\n  allow_tier3: false\n---\n\n# fixture\n");
  });

  it.each(["Bash", "PowerShell"])("%s: o destrutivo é deny e o deploy é ask", (tool) => {
    expect(readTierGuardDecision(dir, { hook: HOOK, tool, command: "prisma migrate reset" })).toBe("deny");
    expect(readTierGuardDecision(dir, { hook: HOOK, tool, command: "npx prisma migrate deploy" })).toBe("ask");
    expect(readTierGuardDecision(dir, { hook: HOOK, tool, command: "ls -la" })).toBe("allow");
  });

  // O defeito que a amostra só com o Bash escondia: um hook que só despacha o Bash.
  it("um hook que só despacha o Bash: o Bash é deny e o PowerShell passa — a amostra enxerga a diferença", () => {
    const stale = path.join(dir, "stale-hook.mjs");
    fs.writeFileSync(
      stale,
      [
        'import { readFileSync } from "node:fs";',
        'const p = JSON.parse(readFileSync(0, "utf8"));',
        'if (p.tool_name === "Bash") process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny" } }));',
        'else process.stdout.write("{}");',
        "",
      ].join("\n"),
    );
    expect(readTierGuardDecision(dir, { hook: stale, tool: "Bash", command: "x" })).toBe("deny");
    expect(readTierGuardDecision(dir, { hook: stale, tool: "PowerShell", command: "x" })).toBe("allow");
  });

  it("hook que não existe, não responde JSON ou trava → null, sem lançar", () => {
    expect(readTierGuardDecision(dir, { hook: path.join(dir, "nao-existe.mjs"), tool: "Bash", command: "x" })).toBeNull();
    const garbage = path.join(dir, "garbage-hook.mjs");
    fs.writeFileSync(garbage, 'process.stdout.write("não é json");\n');
    expect(readTierGuardDecision(dir, { hook: garbage, tool: "Bash", command: "x" })).toBeNull();
    const hang = path.join(dir, "hang-hook.mjs");
    fs.writeFileSync(hang, "for (;;) {}\n");
    expect(readTierGuardDecision(dir, { hook: hang, tool: "Bash", command: "x", timeoutMs: 800 })).toBeNull();
  });
});

// O doctor.mjs executa ao ser importado: não dá para chamá-lo sobre um repo de
// teste. O que se confere dele é que a cola continua ligada à função testada
// acima — sem isso, um refactor deixaria o `mapped` sempre falso e nada acusaria.
describe("doctor.mjs — usa a leitura testada para o resíduo do driver", () => {
  const src = fs.readFileSync(path.resolve(repoRoot(), "aiteam", "scripts", "doctor.mjs"), "utf8");

  it("lê os fatos com readMergeDriverFacts(root) e os passa ao check", () => {
    expect(src).toMatch(/readMergeDriverFacts\(root\)/);
    expect(src).toMatch(/checkMergeDriverResidue\(\{[^)]*\.\.\.facts/);
  });
});

describe("doctor.mjs — usa a leitura testada do mapa de tiers", () => {
  const src = fs.readFileSync(path.resolve(repoRoot(), "aiteam", "scripts", "doctor.mjs"), "utf8");

  it("lê os fatos com readTierRulesFacts(root) e os passa aos dois checks", () => {
    expect(src).toMatch(/readTierRulesFacts\(root\)/);
    expect(src).toMatch(/checkTierRulesFile\(tierFacts\)/);
    expect(src).toMatch(/checkTierRulesCoverage\(tierFacts\)/);
  });

  it("sonda os padrões do arquivo do projeto com readTierRulesProbe e passa o resultado ao check", () => {
    expect(src).toMatch(/readTierRulesProbe\(tierFacts\.project\.rules\)/);
    expect(src).toMatch(/checkTierRulesRegexSafety\(\{[^}]*probe/);
  });
});

// F13: a amostra viva do gate-edit-guard. O hook de verdade, num payload de Write no tier-rules.json.
describe("readGateEditDecision — o que o gate-edit-guard decide para uma edição do mapa de tiers", () => {
  const HOOK = path.resolve(repoRoot(), "aiteam", "hooks", "gate-edit-guard.mjs");

  it("o hook de verdade responde ask", () => {
    expect(readGateEditDecision(dir, { hook: HOOK })).toBe("ask");
  });

  it("não escreve nada: o arquivo do projeto fica como está", () => {
    fs.mkdirSync(path.join(dir, ".claude"));
    fs.writeFileSync(path.join(dir, ".claude", "tier-rules.json"), '{"keep":"me"}');
    readGateEditDecision(dir, { hook: HOOK });
    expect(fs.readFileSync(path.join(dir, ".claude", "tier-rules.json"), "utf8")).toBe('{"keep":"me"}');
  });

  it("hook que não existe, não responde JSON ou trava → null, sem lançar", () => {
    expect(readGateEditDecision(dir, { hook: path.join(dir, "nao-existe.mjs") })).toBeNull();
    const garbage = path.join(dir, "garbage-hook.mjs");
    fs.writeFileSync(garbage, 'process.stdout.write("não é json");\n');
    expect(readGateEditDecision(dir, { hook: garbage })).toBeNull();
    const hang = path.join(dir, "hang-hook.mjs");
    fs.writeFileSync(hang, "for (;;) {}\n");
    expect(readGateEditDecision(dir, { hook: hang, timeoutMs: 800 })).toBeNull();
  });

  it("um hook velho que não decide nada ({}) → allow", () => {
    const stale = path.join(dir, "stale-hook.mjs");
    fs.writeFileSync(stale, 'process.stdout.write("{}");\n');
    expect(readGateEditDecision(dir, { hook: stale })).toBe("allow");
  });
});

describe("doctor.mjs — liga o gate-edit-guard ao doctor (settings e amostra viva)", () => {
  const src = fs.readFileSync(path.resolve(repoRoot(), "aiteam", "scripts", "doctor.mjs"), "utf8");

  it("confere a fiação nos settings e a amostra viva do hook", () => {
    expect(src).toMatch(/checkGateEditGuardSettings\(settings\)/);
    expect(src).toMatch(/readGateEditDecision\(root, \{ hook/);
    expect(src).toMatch(/checkGateEditSample\(\{ decision/);
  });
});

describe("doctor.mjs — as amostras dinâmicas do hook rodam em cada ferramenta de comando", () => {
  const src = fs.readFileSync(path.resolve(repoRoot(), "aiteam", "scripts", "doctor.mjs"), "utf8");

  it("usa readTierGuardDecision em TIER_GUARD_SAMPLE_TOOLS e passa as decisões ao checkTierGuardSample, deny e ask", () => {
    expect(src).toMatch(/TIER_GUARD_SAMPLE_TOOLS/);
    expect(src).toMatch(/readTierGuardDecision\(root, \{ hook, tool, command \}\)/);
    expect(src).toMatch(/checkTierGuardSample\(\{ expected: "deny"/);
    expect(src).toMatch(/checkTierGuardSample\(\{ expected: "ask"/);
  });

  it("não sobrou a amostra antiga, só com o Bash, no próprio doctor.mjs", () => {
    expect(src).not.toMatch(/tool_name: "Bash"/);
  });
});

// O que o checkUpstreamFlag lê do repo: os dois settings do .claude e o origin.
describe("readUpstreamFacts — os settings do .claude e o origin", () => {
  const settings = (name: string, content: string): void => {
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".claude", name), content);
  };

  it("sem nada → tudo nulo", () => {
    expect(readUpstreamFacts(dir)).toEqual({ settings: null, local: null, origin: null });
  });

  it("lê os dois settings e a URL do origin", () => {
    settings("settings.json", JSON.stringify({ env: { AITEAM_UPSTREAM: "1" } }));
    settings("settings.local.json", JSON.stringify({ permissions: {} }));
    git("remote", "add", "origin", "https://github.com/acme/mesa-crm.git");
    expect(readUpstreamFacts(dir)).toEqual({
      settings: { env: { AITEAM_UPSTREAM: "1" } },
      local: { permissions: {} },
      origin: "https://github.com/acme/mesa-crm.git",
    });
  });

  it("settings ilegível ou que não é objeto → null, sem lançar", () => {
    settings("settings.json", "{ não é json");
    settings("settings.local.json", "42");
    expect(readUpstreamFacts(dir)).toMatchObject({ settings: null, local: null });
  });

  it("de ponta a ponta com o check: o template copiado para um projeto com outro origin → WARN", () => {
    settings("settings.json", JSON.stringify({ env: { AITEAM_UPSTREAM: "1" } }));
    git("remote", "add", "origin", "https://github.com/acme/novo-projeto.git");
    const r = checkUpstreamFlag(readUpstreamFacts(dir))!;
    expect(r.warn).toBe(true);
    git("remote", "set-url", "origin", "https://github.com/thiagoriosbraz/rb-ai-team.git");
    const ok = checkUpstreamFlag(readUpstreamFacts(dir))!;
    expect(ok.pass).toBe(true);
    expect(ok.warn).toBeUndefined();
  });
});
