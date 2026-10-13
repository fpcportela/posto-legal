import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkAllowTier3Reading,
  checkGateEditGuardSettings,
  checkGateEditSample,
  checkUpstreamFlag,
  checkSettings,
  checkInfraKbGuardSettings,
  checkMcp,
  checkCiContract,
  checkDeployContract,
  checkTierRules,
  checkTierRulesFile,
  checkTierRulesCoverage,
  checkTierRulesRegexSafety,
  checkTierGuardSample,
  TIER_GUARD_SAMPLE_TOOLS,
  tierRulesPatternEntries,
  LEGACY_PATTERN_REPLACEMENTS,
  checkHooksPath,
  checkBeadsValidation,
  checkInfraKb,
  summarize,
} from "./doctor-core.mjs";
import { probePattern } from "./regex-probe.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
import { FRAMEWORK_SETTINGS, mergeSettings } from "./install-core.mjs";
import {
  checkBeadsModel,
  checkMergeDriverResidue,
  checkBeadsGuardSettings,
  driverPaths,
  gitattributesMapsDriver,
  gitattributesCitesDriver,
} from "./doctor-core.mjs";

// Issue #12: o check exigia `matcher === "Bash"` — e um consumidor com o guard
// só no Bash passava verde enquanto a ferramenta PowerShell (e o Monitor)
// rodava deploy sem ASK e destrutivo sem deny. Agora o tier-guard tem de cobrir
// toda ferramenta que executa comando; o matcher é avaliado como o Claude Code
// o avalia (lista exata separada por `|`/`,`, curinga, ou regex sem âncora).
describe("checkSettings — tier-guard cobre toda ferramenta que executa comando", () => {
  const GUARD = "node aiteam/hooks/tier-guard.mjs";
  const entry = (matcher: string | undefined, command = GUARD) => ({
    ...(matcher === undefined ? {} : { matcher }),
    hooks: [{ type: "command", command }],
  });

  it("passes with the entries the installer writes (Bash + PowerShell|Monitor|terminal)", () => {
    const settings = {
      hooks: { PreToolUse: [entry("Bash"), entry("PowerShell|Monitor|mcp__terminal__run_in_terminal")] },
    };
    const r = checkSettings(settings);
    expect(r.pass).toBe(true);
    expect(r.detail).toMatch(/Bash, PowerShell, Monitor/);
  });

  it("fails a consumer wired before #12 (Bash only), naming the uncovered tools and the fix", () => {
    const r = checkSettings({ hooks: { PreToolUse: [entry("Bash")] } });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("PowerShell, Monitor");
    expect(r.detail).not.toContain("Bash");
    expect(r.detail).toContain("npm --prefix aiteam run install:framework");
  });

  it("accepts a single entry whose matcher lists every tool", () => {
    expect(checkSettings({ hooks: { PreToolUse: [entry("Bash|PowerShell|Monitor")] } }).pass).toBe(true);
    expect(checkSettings({ hooks: { PreToolUse: [entry("Bash, PowerShell, Monitor")] } }).pass).toBe(true);
  });

  it('treats "*", "" and a missing matcher as covering every tool', () => {
    for (const m of ["*", "", undefined]) {
      expect(checkSettings({ hooks: { PreToolUse: [entry(m)] } }).pass, String(m)).toBe(true);
    }
  });

  it("evaluates a matcher with regex characters as an unanchored regex", () => {
    expect(checkSettings({ hooks: { PreToolUse: [entry("^(Bash|PowerShell|Monitor)$")] } }).pass).toBe(true);
    expect(checkSettings({ hooks: { PreToolUse: [entry("Bash"), entry("Power.*"), entry("Monitor")] } }).pass).toBe(true);
  });

  it("a plain-name matcher is an exact name, not a prefix", () => {
    const r = checkSettings({ hooks: { PreToolUse: [entry("Bash|Power|Monitor")] } });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("PowerShell");
  });

  it("only counts entries that actually run the tier-guard", () => {
    const settings = {
      hooks: { PreToolUse: [entry("Bash"), entry("PowerShell|Monitor", "node aiteam/hooks/infra-kb-guard.mjs")] },
    };
    expect(checkSettings(settings).pass).toBe(false);
  });

  it("fails when no PreToolUse hook references the tier-guard", () => {
    expect(checkSettings({ hooks: { PreToolUse: [entry("Bash", "node other.mjs")] } }).pass).toBe(false);
  });

  it("fails when settings has no hooks at all, naming every tool", () => {
    const r = checkSettings({});
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("Bash, PowerShell, Monitor");
  });

  it("an invalid regex matcher covers nothing instead of throwing", () => {
    expect(checkSettings({ hooks: { PreToolUse: [entry("Bash|PowerShell|Monitor(")] } }).pass).toBe(false);
  });

  it("still passes when the path uses backslashes (Windows)", () => {
    const settings = {
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ command: "node aiteam\\hooks\\tier-guard.mjs" }] },
          { matcher: "PowerShell|Monitor", hooks: [{ command: "node aiteam\\hooks\\tier-guard.mjs" }] },
        ],
      },
    };
    expect(checkSettings(settings).pass).toBe(true);
  });

  // Escritor e checador não podem discordar: o que o installer funde num
  // consumidor novo tem de passar no doctor.
  it("passes on what install writes into a fresh consumer", () => {
    expect(checkSettings(mergeSettings({}, FRAMEWORK_SETTINGS)).pass).toBe(true);
  });
});

// Finding 1 do review final: FRAMEWORK_SETTINGS (install-core.mjs) ganhou a
// entrada Write|Edit -> infra-kb-guard.mjs, mas nada acusava um CONSUMIDOR
// cujo .claude/settings.json ficou pra trás (instalação velha, edição manual)
// — a mesma lacuna que checkSettings já fecha pro tier-guard, agora espelhada
// pro guard de edição.
describe("checkInfraKbGuardSettings — PreToolUse infra-kb-guard wiring", () => {
  it("passes when a Write|Edit PreToolUse hook points at aiteam/hooks/infra-kb-guard.mjs", () => {
    const settings = {
      hooks: {
        PreToolUse: [
          { matcher: "Write|Edit", hooks: [{ type: "command", command: "node aiteam/hooks/infra-kb-guard.mjs" }] },
        ],
      },
    };
    expect(checkInfraKbGuardSettings(settings).pass).toBe(true);
  });

  it("fails when no PreToolUse hook references the infra-kb-guard", () => {
    const settings = {
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node aiteam/hooks/tier-guard.mjs" }] }] },
    };
    expect(checkInfraKbGuardSettings(settings).pass).toBe(false);
  });

  it("fails when settings has no hooks at all", () => {
    expect(checkInfraKbGuardSettings({}).pass).toBe(false);
  });

  it("still passes when the path uses backslashes (Windows)", () => {
    const settings = {
      hooks: { PreToolUse: [{ matcher: "Write|Edit", hooks: [{ command: "node aiteam\\hooks\\infra-kb-guard.mjs" }] }] },
    };
    expect(checkInfraKbGuardSettings(settings).pass).toBe(true);
  });

  it("does not confuse the tier-guard's Bash matcher for the infra-kb-guard's Write|Edit one", () => {
    const settings = {
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ command: "node aiteam/hooks/infra-kb-guard.mjs" }] }],
      },
    };
    expect(checkInfraKbGuardSettings(settings).pass).toBe(false);
  });
});

describe("checkMcp — server entry points into aiteam/", () => {
  it("passes when an mcpServers entry runs aiteam/mcp/server.ts", () => {
    const mcp = { mcpServers: { "rb-ai-team-tools": { command: "npx", args: ["tsx", "aiteam/mcp/server.ts"] } } };
    expect(checkMcp(mcp).pass).toBe(true);
  });

  it("fails when no server references aiteam/mcp/server.ts", () => {
    const mcp = { mcpServers: { other: { command: "npx", args: ["tsx", "other/server.ts"] } } };
    expect(checkMcp(mcp).pass).toBe(false);
  });

  it("fails on empty config", () => {
    expect(checkMcp({}).pass).toBe(false);
  });
});

// rb-ai-team#31: o doctor confere o mesmo contrato que o ci-contract.test.ts,
// pelo mesmo núcleo (ci-contract-core.mjs). O doctor roda também num checkout
// sem node_modules: aí o bloco ci: ainda é julgado (o leitor não usa pacote) e
// só a conferência dos workflows, que precisa do js-yaml, degrada para WARN.
describe("checkCiContract — o CI de PR roda o que o SPEC.md declara em ci:", () => {
  const spec = (fm: string) => `---\n${fm}\n---\n`;
  const noScripts = () => null;
  const appCi = {
    file: "ci.yml",
    doc: { on: { pull_request: null }, jobs: { app: { steps: [{ run: "npm ci" }, { run: "npm test" }] } } },
  };
  const frameworkCi = {
    file: "ci.yml",
    doc: {
      on: "pull_request",
      defaults: { run: { "working-directory": "aiteam" } },
      jobs: { validate: { steps: [{ run: "npm test" }] } },
    },
  };

  it("fails when SPEC.md declares no ci: block, saying what to declare", () => {
    const r = checkCiContract({ specText: spec("budget_usd: 2.00"), workflows: [appCi], readScripts: noScripts });
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/ci:/);
    expect(r.detail).toMatch(/test: none/);
  });

  it("passes and says where each declared command runs", () => {
    const r = checkCiContract({ specText: spec("ci:\n  test: npm test"), workflows: [appCi], readScripts: noScripts });
    expect(r.pass).toBe(true);
    expect(r.warn).toBeFalsy();
    expect(r.detail).toMatch(/npm test/);
    expect(r.detail).toMatch(/ci\.yml › app/);
  });

  it("fails with the core's message when the command only runs in aiteam/", () => {
    const r = checkCiContract({ specText: spec("ci:\n  test: npm test"), workflows: [frameworkCi], readScripts: noScripts });
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/framework vendorizado/);
  });

  it("the opt-out passes as WARN, with the reason visible", () => {
    const r = checkCiContract({
      specText: spec('ci:\n  test: none\n  reason: "site estático, sem código testável"'),
      workflows: [appCi],
      readScripts: noScripts,
    });
    expect(r).toMatchObject({ pass: true, warn: true });
    expect(r.detail).toMatch(/site estático, sem código testável/);
  });

  it("without a YAML parser it still judges the block, and degrades to WARN naming why", () => {
    const r = checkCiContract({
      specText: spec("ci:\n  test: npm test"),
      workflows: null,
      readScripts: noScripts,
      workflowsUnavailable: "js-yaml indisponível",
    });
    expect(r).toMatchObject({ pass: true, warn: true });
    expect(r.detail).toMatch(/js-yaml indisponível/);

    const noBlock = checkCiContract({
      specText: spec("budget_usd: 2.00"),
      workflows: null,
      readScripts: noScripts,
      workflowsUnavailable: "js-yaml indisponível",
    });
    expect(noBlock.pass).toBe(false);
  });

  it("fails when SPEC.md is missing", () => {
    expect(checkCiContract({ specText: null, workflows: [], readScripts: noScripts }).pass).toBe(false);
  });

  // PO decision in the #31 review: doctor and contract test give the same
  // verdict on a paths filter — positive paths fails, paths-ignore warns.
  it("a positive paths filter on the only matching workflow fails; paths-ignore warns", () => {
    const filtered = (filter: string) => ({
      file: "ci.yml",
      doc: { on: { pull_request: { [filter]: ["src/**"] } }, jobs: { app: { steps: [{ run: "npm test" }] } } },
    });
    const paths = checkCiContract({ specText: spec("ci:\n  test: npm test"), workflows: [filtered("paths")], readScripts: noScripts });
    expect(paths.pass).toBe(false);
    expect(paths.detail).toMatch(/paths: \[src\/\*\*\]/);
    const ignore = checkCiContract({ specText: spec("ci:\n  test: npm test"), workflows: [filtered("paths-ignore")], readScripts: noScripts });
    expect(ignore).toMatchObject({ pass: true, warn: true });
    expect(ignore.detail).toMatch(/paths-ignore: \[src\/\*\*\]/);
  });

  // Security review of #31: a repo cloned from the framework as a template
  // inherits workdir: aiteam and passed while testing only the framework.
  it("fails when ci.workdir is inside aiteam/ and the root has an app manifest", () => {
    const r = checkCiContract({
      specText: spec("ci:\n  workdir: aiteam\n  test: npm test"),
      workflows: [frameworkCi],
      readScripts: noScripts,
      rootManifests: ["package.json"],
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/a raiz tem uma app \(package\.json\)/);
  });
});

