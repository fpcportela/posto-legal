import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { classifyTier, isAskEligibleTier3, loadTierRules, loadTierRulesResolved } from "./tier-classifier.js";
import { explainDeny } from "./tier-core.mjs";

const rules = loadTierRules();

describe("classifyTier — Tier 3 (critical / destructive / production)", () => {
  it.each([
    ["vercel --prod --yes", "production deploy"],
    ["railway up --environment production --detach", "railway prod"],
    ["npx prisma migrate deploy", "prod migration"],
    ["npx prisma migrate reset --force", "destructive reset"],
    ["rm -rf build", "recursive force delete"],
    ["git push --force origin main", "force push"],
    ["psql -c 'DROP TABLE users'", "drop table"],
  ])("classifies %j as Tier 3 (%s)", (cmd) => {
    expect(classifyTier(cmd, rules)).toBe(3);
  });
});

describe("classifyTier — Tier 2 (moderate / local mutations)", () => {
  it.each([
    ["git commit -m 'fix'", "commit"],
    ["git push origin feature", "non-force push"],
    ["git push --force-with-lease origin main", "lease push stays moderate"],
    ["npm install zod", "install"],
    ["npm ci", "clean install"],
    ["npx prisma migrate dev", "dev migration"],
    ["vercel --yes", "preview deploy"],
    ["railway up --detach", "preview deploy"],
  ])("classifies %j as Tier 2 (%s)", (cmd) => {
    expect(classifyTier(cmd, rules)).toBe(2);
  });
});

describe("classifyTier — Tier 1 (free / read-only)", () => {
  it.each([
    ["ls -la", "list"],
    ["git status", "status"],
    ["npm run test", "run script"],
    ["npx vitest run", "tests"],
    ["cat README.md", "read"],
  ])("classifies %j as Tier 1 (%s)", (cmd) => {
    expect(classifyTier(cmd, rules)).toBe(1);
  });
});

describe("classifyTier — inert leading command does not over-match (retro fix)", () => {
  it.each([
    ['echo "deploying with vercel --prod"', "echo a Tier-3 string"],
    ["printf 'rm -rf /tmp/x'", "printf a destructive string"],
    [": vercel --prod", "no-op with Tier-3 args"],
  ])("classifies %j as Tier 1 (%s)", (cmd) => {
    expect(classifyTier(cmd, rules)).toBe(1);
  });

  it("still flags a real executor of a quoted Tier-3 payload", () => {
    // psql/bash EXECUTE their quoted arg — unlike echo — so they stay Tier 3.
    expect(classifyTier("psql -c 'DROP TABLE users'", rules)).toBe(3);
    expect(classifyTier('bash -c "rm -rf /"', rules)).toBe(3);
  });
});

describe("classifyTier — split flags and chaining do not under-match", () => {
  it.each([
    ["rm -r -f build", "recursive+force as separate short flags"],
    ["rm --recursive --force build", "recursive+force as long flags"],
    ["npm run lint && rm -rf dist", "Tier-3 after &&"],
    ["git status; git push --force origin main", "force push after ;"],
    ["echo hi | xargs rm -rf", "destructive after a pipe"],
  ])("classifies %j as Tier 3 (%s)", (cmd) => {
    expect(classifyTier(cmd, rules)).toBe(3);
  });

  it("does not flag a benign pipeline", () => {
    expect(classifyTier("cat file.txt | grep token | wc -l", rules)).toBe(1);
  });

  it("keeps an interactive recursive delete without force out of Tier 3", () => {
    // Parity with the existing policy: only recursive AND force is Tier 3.
    expect(classifyTier("rm -i -r builddir", rules)).toBe(1);
  });
});

describe("loadTierRules", () => {
  it("loads tier3 and tier2 pattern lists from the canonical JSON", () => {
    expect(rules.tier3.patterns.length).toBeGreaterThan(0);
    expect(rules.tier2.patterns.length).toBeGreaterThan(0);
  });
});