// rb-ai-team#32: o doctor confere o mesmo contrato de deploy que o
// deploy-contract.test.ts, pelo mesmo núcleo (deploy-contract-core.mjs) — é a
// resposta ao passo 1 do Release Loop: a pipeline aceita a ref e o health
// check confere a versão? Sem node_modules o bloco deploy: ainda é julgado e
// só a conferência do workflow degrada para WARN.
describe("checkDeployContract — o workflow de deploy: aceita a ref, confere a versão e cria a tag", () => {
  const spec = (fm: string) => `---\n${fm}\n---\n`;
  const declared = spec("deploy:\n  workflow: deploy.yml\n  version_url: https://app.example.com/api/version");
  const noFiles = () => null;
  const step = (s: Record<string, unknown>) => s;
  const deployWf = (steps: Record<string, unknown>[], top: Record<string, unknown> = { permissions: { contents: "write" } }) => ({
    file: "deploy.yml",
    doc: { on: { workflow_dispatch: { inputs: { ref: { required: true } } } }, ...top, jobs: { deploy: { steps } } },
  });
  const complete = deployWf([
    step({ uses: "actions/checkout@v4", with: { ref: "${{ inputs.ref }}" } }),
    step({ name: "Resolve", id: "version", run: 'echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"' }),
    step({ name: "Deploy", env: { SHA: "${{ steps.version.outputs.sha }}" }, run: 'ssh h "git checkout --detach $SHA && docker compose up -d"' }),
    step({
      name: "Health",
      env: { VERSION_URL: "https://app.example.com/api/version", SHA: "${{ steps.version.outputs.sha }}" },
      run: 'curl -fsS "$VERSION_URL" | grep -q "$SHA"',
    }),
    step({ name: "Tag", run: 'TAG="deploy/$(date +%s)"\ngit tag -a "$TAG" -m x\ngit push origin "$TAG"' }),
  ]);

  // Revisão da #32: o nome prometia "checks the served version"; o núcleo lê
  // o YAML. O nome diz que a checagem é estática.
  it("the row name says the check is static, not that the deploy works", () => {
    const r = checkDeployContract({ specText: declared, workflows: [complete], readFile: noFiles });
    expect(r.name).toMatch(/static/);
    expect(r.name).not.toMatch(/checks the served version/);
  });

  it("passes and says where it found the ref, the version check and the tag", () => {
    const r = checkDeployContract({ specText: declared, workflows: [complete], readFile: noFiles });
    expect(r.pass).toBe(true);
    expect(r.warn).toBeFalsy();
    expect(r.detail).toMatch(/ref → deploy\.yml › deploy › Deploy \(env SHA\)/);
    expect(r.detail).toMatch(/version → .*Health/);
    expect(r.detail).toMatch(/tag → .*Tag/);
  });

  it("fails when SPEC.md declares no deploy: block, saying what to declare and the opt-out", () => {
    const r = checkDeployContract({ specText: spec("budget_usd: 2.00"), workflows: [complete], readFile: noFiles });
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/deploy:/);
    expect(r.detail).toMatch(/workflow: none/);
  });

  it("fails with every missing piece, each pointing at the template", () => {
    const pull = deployWf([step({ name: "Deploy", run: "ssh h 'cd /opt/app && git pull'" })]);
    const r = checkDeployContract({ specText: declared, workflows: [pull], readFile: noFiles });
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/input ref/);
    expect(r.detail).toMatch(/version_url/);
    expect(r.detail).toMatch(/tag deploy\//);
    expect(r.detail).toMatch(/git pull/);
    const parts = r.detail?.split(" | ") ?? [];
    expect(parts.length).toBe(4);
    for (const p of parts) expect(p).toMatch(/deploy\.yml\.example/);
  });

  it("fails when the tag job cannot push it (contents: read), and warns when nothing declares permissions", () => {
    const steps = (complete.doc.jobs.deploy as { steps: Record<string, unknown>[] }).steps;
    const read = checkDeployContract({
      specText: declared,
      workflows: [deployWf(steps, { permissions: { contents: "read" } })],
      readFile: noFiles,
    });
    expect(read.pass).toBe(false);
    expect(read.detail).toMatch(/contents: write/);
    const none = checkDeployContract({ specText: declared, workflows: [deployWf(steps, {})], readFile: noFiles });
    expect(none).toMatchObject({ pass: true, warn: true });
    expect(none.detail).toMatch(/contents: write/);
  });

  it("the opt-out passes as WARN, with the reason visible", () => {
    const r = checkDeployContract({
      specText: spec('deploy:\n  workflow: none\n  reason: "distribuído por sync"'),
      workflows: [],
      readFile: noFiles,
    });
    expect(r).toMatchObject({ pass: true, warn: true });
    expect(r.detail).toMatch(/distribuído por sync/);
  });

  it("without a YAML parser it still judges the block, and degrades to WARN naming why", () => {
    const r = checkDeployContract({ specText: declared, workflows: null, readFile: noFiles, workflowsUnavailable: "js-yaml indisponível" });
    expect(r).toMatchObject({ pass: true, warn: true });
    expect(r.detail).toMatch(/js-yaml indisponível/);
    const noBlock = checkDeployContract({
      specText: spec("budget_usd: 2.00"),
      workflows: null,
      readFile: noFiles,
      workflowsUnavailable: "js-yaml indisponível",
    });
    expect(noBlock.pass).toBe(false);
  });

  it("fails when SPEC.md is missing", () => {
    expect(checkDeployContract({ specText: null, workflows: [], readFile: noFiles }).pass).toBe(false);
  });
});

describe("checkTierRules — canonical map is well-formed", () => {
  it("passes when tier3 and tier2 bands carry patterns", () => {
    const rules = { tier3: { patterns: ["a"] }, tier2: { patterns: ["b"] } };
    expect(checkTierRules(rules).pass).toBe(true);
  });

  it("fails when tier3 patterns are missing/empty", () => {
    expect(checkTierRules({ tier3: { patterns: [] }, tier2: { patterns: ["b"] } }).pass).toBe(false);
  });

  // Revisão de segurança da #12: o guard passou a pular o padrão que não
  // compila (antes ele derrubava o hook e o comando rodava). Pular em silêncio
  // esconderia o furo — a regra que o padrão deveria aplicar não protege nada.
  // O doctor compila tudo o que o guard compila e nomeia cada inválido.
  it("fails naming every pattern that does not compile, in each list and in deny_hints", () => {
    const rules = {
      tier3: {
        patterns: ["unbalanced(paren", "\\bdrop\\s+table\\b"],
        ask_patterns: ["[unclosed"],
        deny_hints: [
          { match: "(x", hint: "h" },
          { match: "\\bssh\\b", hint: "fine" },
        ],
      },
      tier2: { patterns: ["*nothing to repeat", "\\bgit\\b"] },
    };
    const r = checkTierRules(rules);
    expect(r.pass).toBe(false);
    for (const where of [
      'tier3.patterns[0] "unbalanced(paren"',
      'tier3.ask_patterns[0] "[unclosed"',
      'tier2.patterns[0] "*nothing to repeat"',
      'tier3.deny_hints[0].match "(x"',
    ]) {
      expect(r.detail).toContain(where);
    }
    expect(r.detail).not.toContain("tier3.patterns[1]");
    expect(r.detail).not.toContain("tier3.deny_hints[1]");
  });

  // QA A2: um padrão que compila e lança no primeiro uso (V8 compila devagar: "too large", "stack overflow") o guard
  // descarta; o doctor tem de dizer o mesmo, e nunca lançar por causa dele.
  it("um padrão que compila e lança no primeiro uso é nomeado como descartado, sem lançar", () => {
    const TOO_LARGE = "a?".repeat(200_000);
    const rules = {
      tier3: { patterns: [TOO_LARGE, "\\bdrop\\s+table\\b"], ask_patterns: [TOO_LARGE], deny_hints: [{ match: TOO_LARGE, hint: "h" }] },
      tier2: { patterns: [TOO_LARGE, "\\bgit\\b"] },
    };
    let r: ReturnType<typeof checkTierRules> | undefined;
    expect(() => {
      r = checkTierRules(rules);
    }).not.toThrow();
    expect(r!.pass).toBe(false);
    for (const where of ["tier3.patterns[0]", "tier3.ask_patterns[0]", "tier2.patterns[0]", "tier3.deny_hints[0].match"]) {
      expect(r!.detail, where).toContain(where);
    }
    expect(r!.detail).not.toContain("tier3.patterns[1]");
  });

  // `""` compila, então o doctor o deixava passar — e ele casa com TODO comando: em
  // tier3.patterns negaria até o `ls`, em ask_patterns faria todo Tier 3 virar ask.
  // O guard o pula (tier-core), logo a regra que ele deveria ser não protege nada.
  it.each([[""], ["   "], ["\t"]])("fails on a %j pattern in any list: it matches every command, so the guard skips it", (empty) => {
    for (const [where, rules] of [
      ["tier3.patterns[1]", { tier3: { patterns: ["\\bdrop\\b", empty] }, tier2: { patterns: ["b"] } }],
      ["tier3.ask_patterns[0]", { tier3: { patterns: ["\\bdrop\\b"], ask_patterns: [empty] }, tier2: { patterns: ["b"] } }],
      ["tier2.patterns[1]", { tier3: { patterns: ["\\bdrop\\b"] }, tier2: { patterns: ["b", empty] } }],
    ] as const) {
      const r = checkTierRules(rules);
      expect(r.pass, where).toBe(false);
      expect(r.detail, where).toContain(`${where} ${JSON.stringify(empty)}`);
      expect(r.detail, where).toMatch(/empty or whitespace-only: it matches every command/);
    }
  });

  // Onda 2, item 6 (A3): o `(?:)`, `^`, `.*`, `x*`, `$`, `(?=)` e `\s*` casam a string vazia, e `.`,
  // `[\s\S]` e `\w|\W` casam todo comando sem casar "". O guard já não promove a ask por eles
  // (tier-core, tier3Verdict), mas o arquivo está errado e o doctor tem de dizer.
  it.each([["(?:)"], ["^"], [".*"], ["x*"], ["$"], ["(?=)"], ["\\s*"], ["."], ["[\\s\\S]"], ["\\w|\\W"], ["^.*$"]])(
    "fails on %j in any list: it matches every command",
    (junk) => {
      for (const [where, rules] of [
        ["tier3.patterns[1]", { tier3: { patterns: ["\\bdrop\\b", junk] }, tier2: { patterns: ["b"] } }],
        ["tier3.ask_patterns[1]", { tier3: { patterns: ["\\bdrop\\b", junk], ask_patterns: ["\\bdrop\\b", junk] }, tier2: { patterns: ["b"] } }],
        ["tier2.patterns[1]", { tier3: { patterns: ["\\bdrop\\b"] }, tier2: { patterns: ["b", junk] } }],
      ] as const) {
        const r = checkTierRules(rules);
        expect(r.pass, `${where} ${junk}`).toBe(false);
        expect(r.detail, `${where} ${junk}`).toContain(`${where} ${JSON.stringify(junk)}`);
        expect(r.detail, `${where} ${junk}`).toMatch(/matches every command/);
      }
    }
  );

  it("um padrão de verdade não é acusado de casar tudo", () => {
    const r = checkTierRules({
      tier3: { patterns: ["\\bdrop\\s+(table|database)\\b", "\\bssh\\b.*\\bdocker\\b"], ask_patterns: ["\\bssh\\b.*\\bdocker\\b"] },
      tier2: { patterns: ["\\bgit\\s+commit\\b", "\\bvercel\\b"] },
    });
    expect(r.pass).toBe(true);
  });

  it("o template canônico não casa tudo", () => {
    const template = JSON.parse(readFileSync(path.join(HERE, "..", "templates", "tier-rules.json"), "utf8"));
    expect(checkTierRules(template)).toMatchObject({ pass: true });
  });

  it("an empty pattern next to good ones names only the empty one", () => {
    const r = checkTierRules({ tier3: { patterns: ["\\bdrop\\b", ""], ask_patterns: ["\\bdrop\\b"] }, tier2: { patterns: ["b"] } });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('tier3.patterns[1] ""');
    expect(r.detail).not.toContain("tier3.patterns[0]");
    expect(r.detail).not.toContain("tier3.ask_patterns[0]");
  });

  it("flags entries the guard ignores without compiling: non-text patterns, unusable deny_hints", () => {
    const r = checkTierRules({
      tier3: {
        patterns: ["\\bdrop\\b", 42],
        deny_hints: [{ match: "", hint: "empty match" }, { match: "reboot" }, null],
      },
      tier2: { patterns: ["b"] },
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("tier3.patterns[1] 42");
    expect(r.detail).toContain("tier3.deny_hints[0]");
    expect(r.detail).toContain("tier3.deny_hints[1]");
    expect(r.detail).toContain("tier3.deny_hints[2]");
  });

  it("flags ask_patterns or deny_hints that are not lists", () => {
    const r = checkTierRules({ tier3: { patterns: ["a"], ask_patterns: "a", deny_hints: {} }, tier2: { patterns: ["b"] } });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("tier3.ask_patterns");
    expect(r.detail).toContain("tier3.deny_hints");
  });

  // ask_patterns é o subconjunto de deploy que pede aprovação num clique; o guard só o
  // consulta DEPOIS de um padrão de tier3.patterns casar (tier3Verdict). Um ask_pattern
  // fora de patterns, portanto, nunca dispara: o comando que ele deveria perguntar não
  // é Tier 3 e passa sem pergunta nenhuma. O template documenta o subconjunto como
  // invariante e só um teste o conferia; o arquivo do consumidor não era conferido.
  describe("ask_patterns ⊆ tier3.patterns", () => {
    const base = (ask: unknown, patterns: unknown[] = ["\\bdrop\\b", "vercel\\s+.*--prod\\b"]) => ({
      tier3: { patterns, ask_patterns: ask },
      tier2: { patterns: ["\\bgit\\b"] },
    });

    it("an ask_pattern that is not in tier3.patterns fails, naming it and saying the prompt never fires", () => {
      const r = checkTierRules(base(["vercel\\s+.*--prod\\b", "\\bgh\\s+workflow\\s+run\\b"]));
      expect(r.pass).toBe(false);
      expect(r.detail).toContain(`tier3.ask_patterns[1] ${JSON.stringify("\\bgh\\s+workflow\\s+run\\b")} is not in tier3.patterns`);
      expect(r.detail).toMatch(/no approval prompt ever fires/);
      expect(r.detail).not.toContain("tier3.ask_patterns[0]");
    });

    it("the comparison is by exact string: a one-letter difference is outside the subset", () => {
      const r = checkTierRules(base(["vercel\\s+.*--prod"]));
      expect(r.pass).toBe(false);
      expect(r.detail).toContain("tier3.ask_patterns[0]");
    });

    it("every ask_pattern inside tier3.patterns passes", () => {
      const r = checkTierRules(base(["vercel\\s+.*--prod\\b"]));
      expect(r.pass).toBe(true);
      expect(r.detail).toMatch(/ask_patterns ⊆ tier3\.patterns/);
    });

    it("an entry that does not compile is named once, not again for being outside the subset", () => {
      const r = checkTierRules(base(["unbalanced(paren"]));
      expect(r.pass).toBe(false);
      expect(r.detail?.match(/tier3\.ask_patterns\[0\]/g)).toHaveLength(1);
    });

    // Regras legadas não têm ask_patterns, de propósito: o guard nega todo Tier 3 (fecha).
    // Isso não é um arquivo quebrado; quem acusa é a checagem dinâmica do doctor (o deploy
    // de amostra deveria pedir aprovação) e o WARN de cobertura, que lista os que faltam.
    it("ask_patterns absent (legacy rules) is not flagged here", () => {
      expect(checkTierRules(base(undefined)).pass).toBe(true);
    });

    it.each([
      ["empty", []],
      ["only entries that do not compile", ["(", "[a-"]],
      ["only blank entries", ["", "  "]],
    ])("ask_patterns %s fails: no deploy can ask, so every Tier-3 deploy is denied", (_label, ask) => {
      const r = checkTierRules(base(ask));
      expect(r.pass).toBe(false);
      expect(r.detail).toMatch(/tier3\.ask_patterns has no pattern the guard can apply/);
      expect(r.detail).toMatch(/every Tier-3 deploy is denied/);
      expect(r.detail).toContain("aiteam/templates/tier-rules.json");
    });

    it("ask_patterns that is not a list is reported once, as before, not also as empty", () => {
      const r = checkTierRules(base("a"));
      expect(r.pass).toBe(false);
      expect(r.detail).toContain("tier3.ask_patterns is not a list");
      expect(r.detail).not.toMatch(/has no pattern the guard can apply/);
    });

    it("the canonical template satisfies the invariant", () => {
      const template = JSON.parse(readFileSync(path.join(HERE, "..", "templates", "tier-rules.json"), "utf8"));
      const r = checkTierRules(template);
      expect(r.pass).toBe(true);
    });
  });

  it("passes a well-formed file with ask_patterns and deny_hints", () => {
    const rules = {
      tier3: {
        patterns: ["\\bdrop\\b", "\\bssh\\b.*\\breboot\\b"],
        ask_patterns: ["\\bdrop\\b"],
        deny_hints: [{ match: "\\bssh\\b.*\\breboot\\b", hint: "a human does it" }],
      },
      tier2: { patterns: ["\\bgit\\b"] },
    };
    const r = checkTierRules(rules);
    expect(r.pass).toBe(true);
    expect(r.detail).toMatch(/compile/);
  });
});

// O guard não libera mais tudo sem o .claude/tier-rules.json: usa a cópia
// canônica do framework (aiteam/templates/tier-rules.json). O doctor reprova
// mesmo assim — o projeto ficou sem o arquivo dele — e diz o que o guard está
// fazendo. A leitura vive em doctor-io.mjs (readTierRulesFacts); aqui o julgamento.
describe("checkTierRulesFile — o arquivo do projeto existe, lê e está bem formado", () => {
  const GOOD = { tier3: { patterns: ["a"] }, tier2: { patterns: ["b"] } };
  const CANONICAL_OK = { rules: GOOD, problem: null, detail: null };

  it("legível e bem formado → passa, com o mesmo nome do check de sempre", () => {
    const r = checkTierRulesFile({ project: { rules: GOOD, problem: null, detail: null }, canonical: CANONICAL_OK });
    expect(r.pass).toBe(true);
    expect(r.name).toBe(".claude/tier-rules.json well-formed");
  });

  it("legível mas com padrão que não compila → reprova pelo check de sempre", () => {
    const bad = { tier3: { patterns: ["unbalanced(paren"] }, tier2: { patterns: ["b"] } };
    const r = checkTierRulesFile({ project: { rules: bad, problem: null, detail: null }, canonical: CANONICAL_OK });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('tier3.patterns[0] "unbalanced(paren"');
  });

  it("ausente → FAIL mandando rodar o install e dizendo que o guard usa a cópia canônica", () => {
    const r = checkTierRulesFile({
      project: { rules: null, problem: "missing", detail: "x/.claude/tier-rules.json não existe" },
      canonical: CANONICAL_OK,
    });
    expect(r.pass).toBe(false);
    expect(r.name).toBe(".claude/tier-rules.json well-formed");
    expect(r.detail).toContain("node aiteam/install.mjs");
    expect(r.detail).toMatch(/cópia canônica/);
  });

  it("ilegível → FAIL com o motivo, dizendo que o guard usa a cópia canônica", () => {
    const r = checkTierRulesFile({
      project: { rules: null, problem: "unreadable", detail: "x/.claude/tier-rules.json não é JSON válido: Unexpected token" },
      canonical: CANONICAL_OK,
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("não é JSON válido: Unexpected token");
    expect(r.detail).toMatch(/guard está usando a cópia canônica/);
    // O install nunca sobrescreve o arquivo do projeto: "rode o install" sozinho não conserta.
    expect(r.detail).toMatch(/corrija|apague/);
  });

  // O último recurso do guard (decisão do PO): regras vazias e o piso fixo do
  // tier-core — rm -rf e force-push seguem negados, o que só um padrão pega passa.
  // Não é "liberando tudo" nem "negando tudo".
  it("sem o arquivo do projeto E sem a cópia canônica → FAIL dizendo que o guard está só com o piso fixo", () => {
    const r = checkTierRulesFile({
      project: { rules: null, problem: "missing", detail: "x/.claude/tier-rules.json não existe" },
      canonical: { rules: null, problem: "missing", detail: "x/aiteam/templates/tier-rules.json não existe" },
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/só com o piso fixo \(rm -rf e force-push negados\)/);
    expect(r.detail).toMatch(/drop table e deploy passam sem pergunta/);
    expect(r.detail).not.toMatch(/liberando tudo/i);
    expect(r.detail).toContain("aiteam/templates/tier-rules.json");
    expect(r.detail).toContain("node aiteam/install.mjs");
  });
});

describe("checkTierRulesCoverage — o arquivo do projeto tem os padrões da cópia canônica", () => {
  const CANONICAL = {
    rules: {
      tier3: {
        patterns: ["\\bdrop\\s+table\\b", "vercel\\s+.*--prod\\b", "\\bssh\\b.*\\b(docker|systemctl)\\b"],
        ask_patterns: ["vercel\\s+.*--prod\\b", "\\bssh\\b.*\\b(docker|systemctl)\\b"],
      },
      tier2: { patterns: ["\\bgit\\s+commit\\b"] },
    },
    problem: null,
    detail: null,
  };
  const project = (rules: unknown) => ({ rules, problem: null, detail: null });

  it("o projeto tem tudo o que a cópia canônica tem → passa, sem aviso", () => {
    const r = checkTierRulesCoverage({ project: project(CANONICAL.rules), canonical: CANONICAL })!;
    expect(r.pass).toBe(true);
    expect(r.warn).toBeUndefined();
  });

  it("padrões a mais no projeto não incomodam", () => {
    const rules = {
      tier3: {
        patterns: [...CANONICAL.rules.tier3.patterns, "\\bmeu-comando-perigoso\\b"],
        ask_patterns: [...CANONICAL.rules.tier3.ask_patterns, "\\bmeu-deploy\\b"],
      },
      tier2: { patterns: [] },
    };
    const r = checkTierRulesCoverage({ project: project(rules), canonical: CANONICAL })!;
    expect(r.pass).toBe(true);
    expect(r.warn).toBeUndefined();
  });

  // WARN, não FAIL: o projeto pode ter tirado um padrão de propósito.
  it("faltam padrões → WARN (passa) com a lista de tier3.patterns e de ask_patterns", () => {
    const rules = {
      tier3: { patterns: ["\\bdrop\\s+table\\b"], ask_patterns: ["vercel\\s+.*--prod\\b"] },
      tier2: { patterns: [] },
    };
    const r = checkTierRulesCoverage({ project: project(rules), canonical: CANONICAL })!;
    expect(r.pass).toBe(true);
    expect(r.warn).toBe(true);
    expect(r.detail).toContain("tier3.patterns");
    expect(r.detail).toContain(JSON.stringify("vercel\\s+.*--prod\\b"));
    expect(r.detail).toContain(JSON.stringify("\\bssh\\b.*\\b(docker|systemctl)\\b"));
    expect(r.detail).toContain("tier3.ask_patterns");
    // o que o projeto tem não entra na lista de faltantes de tier3.patterns
    expect(r.detail).not.toContain(JSON.stringify("\\bdrop\\s+table\\b"));
  });

  it("compara por string exata: o mesmo padrão com uma letra diferente conta como faltante", () => {
    const rules = {
      tier3: {
        patterns: ["\\bdrop\\s+table\\b", "vercel\\s+.*--prod", "\\bssh\\b.*\\b(docker|systemctl)\\b"],
        ask_patterns: CANONICAL.rules.tier3.ask_patterns,
      },
      tier2: { patterns: [] },
    };
    const r = checkTierRulesCoverage({ project: project(rules), canonical: CANONICAL })!;
    expect(r.warn).toBe(true);
    expect(r.detail).toContain(JSON.stringify("vercel\\s+.*--prod\\b"));
  });

  it("projeto sem ask_patterns nenhum → lista todos os ask_patterns da cópia canônica", () => {
    const rules = { tier3: { patterns: CANONICAL.rules.tier3.patterns }, tier2: { patterns: [] } };
    const r = checkTierRulesCoverage({ project: project(rules), canonical: CANONICAL })!;
    expect(r.warn).toBe(true);
    expect(r.detail).toContain("tier3.ask_patterns");
    expect(r.detail).not.toContain("tier3.patterns:");
  });

  it("arquivo do projeto inutilizável → nada a comparar (o check do arquivo já reprova)", () => {
    expect(
      checkTierRulesCoverage({ project: { rules: null, problem: "missing", detail: "d" }, canonical: CANONICAL })
    ).toBeNull();
  });

  it("cópia canônica inutilizável → WARN dizendo que não deu para comparar", () => {
    const r = checkTierRulesCoverage({
      project: project(CANONICAL.rules),
      canonical: { rules: null, problem: "unreadable", detail: "x/aiteam/templates/tier-rules.json não é JSON válido" },
    })!;
    expect(r.pass).toBe(true);
    expect(r.warn).toBe(true);
    expect(r.detail).toMatch(/não deu para comparar/);
  });
});

// ReDoS no gate: o guard roda cada padrão contra o comando inteiro, e o timeout de
// um hook é falha aberta. O arquivo do consumidor continua com o padrão antigo
// depois do sync (o sync nunca sobrescreve o .claude/tier-rules.json), então o
// doctor sonda os padrões do arquivo do projeto e avisa. A sondagem em si roda num
// processo filho (readTierRulesProbe, doctor-io.mjs); aqui só o julgamento.
describe("tierRulesPatternEntries — todo padrão que o guard roda, uma vez cada", () => {
  it("junta tier3.patterns, ask_patterns, tier2.patterns e deny_hints[].match, com onde cada um mora", () => {
    const entries = tierRulesPatternEntries({
      tier3: {
        patterns: ["A", "B"],
        ask_patterns: ["A"],
        deny_hints: [{ match: "B", hint: "h" }, { match: "D", hint: "h" }],
      },
      tier2: { patterns: ["C", 42] },
    });
    expect(entries).toEqual([
      { source: "A", where: ["tier3.patterns[0]", "tier3.ask_patterns[0]"] },
      { source: "B", where: ["tier3.patterns[1]", "tier3.deny_hints[0].match"] },
      { source: "C", where: ["tier2.patterns[0]"] },
      { source: "D", where: ["tier3.deny_hints[1].match"] },
    ]);
  });

  it("ignora o que o guard também ignora: listas que não são lista, entradas que não são texto, texto vazio", () => {
    expect(tierRulesPatternEntries({ tier3: { patterns: "x", ask_patterns: [1, null, ""], deny_hints: {} }, tier2: {} })).toEqual([]);
    expect(tierRulesPatternEntries(null)).toEqual([]);
  });
});

describe("checkTierRulesRegexSafety — o arquivo do projeto não tem padrão com backtracking catastrófico", () => {
  const NAME = ".claude/tier-rules.json patterns do not backtrack catastrophically";
  const project = (rules: unknown) => ({ rules, problem: null, detail: null });
  const GOOD = { tier3: { patterns: ["a"] }, tier2: { patterns: ["b"] } };
  const clean = { probed: 2, findings: [], hung: [], unprobed: [], error: null };
  const OLD_SSH = JSON.parse(readFileSync(path.join(HERE, "__fixtures__", "legacy-tier-patterns.json"), "utf8")).sshScriptByPath as string;

  it("arquivo do projeto inutilizável → nada a sondar (o check do arquivo já reprova)", () => {
    expect(checkTierRulesRegexSafety({ project: { rules: null, problem: "missing", detail: "d" }, probe: clean })).toBeNull();
  });

  it("nenhum padrão degenerou → passa, sem aviso, dizendo quantos foram sondados", () => {
    const r = checkTierRulesRegexSafety({ project: project(GOOD), probe: clean })!;
    expect(r.name).toBe(NAME);
    expect(r.pass).toBe(true);
    expect(r.warn).toBeUndefined();
    expect(r.detail).toContain("2 padrões");
  });

  it("padrão catastrófico → WARN (passa) que NOMEIA o padrão e onde ele mora, e manda trocar pelo da canônica", () => {
    const r = checkTierRulesRegexSafety({
      project: project(GOOD),
      probe: {
        probed: 3,
        findings: [
          {
            source: "^(a+)+$",
            where: ["tier3.patterns[2]", "tier3.ask_patterns[0]"],
            reason: "growth",
            ms: 41.7,
            size: 31,
            label: '"" + "a" repetida + "!"',
            previousMs: 2.1,
          },
        ],
        hung: [],
        unprobed: [],
        error: null,
      },
    })!;
    expect(r.pass).toBe(true);
    expect(r.warn).toBe(true);
    expect(r.detail).toContain(JSON.stringify("^(a+)+$"));
    expect(r.detail).toContain("tier3.patterns[2]");
    expect(r.detail).toContain("tier3.ask_patterns[0]");
    expect(r.detail).toMatch(/41[.,]7 ms/);
    expect(r.detail).toContain("31 bytes");
    // A razão de importar: o timeout do hook falha aberto.
    expect(r.detail).toMatch(/falha ABERTA/);
    expect(r.detail).toContain("aiteam/templates/tier-rules.json");
    expect(r.detail).toMatch(/[Tt]roque/);
  });

  // R1: o padrão é texto do arquivo do projeto, e `LEGACY_PATTERN_REPLACEMENTS["constructor"]` devolve uma função herdada.
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])("um padrão que se chama %s não é um substituto conhecido: manda trocar pelo equivalente da canônica", (source) => {
    const r = checkTierRulesRegexSafety({
      project: project(GOOD),
      probe: { probed: 1, findings: [{ source, where: ["tier3.patterns[0]"], reason: "budget", ms: 300, size: 90, label: "x", previousMs: 20 }], hung: [], unprobed: [], error: null },
    })!;
    expect(r.warn).toBe(true);
    expect(r.detail).toContain("equivalente da cópia canônica");
    expect(r.detail).not.toContain("function");
    expect(r.detail).not.toContain("[object");
  });

  // O padrão antigo do ssh é o caso real: o doctor sabe o que pôr no lugar dele.
  it("o padrão de ssh antigo → WARN com o padrão novo da canônica, para colar", () => {
    const NEW_SSH = LEGACY_PATTERN_REPLACEMENTS[OLD_SSH]!;
    const r = checkTierRulesRegexSafety({
      project: project(GOOD),
      probe: {
        probed: 1,
        findings: [
          { source: OLD_SSH, where: ["tier3.patterns[13]", "tier3.ask_patterns[6]"], reason: "budget", ms: 300, size: 90, label: "x", previousMs: 20 },
        ],
        hung: [],
        unprobed: [],
        error: null,
      },
    })!;
    expect(r.warn).toBe(true);
    expect(r.detail).toContain(JSON.stringify(OLD_SSH));
    expect(r.detail).toContain(JSON.stringify(NEW_SSH));
    expect(r.detail).toMatch(/tier3\.patterns e em tier3\.ask_patterns/);
  });

  // Onda 2, item 4: o cúbico de ssh+shell passou pela sondagem até as famílias de duas palavras.
  // O doctor agora o acha e traz o substituto linear para colar.
  it("o padrão cúbico de ssh+shell antigo → WARN com o padrão linear da canônica, para colar", () => {
    const OLD_CUBIC = JSON.parse(readFileSync(path.join(HERE, "__fixtures__", "legacy-tier-patterns.json"), "utf8")).sshShellScriptCubic as string;
    const NEW_CUBIC = LEGACY_PATTERN_REPLACEMENTS[OLD_CUBIC]!;
    expect(NEW_CUBIC).toBeDefined();
    const r = checkTierRulesRegexSafety({
      project: project(GOOD),
      probe: {
        probed: 1,
        findings: [
          { source: OLD_CUBIC, where: ["tier3.patterns[14]", "tier3.ask_patterns[5]"], reason: "budget", ms: 239, size: 3443, label: '"" + "ssh bash " repetida', previousMs: 70 },
        ],
        hung: [],
        unprobed: [],
        error: null,
      },
    })!;
    expect(r.warn).toBe(true);
    expect(r.detail).toContain(JSON.stringify(OLD_CUBIC));
    expect(r.detail).toContain(JSON.stringify(NEW_CUBIC));
    expect(r.detail).toMatch(/tier3\.patterns e em tier3\.ask_patterns/);
  });

  it("um padrão que travou a sondagem → WARN dizendo que ele não terminou nem em segundos", () => {
    const r = checkTierRulesRegexSafety({
      project: project(GOOD),
      probe: { probed: 1, findings: [], hung: [{ source: "(a*)*(a*)*(a*)*b", where: ["tier2.patterns[4]"] }], unprobed: [], error: null },
    })!;
    expect(r.pass).toBe(true);
    expect(r.warn).toBe(true);
    expect(r.detail).toContain(JSON.stringify("(a*)*(a*)*(a*)*b"));
    expect(r.detail).toContain("tier2.patterns[4]");
    expect(r.detail).toMatch(/travou/);
  });

  it("a sondagem não rodou (erro) ou não chegou a todos → WARN dizendo o que ficou sem conferir, nunca verde", () => {
    const failed = checkTierRulesRegexSafety({ project: project(GOOD), probe: { probed: 0, findings: [], hung: [], unprobed: [], error: "spawn node ENOENT" } })!;
    expect(failed.pass).toBe(true);
    expect(failed.warn).toBe(true);
    expect(failed.detail).toContain("spawn node ENOENT");

    const partial = checkTierRulesRegexSafety({
      project: project(GOOD),
      probe: { probed: 1, findings: [], hung: [], unprobed: [{ source: "x+", where: ["tier2.patterns[1]"] }], error: null },
    })!;
    expect(partial.warn).toBe(true);
    expect(partial.detail).toContain("tier2.patterns[1]");
  });

  it("a tabela de padrões trocados é coerente: o antigo degenera e o novo está na cópia canônica", () => {
    const template = JSON.parse(readFileSync(path.join(HERE, "..", "templates", "tier-rules.json"), "utf8"));
    for (const [old, fixed] of Object.entries(LEGACY_PATTERN_REPLACEMENTS)) {
      expect(template.tier3.patterns, `${fixed} não está em tier3.patterns da canônica`).toContain(fixed);
      expect(old).not.toBe(fixed);
      expect(probePattern(old)).toMatchObject({ ok: false });
      expect(probePattern(fixed)).toMatchObject({ ok: true });
    }
  });
});

// F7: as checagens dinâmicas rodavam o hook só com o Bash. O hook despacha pelo nome
// da ferramenta (COMMAND_TOOLS), então uma cópia velha do hook, ou um despacho que
// esqueceu o PowerShell, passava verde enquanto o PowerShell rodava destrutivo sem
// deny e deploy sem ASK (issue #12). A amostra roda em cada ferramenta de comando.
describe("checkTierGuardSample — o hook decide igual em toda ferramenta que executa comando", () => {
  const DENY_NAME = "tier-guard denies a sample destructive Tier-3 command";
  const ASK_NAME = "tier-guard asks for a sample deploy Tier-3 command";

  it("as ferramentas amostradas são Bash e PowerShell", () => {
    expect([...TIER_GUARD_SAMPLE_TOOLS]).toEqual(["Bash", "PowerShell"]);
  });

  it("deny nas duas ferramentas → passa, com os nomes de sempre, dizendo quais", () => {
    const r = checkTierGuardSample({ expected: "deny", command: "prisma migrate reset", decisions: { Bash: "deny", PowerShell: "deny" } });
    expect(r.name).toBe(DENY_NAME);
    expect(r.pass).toBe(true);
    expect(r.detail).toBe("`prisma migrate reset` → deny (Bash, PowerShell)");
  });

  it("ask nas duas ferramentas → passa", () => {
    const r = checkTierGuardSample({ expected: "ask", command: "npx prisma migrate deploy", decisions: { Bash: "ask", PowerShell: "ask" } });
    expect(r.name).toBe(ASK_NAME);
    expect(r.pass).toBe(true);
    expect(r.detail).toBe("`npx prisma migrate deploy` → ask (Bash, PowerShell)");
  });

  it("o PowerShell passa o destrutivo (hook velho que só despacha o Bash) → FAIL nomeando a ferramenta", () => {
    const r = checkTierGuardSample({ expected: "deny", command: "prisma migrate reset", decisions: { Bash: "deny", PowerShell: "allow" } });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("PowerShell → allow");
    expect(r.detail).not.toContain("Bash →");
    expect(r.detail).toMatch(/NOT denied/);
    expect(r.detail).toMatch(/allow_tier3/);
  });

  it("o PowerShell não pede aprovação no deploy → FAIL nomeando a ferramenta", () => {
    const r = checkTierGuardSample({ expected: "ask", command: "npx prisma migrate deploy", decisions: { Bash: "ask", PowerShell: "deny" } });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("PowerShell → deny");
    expect(r.detail).toMatch(/NOT set to ask/);
    expect(r.detail).toMatch(/ask_patterns/);
  });

  it("as duas falham → as duas nomeadas; hook que não respondeu (null) vira 'no decision'", () => {
    const r = checkTierGuardSample({ expected: "deny", command: "x", decisions: { Bash: "allow", PowerShell: null } });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("Bash → allow");
    expect(r.detail).toContain("PowerShell → no decision");
  });

  it("sem nenhuma decisão a conferir → FAIL (nunca verde por omissão)", () => {
    expect(checkTierGuardSample({ expected: "deny", command: "x", decisions: {} }).pass).toBe(false);
  });
});

describe("checkHooksPath — framework git hooks reachable", () => {
  it("passes when hooksPath points at aiteam/githooks", () => {
    expect(checkHooksPath("aiteam/githooks").pass).toBe(true);
  });

  it("passes with backslashes", () => {
    expect(checkHooksPath("aiteam\\githooks").pass).toBe(true);
  });

  it("fails when hooksPath is empty", () => {
    expect(checkHooksPath("").pass).toBe(false);
  });

  // Router topology: the host keeps its OWN core.hooksPath and the installer
  // chains the framework hooks into it (planHookChaining's "router" action).
  // Requiring the config to name aiteam/githooks failed the very topology the
  // installer creates — `install.mjs` then `doctor.mjs` reported FAIL on a
  // healthy, working install (observed in jusbraz/crm).
  const ALL_HOOKS = ["post-checkout", "pre-commit", "pre-push"];

  it("passes in router mode when the host's hooks carry the chain line", () => {
    const r = checkHooksPath(".githooks", ALL_HOOKS, ALL_HOOKS);
    expect(r.pass).toBe(true);
    expect(r.warn).toBeFalsy();
  });

  // "1 chained" is only knowable as PARTIAL against the expected roster — hence
  // the third argument. Without it the check can't tell short-of-full from
  // all-there-is, so it stays quiet rather than warn on a guess.
  it("passes but warns when only SOME host hooks are chained (partial install)", () => {
    const r = checkHooksPath(".githooks", ["pre-commit"], ALL_HOOKS);
    expect(r.pass).toBe(true);
    expect(r.warn).toBe(true);
    expect(r.detail).toContain("only pre-commit");
  });

  it("still fails when the hooksPath is foreign and nothing is chained", () => {
    expect(checkHooksPath(".githooks", []).pass).toBe(false);
    expect(checkHooksPath(".githooks").pass).toBe(false);
  });

  it("warns (but still passes) when hooksPath is a Windows absolute path", () => {
    // Absolute paths defeat per-worktree hook resolution: git runs the main
    // checkout's hooks even from inside a worktree. Still "reachable" (pass),
    // but flagged so `doctor` surfaces the latent bug the substring check missed.
    const r = checkHooksPath("C:\\devops\\source\\rb-ai-team\\aiteam\\githooks");
    expect(r.pass).toBe(true);
    expect(r.warn).toBe(true);
  });

  it("warns on a POSIX absolute path too", () => {
    const r = checkHooksPath("/home/u/repo/aiteam/githooks");
    expect(r.pass).toBe(true);
    expect(r.warn).toBe(true);
  });

  it("does not warn on the exact relative form", () => {
    const r = checkHooksPath("aiteam/githooks");
    expect(r.pass).toBe(true);
    expect(r.warn).toBeFalsy();
  });

  it("does not warn on the exact relative form with backslashes", () => {
    const r = checkHooksPath("aiteam\\githooks");
    expect(r.pass).toBe(true);
    expect(r.warn).toBeFalsy();
  });
});

describe("checkBeadsValidation — degrada sem toolchain", () => {
  it("toolchain ausente → WARN (passa, não falha o exit)", () => {
    const r = checkBeadsValidation({ toolchainPresent: false, status: null, output: "" });
    expect(r.pass).toBe(true);
    expect(r.warn).toBe(true);
    expect(r.detail).toMatch(/tsx|toolchain/i);
  });

  it("toolchain presente + exit 0 → PASS sem warn", () => {
    const r = checkBeadsValidation({ toolchainPresent: true, status: 0, output: "" });
    expect(r.pass).toBe(true);
    expect(r.warn).toBeFalsy();
    expect(r.detail).toMatch(/conforms/i);
  });

  it("toolchain presente + exit != 0 → FAIL com a saída", () => {
    const r = checkBeadsValidation({ toolchainPresent: true, status: 1, output: "SCHEMA violation: campo X" });
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/exit 1/);
    expect(r.detail).toMatch(/SCHEMA violation/);
  });
});

describe("checkBeadsModel — modo legado é aviso, não falha", () => {
  it("legado → WARN com o comando de migração", () => {
    const r = checkBeadsModel({ legacy: true });
    expect(r.pass).toBe(true);
    expect(r.warn).toBe(true);
    expect(r.detail).toMatch(/migrate-beads\.mjs --dry-run/);
  });

  it("modelo novo → PASS", () => {
    const r = checkBeadsModel({ legacy: false });
    expect(r.pass).toBe(true);
    expect(r.warn).toBeFalsy();
  });
});

// rb-ai-team#37: nenhum hook remove o merge.beads-yaml do .git/config, que é
// compartilhado com o checkout principal e as outras worktrees. Quem avisa do
// resíduo é o doctor.
describe("checkMergeDriverResidue — o doctor avisa, o hook não remove", () => {
  it("sem registro → PASS", () => {
    expect(checkMergeDriverResidue({ driver: null, legacy: false })).toMatchObject({ pass: true });
    expect(checkMergeDriverResidue({ driver: null, legacy: false }).warn).toBeFalsy();
  });

  it("registrado no modelo novo → WARN com o comando de remoção", () => {
    const r = checkMergeDriverResidue({ driver: '"tsx" "beads-merge.ts" %A %O %B', legacy: false });
    expect(r.pass).toBe(true);
    expect(r.warn).toBe(true);
    expect(r.detail).toMatch(/git config --remove-section merge\.beads-yaml/);
  });

  // O sync manda tirar o mapeamento do .gitattributes também em modo legado
  // (aiteam/docs/consuming-as-upstream.md). Sem o mapeamento o git nunca chama o
  // driver: o que sobra no .git/config é inerte, e o doctor diz quando apagar.
  it("legado, driver registrado e .gitattributes sem o mapeamento → WARN: inerte, com o comando de remoção", () => {
    const r = checkMergeDriverResidue({ driver: "git merge-file --union %A %O %B", legacy: true, mapped: false });
    expect(r.pass).toBe(true);
    expect(r.warn).toBe(true);
    expect(r.detail).toMatch(/inerte/);
    expect(r.detail).toMatch(/git config --remove-section merge\.beads-yaml/);
    expect(r.detail).not.toMatch(/ainda o usa/);
  });

  // O driver só roda se o .gitattributes o mapeia. Um consumidor legado que
  // ainda mapeia é avisado, sem reprovar — o contract test é quem reprova.
  it("legado, driver registrado e .gitattributes ainda mapeando → WARN: manda tirar as linhas", () => {
    const r = checkMergeDriverResidue({ driver: "git merge-file --union %A %O %B", legacy: true, mapped: true });
    expect(r.pass).toBe(true);
    expect(r.warn).toBe(true);
    expect(r.detail).toMatch(/bloco inteiro do driver, comentário incluído/);
    expect(r.detail).toMatch(/consuming-as-upstream\.md/);
    expect(r.detail).toMatch(/conflito/);
  });

  it("mapeamento sem driver registrado → WARN: o git usa o merge de texto, e o contract test reprova a linha", () => {
    const r = checkMergeDriverResidue({ driver: null, legacy: true, mapped: true });
    expect(r.pass).toBe(true);
    expect(r.warn).toBe(true);
    expect(r.detail).toMatch(/bloco inteiro do driver, comentário incluído/);
    expect(r.detail).not.toMatch(/remove-section/);
  });

  // Consumidor ainda legado que sincroniza o framework e mantém o mapeamento: se
  // o script do driver sumir, todo merge de .beads/*.yaml falha no driver. O
  // beads-merge.ts fica até a fase 3, e o doctor confere que o caminho registrado
  // existe — mas só quando o .gitattributes ainda chama o driver.
  it("legado, mapeado, com o script do driver faltando → FAIL, com o caminho e a saída: tirar o mapeamento", () => {
    const driver = '"C:/r/aiteam/node_modules/.bin/tsx" "C:/r/aiteam/scripts/beads-merge.ts" %A %O %B';
    const r = checkMergeDriverResidue({ driver, legacy: true, mapped: true, missing: ["C:/r/aiteam/scripts/beads-merge.ts"] });
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/C:\/r\/aiteam\/scripts\/beads-merge\.ts/);
    // A saída é tirar o mapeamento (a união silenciosa do driver nativo já
    // corrompeu um active.yaml) ou migrar — nunca registrar outro driver.
    expect(r.detail).toMatch(/bloco inteiro do driver, comentário incluído/);
    expect(r.detail).toMatch(/migrate-beads\.mjs --dry-run/);
    expect(r.detail).not.toMatch(/git merge-file/);
    expect(r.detail).not.toMatch(/install\.mjs/);
  });

  // Sem o mapeamento o driver registrado nunca roda, com o script lá ou não:
  // reprovar aqui puniria quem já seguiu o checklist do sync.
  it("legado, sem o mapeamento, com o script do driver faltando → só WARN (o driver nem é chamado)", () => {
    const driver = '"C:/r/aiteam/node_modules/.bin/tsx" "C:/r/aiteam/scripts/beads-merge.ts" %A %O %B';
    const r = checkMergeDriverResidue({ driver, legacy: true, mapped: false, missing: ["C:/r/aiteam/scripts/beads-merge.ts"] });
    expect(r.pass).toBe(true);
    expect(r.warn).toBe(true);
    expect(r.detail).toMatch(/git config --remove-section merge\.beads-yaml/);
  });

  // O FAIL exige modo legado: num repo migrado os arquivos de bead são um por
  // branch e não há .beads/*.yaml compartilhado para o driver unir. Migrado +
  // mapeia + script ausente é WARN — mesmo com o mapeamento ainda lá.
  it("migrado, mapeado, com o script do driver faltando → WARN, não FAIL", () => {
    const r = checkMergeDriverResidue({
      driver: '"tsx" "x/beads-merge.ts" %A %O %B',
      legacy: false,
      mapped: true,
      missing: ["x/beads-merge.ts"],
    });
    expect(r.pass).toBe(true);
    expect(r.warn).toBe(true);
    expect(r.detail).toMatch(/bloco inteiro do driver, comentário incluído/);
  });

  it("modelo novo com o script faltando continua só WARN (o driver nem é usado)", () => {
    const r = checkMergeDriverResidue({ driver: '"tsx" "x/beads-merge.ts" %A %O %B', legacy: false, missing: ["x/beads-merge.ts"] });
    expect(r.pass).toBe(true);
    expect(r.warn).toBe(true);
  });

  // O contract test reprova QUALQUER `beads-yaml` no .gitattributes, não só o
  // mapeamento. Quem tirou as linhas mas deixou um comentário que cita o driver
  // (o do bloco antigo, ou o de outra regra) passa no mapeamento e cai no teste:
  // o doctor avisa antes. WARN, não FAIL — o contract test é quem reprova.
  it("sem mapeamento, mas o .gitattributes ainda cita beads-yaml num comentário → WARN: reescreva sem citar o driver", () => {
    const r = checkMergeDriverResidue({ driver: null, legacy: true, mapped: false, cited: true });
    expect(r.pass).toBe(true);
    expect(r.warn).toBe(true);
    expect(r.detail).toMatch(/cita 'beads-yaml'/);
    expect(r.detail).toMatch(/githooks-contract\.test\.ts/);
    expect(r.detail).toMatch(/sem citar o driver/);
    expect(r.detail).not.toMatch(/remove-section/);
  });

  it("sem mapeamento, com a citação e o driver ainda registrado → WARN com as duas saídas", () => {
    const r = checkMergeDriverResidue({ driver: "git merge-file --union %A %O %B", legacy: false, mapped: false, cited: true });
    expect(r.pass).toBe(true);
    expect(r.warn).toBe(true);
    expect(r.detail).toMatch(/sem citar o driver/);
    expect(r.detail).toMatch(/git config --remove-section merge\.beads-yaml/);
  });

  it("sem mapeamento e sem citação, com o driver registrado → só o aviso do resíduo inerte", () => {
    const r = checkMergeDriverResidue({ driver: "git merge-file --union %A %O %B", legacy: true, mapped: false, cited: false });
    expect(r.warn).toBe(true);
    expect(r.detail).not.toMatch(/cita 'beads-yaml'/);
  });

  // `mapped` é fato do .gitattributes: só conta linha de verdade. Comentário
  // que cita o driver (o bloco antigo trazia `merge.beads-yaml.*`) não chama nada.
  it("gitattributesMapsDriver: só o mapeamento real conta, não o comentário", () => {
    expect(gitattributesMapsDriver(".beads/*.yaml merge=beads-yaml\n")).toBe(true);
    expect(gitattributesMapsDriver("*.mjs text eol=lf\r\n.beads/active.yaml merge=beads-yaml\r\n")).toBe(true);
    expect(gitattributesMapsDriver("# The driver is registered by post-checkout (git config merge.beads-yaml.*).\n")).toBe(false);
    expect(gitattributesMapsDriver("# .beads/*.yaml merge=beads-yaml\n")).toBe(false);
    expect(gitattributesMapsDriver("*.mjs text eol=lf\n")).toBe(false);
    expect(gitattributesMapsDriver("")).toBe(false);
    expect(gitattributesMapsDriver(null)).toBe(false);
  });

  // `cited` é o outro lado: `beads-yaml` em qualquer linha que não seja o
  // mapeamento — o texto que o contract test reprova mesmo sem mapear nada.
  it("gitattributesCitesDriver: comentário que cita o driver conta; o mapeamento (já é `mapped`) e o resto não", () => {
    expect(gitattributesCitesDriver("# The driver is registered by post-checkout (git config merge.beads-yaml.*).\n")).toBe(true);
    expect(gitattributesCitesDriver("# NOT beads-yaml, and not a wildcard over archive/: index.yaml is a FLAT list\r\n")).toBe(true);
    expect(gitattributesCitesDriver("# .beads/*.yaml merge=beads-yaml\n")).toBe(true);
    expect(gitattributesCitesDriver(".beads/*.yaml merge=beads-yaml\n")).toBe(false);
    expect(gitattributesCitesDriver("*.mjs text eol=lf\n.beads/archive/index.yaml merge=union\n")).toBe(false);
    expect(gitattributesCitesDriver("")).toBe(false);
    expect(gitattributesCitesDriver(undefined)).toBe(false);
  });

  it("driverPaths: os caminhos que o comando do driver referencia", () => {
    expect(driverPaths('"C:/r/node_modules/.bin/tsx" "C:/r/aiteam/scripts/beads-merge.ts" %A %O %B')).toEqual([
      "C:/r/node_modules/.bin/tsx",
      "C:/r/aiteam/scripts/beads-merge.ts",
    ]);
    expect(driverPaths("npx tsx aiteam/scripts/beads-merge.ts %A %O %B")).toEqual(["aiteam/scripts/beads-merge.ts"]);
    expect(driverPaths("git merge-file --union %A %O %B")).toEqual([]);
    expect(driverPaths("")).toEqual([]);
  });
});

// O beads-guard é acelerador opcional (o gate é o pre-commit): ausente é WARN.
describe("checkBeadsGuardSettings — acelerador opcional", () => {
  it("instalado pelo FRAMEWORK_SETTINGS → PASS", () => {
    expect(checkBeadsGuardSettings(mergeSettings({}, FRAMEWORK_SETTINGS))).toMatchObject({ pass: true });
    expect(checkBeadsGuardSettings(mergeSettings({}, FRAMEWORK_SETTINGS)).warn).toBeFalsy();
  });

  it("ausente → WARN com o comando do install", () => {
    const r = checkBeadsGuardSettings({ hooks: { PreToolUse: [] } });
    expect(r.pass).toBe(true);
    expect(r.warn).toBe(true);
    expect(r.detail).toMatch(/install\.mjs/);
  });
});

describe("checkInfraKb", () => {
  const pointer = { remote: "vps-infra", url: null, ref: "main", entry: "README.md" };

  it("passa e se identifica como não-aplicável quando não há slot", () => {
    const r = checkInfraKb({ pointer: null, remoteExists: false, ageDays: null });
    expect(r.pass).toBe(true);
    expect(r.detail).toMatch(/não declara|nao declara/i);
  });

  it("falha quando o slot existe mas o remote não", () => {
    const r = checkInfraKb({ pointer, remoteExists: false, ageDays: null });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("vps-infra");
  });

  it("passa com aviso quando o ref está velho", () => {
    const r = checkInfraKb({ pointer, remoteExists: true, ageDays: 22 });
    expect(r.pass).toBe(true);
    expect(r.warn).toBe(true);
    expect(r.detail).toContain("22");
  });

  // Finding 3 do review final: ageDays mede a idade do COMMIT no topo do ref,
  // não de quando rodamos `git fetch` por último. A mensagem antiga
  // ("sincronizado há N dias — rode: git fetch") prometia que rodar fetch
  // resolveria o aviso — falso quando o registro só está genuinamente parado
  // (ninguém reservou porta em N dias). A mensagem nova descreve idade de
  // CONTEÚDO e trata o fetch como confirmação, não como cura.
  it("a mensagem de ref velho descreve idade de conteúdo, não promete que fetch resolve", () => {
    const r = checkInfraKb({ pointer, remoteExists: true, ageDays: 22 });
    expect(r.detail).toMatch(/conteúdo/i);
    expect(r.detail).not.toMatch(/sincronizado há/i);
  });

  it("passa limpo quando está sincronizado", () => {
    const r = checkInfraKb({ pointer, remoteExists: true, ageDays: 1 });
    expect(r.pass).toBe(true);
    expect(r.warn).toBeFalsy();
  });

  it("passa com aviso quando o ref nunca foi sincronizado", () => {
    const r = checkInfraKb({ pointer, remoteExists: true, ageDays: null });
    expect(r.pass).toBe(true);
    expect(r.warn).toBe(true);
    expect(r.detail).toMatch(/nunca foi sincronizado|git fetch/i);
  });

  it("passa com aviso quando git não está disponível", () => {
    const r = checkInfraKb({ pointer, remoteExists: null, ageDays: null });
    expect(r.pass).toBe(true);
    expect(r.warn).toBe(true);
    expect(r.detail).toMatch(/git não está|nao esta|disponível|indisponivel/i);
  });

  it("passa limpo quando ageDays está exatamente no limite de staleness", () => {
    const r = checkInfraKb({ pointer, remoteExists: true, ageDays: 7 });
    expect(r.pass).toBe(true);
    expect(r.warn).toBeFalsy();
    expect(r.detail).toMatch(/presente e recente/);
  });

  // Finding 2 do review final: quando doctor.mjs detecta (via diagnosePointer)
  // que infra_kb está DECLARADO mas quebrado, isso tem que virar FAIL — não o
  // PASS silencioso que o pointer:null recebe. malformedReason é o sinal que
  // diagnosePointer manda; checkInfraKb só precisa agir nele.
  it("falha quando malformedReason está presente, mesmo sem pointer", () => {
    const r = checkInfraKb({ pointer: null, remoteExists: false, ageDays: null, malformedReason: "infra_kb.remote está vazia" });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("infra_kb.remote está vazia");
  });

  it("malformedReason tem prioridade sobre qualquer outro estado", () => {
    const r = checkInfraKb({ pointer, remoteExists: true, ageDays: 1, malformedReason: "não deveria acontecer junto com pointer, mas se acontecer, falha mesmo assim" });
    expect(r.pass).toBe(false);
  });

  it("sem malformedReason, o comportamento de antes continua idêntico (regressão)", () => {
    const r = checkInfraKb({ pointer: null, remoteExists: false, ageDays: null, malformedReason: null });
    expect(r.pass).toBe(true);
    expect(r.detail).toMatch(/não declara|nao declara/i);
  });
});

describe("summarize", () => {
  it("is green only when every check passed", () => {
    const s = summarize([
      { name: "a", pass: true },
      { name: "b", pass: true },
    ]);
    expect(s.pass).toBe(true);
    expect(s.passed).toBe(2);
    expect(s.failed).toBe(0);
  });

  it("is red when any check failed", () => {
    const s = summarize([
      { name: "a", pass: true },
      { name: "b", pass: false },
    ]);
    expect(s.pass).toBe(false);
    expect(s.failed).toBe(1);
  });
});

// Onda 2, item 7 (F13): o gate-edit-guard pede confirmação na edição dos arquivos do gate. O doctor confere
// que ele está ligado nas quatro ferramentas de edição (um consumidor que sincronizou o vendor e não
// rodou o install fica sem ele) e, ao vivo, que o hook de pé responde ask a uma edição do tier-rules.json.
describe("checkGateEditGuardSettings — PreToolUse gate-edit-guard cobre as quatro ferramentas de edição", () => {
  const NAME = ".claude/settings.json PreToolUse gate-edit-guard";
  const wired = (matcher: string) => ({ hooks: { PreToolUse: [{ matcher, hooks: [{ type: "command", command: "node aiteam/hooks/gate-edit-guard.mjs" }] }] } });

  it("passa com Write|Edit|MultiEdit|NotebookEdit", () => {
    const r = checkGateEditGuardSettings(wired("Write|Edit|MultiEdit|NotebookEdit"));
    expect(r.name).toBe(NAME);
    expect(r.pass).toBe(true);
  });

  it("o que o install escreve passa (FRAMEWORK_SETTINGS), inclusive mesclado num consumidor antigo", () => {
    expect(checkGateEditGuardSettings(FRAMEWORK_SETTINGS).pass).toBe(true);
    expect(checkGateEditGuardSettings(mergeSettings({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "x" }] }] } }, FRAMEWORK_SETTINGS)).pass).toBe(true);
  });

  it("falha nomeando as ferramentas que ficam de fora (só Write|Edit)", () => {
    const r = checkGateEditGuardSettings(wired("Write|Edit"));
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/MultiEdit/);
    expect(r.detail).toMatch(/NotebookEdit/);
    expect(r.detail).not.toMatch(/\bWrite\b.*not a PreToolUse hook for Write/);
    expect(r.detail).toMatch(/install/);
  });

  it("falha sem nenhuma entrada, sem hooks e sem settings", () => {
    expect(checkGateEditGuardSettings({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "node aiteam/hooks/tier-guard.mjs" }] }] } }).pass).toBe(false);
    expect(checkGateEditGuardSettings({}).pass).toBe(false);
    expect(checkGateEditGuardSettings(null).pass).toBe(false);
  });

  it("um matcher que cobre tudo (vazio ou *) também vale, e o caminho com barra invertida (Windows)", () => {
    expect(checkGateEditGuardSettings(wired("*")).pass).toBe(true);
    expect(checkGateEditGuardSettings({ hooks: { PreToolUse: [{ matcher: "Write|Edit|MultiEdit|NotebookEdit", hooks: [{ command: "node aiteam\\hooks\\gate-edit-guard.mjs" }] }] } }).pass).toBe(true);
  });

  it("as quatro ferramentas podem vir em entradas separadas", () => {
    const settings = {
      hooks: {
        PreToolUse: ["Write", "Edit", "MultiEdit", "NotebookEdit"].map((matcher) => ({ matcher, hooks: [{ command: "node aiteam/hooks/gate-edit-guard.mjs" }] })),
      },
    };
    expect(checkGateEditGuardSettings(settings).pass).toBe(true);
  });
});