// O mesmo carregamento do tier-guard (tier-rules-loader.mjs): sem o
// .claude/tier-rules.json do projeto, ou com um que não serve, a cópia canônica
// do framework entra no lugar — nunca um mapa vazio que classifica tudo como Tier 1.
describe("loadTierRules — projeto sem o mapa de tiers (RB_REPO_ROOT aponta para um repo descartável)", () => {
  const savedRoot = process.env["RB_REPO_ROOT"];
  const dirs: string[] = [];
  afterEach(() => {
    if (savedRoot === undefined) delete process.env["RB_REPO_ROOT"];
    else process.env["RB_REPO_ROOT"] = savedRoot;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function projectWith(rulesText: string | null): void {
    const dir = mkdtempSync(path.join(tmpdir(), "tier-classifier-"));
    dirs.push(dir);
    if (rulesText !== null) {
      mkdirSync(path.join(dir, ".claude"));
      writeFileSync(path.join(dir, ".claude", "tier-rules.json"), rulesText);
    }
    process.env["RB_REPO_ROOT"] = dir;
  }

  it("arquivo ausente → a cópia canônica, e ela classifica de verdade", () => {
    projectWith(null);
    const resolved = loadTierRulesResolved();
    expect(resolved.source).toBe("framework");
    expect(resolved.problem).toBe("missing");
    const fallback = loadTierRules();
    expect(classifyTier("rm -rf /", fallback)).toBe(3);
    expect(isAskEligibleTier3("rm -rf /", fallback)).toBe(false);
    expect(isAskEligibleTier3("npx prisma migrate deploy", fallback)).toBe(true);
  });

  it.each([
    ["JSON inválido", "{ nope"],
    ["estrutura inválida", JSON.stringify({ tier3: { patterns: "x" } })],
  ])("arquivo ilegível (%s) → a cópia canônica", (_label, text) => {
    projectWith(text);
    expect(loadTierRulesResolved()).toMatchObject({ source: "framework", problem: "unreadable" });
    expect(classifyTier("rm -rf /", loadTierRules())).toBe(3);
  });

  it("arquivo válido → o do projeto, sem aviso", () => {
    const own = { tier3: { label: "t3", patterns: ["\\bmeu-marcador\\b"] }, tier2: { label: "t2", patterns: [] } };
    projectWith(JSON.stringify(own));
    expect(loadTierRulesResolved()).toEqual({ rules: own, source: "project", problem: null, detail: null });
    expect(loadTierRules()).toEqual(own);
  });
});

describe("isAskEligibleTier3 — deploy subset é aprovável via chat", () => {
  const RULES = {
    tier3: {
      label: "t3",
      patterns: [
        "vercel\\s+.*--prod\\b",
        "\\bgh\\s+workflow\\s+run\\s+\\S*deploy",
        "\\bdrop\\s+(table|database)\\b",
      ],
      ask_patterns: ["vercel\\s+.*--prod\\b", "\\bgh\\s+workflow\\s+run\\s+\\S*deploy"],
    },
    tier2: { label: "t2", patterns: ["\\bgit\\s+commit\\b"] },
  };

  it("deploy puro é ask-eligible", () => {
    expect(isAskEligibleTier3("vercel --prod --yes", RULES)).toBe(true);
    expect(isAskEligibleTier3("gh workflow run deploy.yml --ref main", RULES)).toBe(true);
    expect(isAskEligibleTier3("gh workflow run prod-deploy.yml", RULES)).toBe(true);
  });

  it("tier-3 destrutivo NAO é ask-eligible", () => {
    expect(isAskEligibleTier3("drop table users", RULES)).toBe(false);
    expect(isAskEligibleTier3("rm -rf build", RULES)).toBe(false);
    expect(isAskEligibleTier3("git push --force origin main", RULES)).toBe(false);
  });

  it("comando misto deploy+destrutivo NAO é ask-eligible (deny vence)", () => {
    expect(isAskEligibleTier3("vercel --prod && rm -rf /", RULES)).toBe(false);
    expect(isAskEligibleTier3("lint && vercel --prod && drop table x", RULES)).toBe(false);
  });

  it("sub-comando via $( ) conta", () => {
    expect(isAskEligibleTier3('echo "$(rm -rf /)" && vercel --prod', RULES)).toBe(false);
  });

  it("comando sem nenhum tier-3 retorna false (não há o que aprovar)", () => {
    expect(isAskEligibleTier3("git commit -m x", RULES)).toBe(false);
  });

  it("rules legado sem ask_patterns → false (fail closed)", () => {
    const legacy = { tier3: { label: "t3", patterns: RULES.tier3.patterns }, tier2: RULES.tier2 };
    expect(isAskEligibleTier3("vercel --prod", legacy)).toBe(false);
  });

  it("gh workflow run de workflow NAO-deploy não é tier 3", () => {
    expect(classifyTier("gh workflow run ci.yml", RULES)).toBeLessThan(3);
  });
});

describe("tier-rules.json real — invariantes do arquivo", () => {
  const real = loadTierRules();

  it("ask_patterns é subconjunto de tier3.patterns (união protege leitores legados)", () => {
    const union = new Set(real.tier3.patterns);
    for (const p of real.tier3.ask_patterns ?? []) {
      expect(union.has(p), `ask_pattern fora da união: ${p}`).toBe(true);
    }
  });

  it("padrões de deploy do arquivo real classificam como tier 3 e ask-eligible", () => {
    for (const cmd of [
      "gh workflow run deploy.yml --ref main",
      "vercel --prod",
      "prisma migrate deploy",
    ]) {
      expect(classifyTier(cmd, real)).toBe(3);
      expect(isAskEligibleTier3(cmd, real)).toBe(true);
    }
  });

  it("prisma migrate reset continua deny-only no arquivo real", () => {
    expect(classifyTier("prisma migrate reset", real)).toBe(3);
    expect(isAskEligibleTier3("prisma migrate reset", real)).toBe(false);
  });

  // Política revista em 2026-07-29 (issue #13): quando a pipeline versionada
  // fica indisponível, um projeto em produção não pode ficar sem NENHUMA via de
  // deploy. O deploy direto por SSH deixa de ser deny e passa a exigir ASK —
  // aprovação humana por comando, no chat. Segue Tier 3; o que muda é a porta.
  //
  // O ganho não é só ter saída: antes, um agente diante da pipeline caída era
  // empurrado para pedir `allow_tier3` no SPEC.md — um break-glass GLOBAL que
  // destrava também `rm -rf` e `drop table`. Agora existe caminho escopado que
  // não desliga o gate inteiro.
  it("SSH + deploy é Tier 3 ASK-eligible no arquivo real", () => {
    for (const cmd of [
      'ssh deploy@vps "docker compose up -d --build"',
      "ssh vps systemctl restart app",
      "ssh vps sudo service nginx restart",
      'ssh vps "kubectl apply -f k8s/"',
      // o comando exato do incidente do trabalhista (2026-07-25)
      "ssh root@vps 'SSH_ORIGINAL_COMMAND=main bash /opt/trabalhista/scripts/deploy.sh'",
      "ssh vps bash /opt/app/scripts/deploy.sh",
      "ssh deploy@vps sh ./release.sh",
      "ssh root@vps /opt/app/deploy.sh", // script executado direto, sem interpretador
      'ssh vps "npm run deploy"',
      "ssh vps make deploy",
    ]) {
      expect(classifyTier(cmd, real), cmd).toBe(3);
      expect(isAskEligibleTier3(cmd, real), cmd).toBe(true);
    }
  });

  // O pedido foi deploy, não controle de máquina. Reiniciar ou desligar o host
  // não é deploy e continua exigindo o break-glass — um prompt de ASK é barato
  // demais para derrubar produção inteira.
  it("SSH + controle de host continua deny-only (reboot/shutdown não é deploy)", () => {
    for (const cmd of ["ssh vps reboot", "ssh vps shutdown -h now", "ssh vps poweroff"]) {
      expect(classifyTier(cmd, real), cmd).toBe(3);
      expect(isAskEligibleTier3(cmd, real), cmd).toBe(false);
    }
  });

  // A propriedade que segura a mudança: deny vence numa cadeia mista. Abrir o
  // deploy por SSH não pode virar carona para um destrutivo no mesmo comando.
  it("deploy por SSH encadeado com destrutivo NÃO é ask-eligible", () => {
    for (const cmd of [
      'ssh vps "docker compose up -d && rm -rf /var/lib/data"',
      "ssh vps bash /opt/app/deploy.sh && ssh vps reboot",
      'ssh vps "npm run deploy" && drop table users',
    ]) {
      expect(isAskEligibleTier3(cmd, real), cmd).toBe(false);
    }
  });

  it("NÃO pega infra LOCAL nem comando remoto read-only (o `ssh` é obrigatório)", () => {
    for (const cmd of [
      "docker compose up -d", // local — denyar isso quebraria dev
      "systemctl status app", // local
      "ssh vps ls -la", // remoto, mas sem verbo de infra
      'ssh vps "cat /var/log/app.log"', // remoto read-only
      "ssh vps cat /opt/app/scripts/deploy.sh", // LER o script de deploy é read-only
      "ssh vps tail -f /var/log/deploy.log",
      "bash scripts/deploy.sh", // local — o `ssh` continua obrigatório
    ]) {
      expect(classifyTier(cmd, real), cmd).toBeLessThan(3);
    }
  });

  it("BYPASS: SSH+infra encadeado depois de um comando inócuo ainda é Tier 3", () => {
    expect(classifyTier("npm run lint && ssh vps docker compose up -d", real)).toBe(3);
  });

  // Issue #12: o guard passou a ver a ferramenta PowerShell, mas as regras só
  // conheciam a sintaxe do bash. Remoção recursiva E forçada no PowerShell
  // (Remove-Item e aliases, qualquer prefixo não ambíguo dos parâmetros, em
  // qualquer ordem) e o `rd /s /q` do cmd.exe são deny-only — nunca ask.
  it("remoção recursiva e forçada do PowerShell/cmd é Tier 3 deny-only no arquivo real", () => {
    for (const cmd of [
      "Remove-Item -Recurse -Force .\\dist",
      "Remove-Item .\\dist -Force -Recurse",
      "remove-item -force -recurse C:\\temp\\x",
      "Remove-Item -Path build -Recurse -Force",
      "Remove-Item -r -fo build",
      "Remove-Item -Rec -Forc build",
      "Remove-Item -Recurse:$true -Force build",
      "Microsoft.PowerShell.Management\\Remove-Item -Recurse -Force build",
      "ri -r -fo build",
      "rm -Recurse -Force build",
      "del -Force -Recurse build",
      "erase -recurse -force build",
      "rd -Recurse -Force build",
      "rmdir -Force -Recurse build",
      "Get-ChildItem build | Remove-Item -Recurse -Force",
      "rd /s /q build",
      "rmdir /S /Q build",
      "rd /q /s build",
      "rd /s/q build",
      'cmd /c "rd /s /q build"',
      'pwsh -Command "Remove-Item -Recurse -Force dist"',
      // del/erase do cmd: /s apaga os arquivos em todas as subpastas e /q
      // suprime a confirmação — o mesmo par do rd (revisão de segurança da #12).
      "del /s /q build",
      "erase /q /s *.tmp",
      "del /s/q build",
      "erase /q/s build",
      "DEL /F /S /Q build",
      'cmd /c "del /s /q build"',
    ]) {
      expect(classifyTier(cmd, real), cmd).toBe(3);
      expect(isAskEligibleTier3(cmd, real), cmd).toBe(false);
    }
  });

  // Issue #12, item 3: a razão do deny vem por classe. O arquivo real entrega
  // a de controle de host por SSH — e ela não pode mandar ligar o break-glass,
  // que é global e destravaria também `rm -rf` e `drop table`.
  it("deny_hints do arquivo real compilam e a de reboot via ssh não sugere o allow_tier3", () => {
    const hints = real.tier3.deny_hints ?? [];
    expect(hints.length).toBeGreaterThan(0);
    for (const h of hints) {
      expect(() => new RegExp(h.match, "i"), h.match).not.toThrow();
      expect(h.hint.trim().length, h.match).toBeGreaterThan(0);
    }
    for (const cmd of ["ssh vps reboot", "ssh root@vps sudo shutdown -h now", 'ssh vps "poweroff"']) {
      const r = explainDeny(cmd, real);
      expect(r.culprit, cmd).toBe(cmd);
      expect(r.hint, cmd).not.toMatch(/allow_tier3/);
    }
  });

  // Paridade com a política do bash: só recursivo E forçado é Tier 3 (`rm -r`
  // sozinho também não é). `-f` sozinho é ambíguo no Remove-Item (-Filter ou
  // -Force), por isso o prefixo mínimo do force é `-fo`.
  it("PowerShell/cmd sem o par recursivo+forçado não é Tier 3", () => {
    for (const cmd of [
      "Remove-Item .\\dist\\app.js",
      "Remove-Item -Recurse .\\dist",
      "Remove-Item -Force .\\dist\\app.js",
      "Remove-Item -Recurse -Filter *.tmp .\\dist",
      "Get-ChildItem -Recurse -Force",
      "Copy-Item -Recurse -Force src dist",
      "rd /s build",
      "rd /q build",
      "rmdir build",
      "git rm -r --cached build",
      "del /s build\\*.log",
      "del /q build.txt",
      "erase /p notes.txt",
      "del build.txt",
    ]) {
      expect(classifyTier(cmd, real), cmd).toBeLessThan(3);
    }
  });
});