describe("checkGateEditSample — o hook de pé pede confirmação na edição do mapa de tiers", () => {
  const NAME = "gate-edit-guard asks before an edit of .claude/tier-rules.json";

  it("ask → passa", () => {
    const r = checkGateEditSample({ decision: "ask" });
    expect(r.name).toBe(NAME);
    expect(r.pass).toBe(true);
  });

  it.each([["allow"], ["deny"], [null]])("%s → FAIL dizendo o que fazer", (decision) => {
    const r = checkGateEditSample({ decision: decision as "allow" | "deny" | null });
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/gate-edit-guard/);
    expect(r.detail).toMatch(/install|vendor/);
  });
});

// Onda 2, item 5 (A2/F19): um SPEC.md que escreve `allow_tier3: true` mas num formato que a leitura
// por linhas recusa (string de aspas que atravessa linhas, valor que continua na linha seguinte,
// tab, bloco duplicado...) deixa o break-glass DESLIGADO em silêncio: o humano acha que ligou. O
// doctor avisa, com a razão.
describe("checkAllowTier3Reading — allow_tier3 true no texto, mas o guard lê false", () => {
  const NAME = "SPEC.md allow_tier3 is read the way it is written";
  const spec = (...linhas: string[]) => ["---", ...linhas, "---", "", "# Spec", ""].join("\n");

  it("o caso do achado (valor que continua na linha seguinte) → WARN com a razão e a linha", () => {
    const r = checkAllowTier3Reading({ specText: spec("tier_defaults:", "  allow_tier3: true", "    true") })!;
    expect(r.name).toBe(NAME);
    expect(r.pass).toBe(true);
    expect(r.warn).toBe(true);
    expect(r.detail).toMatch(/allow_tier3: true/);
    expect(r.detail).toMatch(/reads (it as )?false|lê false/i);
    expect(r.detail).toMatch(/goes on in a more indented line/);
    expect(r.detail).toMatch(/line 4 of SPEC\.md/);
    expect(r.detail).toMatch(/break-glass/);
  });

  it.each([
    ["string de aspas que atravessa linhas (F19)", spec('title: "x', "tier_defaults:", "  allow_tier3: true", '"'), /quoted string or \[ \/ \{ collection that crosses lines/],
    ["tab na indentação (F21)", spec("tier_defaults:", "\tallow_tier3: true"), /a tab in the indentation/],
    ["U+2028 no frontmatter (F20)", spec("tier_defaults:", "  allow_tier3: true", "nota: a\u2028b"), /U\+2028/],
    ["linha de coluna 0 que não é chave", spec("tier_defaults:", "  allow_tier3: true", "texto solto"), /column-0 line that is not/],
    ["tier_defaults duplicado", spec("tier_defaults:", "  allow_tier3: true", "tier_defaults:", "  allow_tier3: true"), /tier_defaults: appears 2 times/],
    ["tier_defaults duplicado com um false depois", spec("tier_defaults:", "  allow_tier3: true", "tier_defaults:", "  allow_tier3: false"), /not the bare (YAML )?boolean/],
    ["a chave sob outro pai", spec("outro:", "  allow_tier3: true"), /no `allow_tier3: true` line directly under/],
  ])("%s → WARN com a razão", (_what, text, reason) => {
    const r = checkAllowTier3Reading({ specText: text })!;
    expect(r).not.toBeNull();
    expect(r.pass).toBe(true);
    expect(r.warn).toBe(true);
    expect(r.detail).toMatch(reason);
  });

  it("um true entre aspas (a string \"true\") → WARN dizendo que não é o booleano", () => {
    const r = checkAllowTier3Reading({ specText: spec("tier_defaults:", '  allow_tier3: "true"') })!;
    expect(r.warn).toBe(true);
    expect(r.detail).toMatch(/not the bare (YAML )?boolean/);
  });

  it.each([
    ["o flag ligado e lido como ligado", spec("tier_defaults:", "  allow_tier3: true")],
    ["o flag desligado", spec("tier_defaults:", "  allow_tier3: false")],
    ["sem a chave", spec("title: x")],
    ["o texto só em comentário", spec("# allow_tier3: true", "tier_defaults:", "  allow_tier3: false")],
    ["sem frontmatter", "# Spec\n\nallow_tier3: true\n"],
    ["sem SPEC.md", null],
    ["texto vazio", ""],
  ])("%s → nada a avisar (null)", (_what, text) => {
    expect(checkAllowTier3Reading({ specText: text as string | null })).toBeNull();
  });

  it("o corpo do SPEC fora do frontmatter não conta (um allow_tier3: true num exemplo de documentação)", () => {
    const text = `${spec("tier_defaults:", "  allow_tier3: false")}\n\`\`\`yaml\ntier_defaults:\n  allow_tier3: true\n\`\`\`\n`;
    expect(checkAllowTier3Reading({ specText: text })).toBeNull();
  });
});

// AITEAM_UPSTREAM no `env` do settings: a isenção do ASK no código do próprio gate é só do rb-ai-team. Um projeto
// nascido do "Use this template" copia o settings.json inteiro e a herdaria; o install não remove chave que não
// escreveu. O aviso é para o humano — a proteção real é o ASK na edição do settings.json.
describe("checkUpstreamFlag — a variável do upstream num repo que não é o upstream", () => {
  const ON = { env: { AITEAM_UPSTREAM: "1" }, hooks: {} };

  it.each([
    ["sem env nenhum", { permissions: {} }, null],
    ["env sem a variável", { env: { OUTRA: "1" } }, null],
    ["a variável desligada (0)", { env: { AITEAM_UPSTREAM: "0" } }, null],
    ["a variável vazia", { env: { AITEAM_UPSTREAM: "" } }, null],
    ["settings ilegível (null)", null, null],
    ["env que não é objeto", { env: "AITEAM_UPSTREAM=1" }, null],
  ])("%s → nada a dizer (null)", (_what, settings, local) => {
    expect(checkUpstreamFlag({ settings, local, origin: "https://github.com/acme/outro-projeto.git" })).toBeNull();
  });

  it.each([
    ["https://github.com/thiagoriosbraz/rb-ai-team.git"],
    ["https://github.com/thiagoriosbraz/rb-ai-team"],
    ["git@github.com:thiagoriosbraz/rb-ai-team.git"],
    ["https://github.com/qualquer-fork/rb-ai-team/"],
    ["C:\\devops\\source\\rb-ai-team"],
    ["/home/dev/src/RB-AI-TEAM.git"],
  ])("ligada e com origin %s → PASS (é o rb-ai-team)", (origin) => {
    const r = checkUpstreamFlag({ settings: ON, local: null, origin })!;
    expect(r).toMatchObject({ pass: true });
    expect(r.warn).toBeUndefined();
    expect(r.detail).toMatch(/AITEAM_UPSTREAM=1/);
  });

  it.each([
    ["https://github.com/acme/mesa-crm.git"],
    ["git@github.com:acme/rb-ai-team-fork-do-cliente.git"],
    ["https://github.com/acme/meu-rb-ai-team-novo.git"],
    ["https://github.com/rb-ai-team/outro-nome.git"],
    ["https://example.com/rb-ai-team/sub/x.git"],
  ])("ligada e com origin %s → WARN (passa, mas avisa)", (origin) => {
    const r = checkUpstreamFlag({ settings: ON, local: null, origin })!;
    expect(r.pass).toBe(true);
    expect(r.warn).toBe(true);
    expect(r.detail).toContain(origin);
    expect(r.detail).toMatch(/not rb-ai-team/);
    expect(r.detail).toMatch(/remove "AITEAM_UPSTREAM"/);
  });

  it.each([[null], [""], ["   "]])("ligada e sem origin (%j) → WARN", (origin) => {
    const r = checkUpstreamFlag({ settings: ON, local: null, origin })!;
    expect(r.warn).toBe(true);
    expect(r.detail).toMatch(/no origin/);
  });

  it("ligada só no settings.local.json também conta, e o aviso diz onde está", () => {
    const r = checkUpstreamFlag({ settings: { env: {} }, local: ON, origin: "https://github.com/acme/mesa-crm.git" })!;
    expect(r.warn).toBe(true);
    expect(r.detail).toContain(".claude/settings.local.json");
    expect(r.detail).not.toContain(".claude/settings.json and");
    const both = checkUpstreamFlag({ settings: ON, local: ON, origin: null })!;
    expect(both.detail).toContain(".claude/settings.json and .claude/settings.local.json");
  });

  it("o valor numérico 1 conta como ligado (o Claude Code põe o env como string)", () => {
    expect(checkUpstreamFlag({ settings: { env: { AITEAM_UPSTREAM: 1 } }, local: null, origin: null })!.warn).toBe(true);
  });

  it("um WARN não derruba o doctor: o resumo segue passando", () => {
    const r = checkUpstreamFlag({ settings: ON, local: null, origin: null })!;
    expect(summarize([r]).pass).toBe(true);
  });
});
