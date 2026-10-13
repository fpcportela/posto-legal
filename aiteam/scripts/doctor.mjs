#!/usr/bin/env node
// aiteam doctor — read-only health check that the framework is wired into the
// host AND is not interfering with it. Prints PASS/FAIL for each wiring point.
// Performs NO mutations. Exit 0 if everything passes, 1 otherwise.
//
//   node aiteam/scripts/doctor.mjs        (or: npm --prefix aiteam run doctor)
//
// Plain Node (no tsx/deps) so it runs even when the toolchain is half-installed.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkSettings,
  checkInfraKbGuardSettings,
  checkGateEditGuardSettings,
  checkGateEditSample,
  checkUpstreamFlag,
  checkMcp,
  checkCiContract,
  checkDeployContract,
  checkTierRulesFile,
  checkTierRulesCoverage,
  checkTierRulesRegexSafety,
  checkAllowTier3Reading,
  checkTierGuardSample,
  TIER_GUARD_SAMPLE_TOOLS,
  checkHooksPath,
  checkBeadsValidation,
  checkInfraKb,
  summarize,
} from "../src/doctor-core.mjs";
import { CHAINED_HOOKS, resolveHookPath } from "../src/install-core.mjs";
import { checkBeadsModel, checkMergeDriverResidue, checkBeadsGuardSettings } from "../src/doctor-core.mjs";
import { readGateEditDecision, readMergeDriverFacts, readTierGuardDecision, readTierRulesFacts, readTierRulesProbe, readUpstreamFacts } from "../src/doctor-io.mjs";
import { isLegacy } from "../src/beads-io.mjs";
import { diagnosePointer } from "../src/infra-kb-core.mjs";
import { isAppManifest } from "../src/ci-contract-core.mjs";
import { checkSuperpowers, readSuperpowersFacts } from "../src/doctor-superpowers.mjs";
import { checkRootFilesUpstream } from "../src/root-files-core.mjs";
import { readRootFilesFacts } from "../src/root-files-io.mjs";

const here = path.dirname(fileURLToPath(import.meta.url)); // aiteam/scripts
const aiteam = path.resolve(here, ".."); // aiteam

function repoRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: aiteam,
      encoding: "utf8",
    }).trim();
  } catch {
    return process.cwd();
  }
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

const root = repoRoot();
const results = [];

results.push({
  name: "repoRoot() resolves (git toplevel)",
  pass: Boolean(root) && existsSync(root),
  detail: `repo root = ${root}`,
});

const settings = readJson(path.join(root, ".claude", "settings.json"));
results.push(
  settings
    ? checkSettings(settings)
    : { name: ".claude/settings.json PreToolUse tier-guard", pass: false, detail: "settings.json missing/unreadable" }
);
results.push(
  settings
    ? checkInfraKbGuardSettings(settings)
    : { name: ".claude/settings.json PreToolUse infra-kb-guard", pass: false, detail: "settings.json missing/unreadable" }
);

// F13: o hook que pede confirmação na edição dos arquivos do gate, ligado nas quatro ferramentas de edição.
results.push(
  settings
    ? checkGateEditGuardSettings(settings)
    : { name: ".claude/settings.json PreToolUse gate-edit-guard", pass: false, detail: "settings.json missing/unreadable" }
);

// AITEAM_UPSTREAM no env do settings: a isenção do ASK no código do próprio gate é só do rb-ai-team. Um projeto
// nascido do template copia o settings.json inteiro e a herdaria; o aviso é para o humano (a proteção real é o ASK
// na edição do settings.json, e a URL do origin pode ser forjada).
{
  const upstream = checkUpstreamFlag(readUpstreamFacts(root));
  if (upstream) results.push(upstream);
}

const mcp = readJson(path.join(root, ".mcp.json"));
results.push(
  mcp ? checkMcp(mcp) : { name: ".mcp.json server entry", pass: false, detail: ".mcp.json missing/unreadable" }
);

// O mapa de tiers do projeto e a cópia canônica do framework, lidos com o mesmo
// carregador do guard (a leitura vive em doctor-io.mjs, testada num repo
// temporário). Ausente ou ilegível o guard protege pela cópia canônica, e aqui
// reprova; o WARN lista os padrões Tier 3 da canônica que o projeto não tem.
const tierFacts = readTierRulesFacts(root);
results.push(checkTierRulesFile(tierFacts));
{
  const coverage = checkTierRulesCoverage(tierFacts);
  if (coverage) results.push(coverage);
}
// ReDoS: o guard roda cada padrão contra o comando inteiro e o timeout de um hook é falha
// aberta. A sondagem roda num processo filho com timeout (readTierRulesProbe), então um
// padrão exponencial no arquivo do projeto vira WARN nomeando o padrão, nunca um doctor travado.
if (tierFacts.project.rules) {
  const regexSafety = checkTierRulesRegexSafety({
    project: tierFacts.project,
    probe: readTierRulesProbe(tierFacts.project.rules),
  });
  if (regexSafety) results.push(regexSafety);
}

// O break-glass escrito x o break-glass lido (A2/F19): um SPEC.md que diz `allow_tier3: true` num
// formato que o leitor por linhas do guard recusa deixa o flag DESLIGADO em silêncio. Só aparece
// quando o texto diz true e o guard lê false.
{
  let specText = null;
  try {
    specText = readFileSync(path.join(root, "SPEC.md"), "utf8");
  } catch {
    /* sem SPEC.md: nada a comparar */
  }
  const reading = checkAllowTier3Reading({ specText });
  if (reading) results.push(reading);
}

let hooksPath = "";
try {
  hooksPath = execFileSync("git", ["config", "--get", "core.hooksPath"], { cwd: root, encoding: "utf8" }).trim();
} catch {
  /* unset */
}
// Router topology: the host keeps its own hooksPath and install chains the
// framework hooks into it, so the config never names aiteam/githooks. Find the
// chain line ourselves — the check stays pure and just judges what we found.
const chainedHooks = hooksPath
  ? CHAINED_HOOKS.filter((hook) => {
      try {
        return readFileSync(resolveHookPath(root, hooksPath, hook), "utf8").includes(`aiteam/githooks/${hook}`);
      } catch {
        return false; // missing/unreadable host hook — simply not chained
      }
    })
  : [];
results.push(checkHooksPath(hooksPath, chainedHooks, CHAINED_HOOKS));

// CI de PR × bloco ci: do SPEC.md (rb-ai-team#31): o mesmo contrato do
// aiteam/src/ci-contract.test.ts, pelo mesmo núcleo. O bloco e os package.json
// são lidos sem pacote; os workflows precisam do js-yaml, e sem ele só essa
// parte degrada para WARN, como o validate:beads sem tsx.
{
  let specText = null;
  try {
    specText = readFileSync(path.join(root, "SPEC.md"), "utf8");
  } catch {
    /* sem SPEC.md: o núcleo reprova */
  }
  const readScripts = (dir) => {
    try {
      const scripts = JSON.parse(readFileSync(path.join(root, dir, "package.json"), "utf8"))?.scripts;
      return scripts && typeof scripts === "object" ? scripts : {};
    } catch {
      return null; // sem package.json nesse diretório
    }
  };
  let workflows = null;
  let workflowsUnavailable = null;
  try {
    const { load } = await import("js-yaml");
    const dir = path.join(root, ".github", "workflows");
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)) : [];
    workflows = files.map((file) => {
      try {
        return { file, doc: load(readFileSync(path.join(dir, file), "utf8")) };
      } catch (e) {
        return { file, error: String(e?.reason ?? e?.message ?? e) };
      }
    });
  } catch {
    workflowsUnavailable = "js-yaml indisponível (aiteam/node_modules ausente) — rode: cd aiteam && npm install";
  }
  // Manifesto de app na raiz + ci.workdir dentro de aiteam/ = o framework
  // declarado no lugar da app (o clone-template herda o workdir deste repo).
  let rootManifests = [];
  try {
    rootManifests = readdirSync(root).filter(isAppManifest);
  } catch {
    /* raiz ilegível: nada a comparar */
  }
  results.push(checkCiContract({ specText, workflows, readScripts, workflowsUnavailable, rootManifests }));
}

// Deploy × bloco deploy: do SPEC.md (rb-ai-team#32): o mesmo contrato do
// aiteam/src/deploy-contract.test.ts, pelo mesmo núcleo — responde ao passo 1
// do Release Loop (a pipeline aceita a ref e o health check confere a versão?).
// Bloco próprio, com a própria leitura dos workflows, para não acoplar ao do
// ci: acima; sem js-yaml, só a conferência do workflow degrada para WARN.
{
  let specText = null;
  try {
    specText = readFileSync(path.join(root, "SPEC.md"), "utf8");
  } catch {
    /* sem SPEC.md: o núcleo reprova */
  }
  // Os scripts do repo que um passo chama; nunca fora da raiz.
  const readFile = (rel) => {
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(path.resolve(root) + path.sep)) return null;
    try {
      return readFileSync(abs, "utf8");
    } catch {
      return null;
    }
  };
  let workflows = null;
  let workflowsUnavailable = null;
  try {
    const { load } = await import("js-yaml");
    const dir = path.join(root, ".github", "workflows");
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)) : [];
    workflows = files.map((file) => {
      try {
        return { file, doc: load(readFileSync(path.join(dir, file), "utf8")) };
      } catch (e) {
        return { file, error: String(e?.reason ?? e?.message ?? e) };
      }
    });
  } catch {
    workflowsUnavailable = "js-yaml indisponível (aiteam/node_modules ausente) — rode: cd aiteam && npm install";
  }
  results.push(checkDeployContract({ specText, workflows, readFile, workflowsUnavailable }));
}

// Arquivos de raiz que o framework distribui × o upstream (rb-ai-team#39). O ADR 0002 os deixa fora
// do aiteam/, então o sync escopado não os alcança e nada os conferia (o .beads/SCHEMA.md de um
// consumidor ficou quase três meses atrás sem ninguém ver). Só leitura e sem rede: compara com as
// refs que o clone JÁ tem (upstream/main, ou a default do remote) e nunca roda fetch. Todo achado
// é WARN, porque a customização de um arquivo de raiz é legítima. O que já tem conferência acima
// (.claude/tier-rules.json, settings.json, .mcp.json, os blocos ci:/deploy:) não se repete.
// A leitura vive em root-files-io.mjs, testada num repo temporário com um remote upstream local.
{
  let yamlLoad = null;
  try {
    ({ load: yamlLoad } = await import("js-yaml"));
  } catch {
    /* sem js-yaml só a comparação do CI de PR degrada; a leitura diz por quê */
  }
  try {
    results.push(...checkRootFilesUpstream(readRootFilesFacts(root, { yamlLoad })));
  } catch (e) {
    // Uma comparação secundária nunca derruba o diagnóstico inteiro (nem reprova): diz o que houve.
    results.push({
      name: "upstream do rb-ai-team (arquivos de raiz)",
      pass: true,
      warn: true,
      detail: `não deu para comparar os arquivos de raiz com o upstream: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

// infra_kb: o slot é opcional por design, então a ausência dele PASSA. Usa
// diagnosePointer (não readPointer) porque só o doctor precisa distinguir
// "sem slot nenhum" de "slot presente e malformado" — os hooks continuam
// colapsando as duas em null via readPointer, sem mudança de comportamento.
let kbDiagnosis = { state: "absent" };
try {
  const { load } = await import("js-yaml");
  kbDiagnosis = diagnosePointer(readFileSync(path.join(root, "SPEC.md"), "utf8"), load);
} catch {
  kbDiagnosis = { state: "absent" };
}
const kbPointer = kbDiagnosis.state === "ok" ? kbDiagnosis.pointer : null;
const kbMalformedReason = kbDiagnosis.state === "malformed" ? kbDiagnosis.reason : null;
let kbRemoteExists = null; // null = git error / couldn't check; false = git works but remote not found; true = remote exists
let kbAgeDays = null;
if (kbPointer) {
  // First: try to run git remote. Failure = git not available or not a git repo (remoteExists = null).
  try {
    const remotes = execFileSync("git", ["remote"], { cwd: root, encoding: "utf8" });
    kbRemoteExists = remotes.split(/\r?\n/).some((r) => r.trim() === kbPointer.remote);
  } catch {
    // git itself failed (not installed, not a repo)
    kbRemoteExists = null;
  }

  // Second: only if remote exists, try to get its age.
  if (kbRemoteExists === true) {
    try {
      const iso = execFileSync("git", ["log", "-1", "--format=%cI", `${kbPointer.remote}/${kbPointer.ref}`], {
        cwd: root,
        encoding: "utf8",
      }).trim();
      kbAgeDays = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
    } catch {
      // ref not fetched or other git log failure: keep ageDays null, the check treats it as "age unknown".
    }
  }
}
results.push(
  checkInfraKb({ pointer: kbPointer, remoteExists: kbRemoteExists, ageDays: kbAgeDays, malformedReason: kbMalformedReason })
);

// .beads: modelo por bead, modo legado e o resíduo do merge driver antigo no
// .git/config compartilhado (os hooks não o removem; só o doctor avisa).
{
  const legacy = isLegacy(root);
  results.push(checkBeadsModel({ legacy }));
  // O registro, o .gitattributes e os caminhos do driver: a leitura vive em
  // doctor-io.mjs, testada num repo temporário (doctor-io.test.ts).
  const facts = readMergeDriverFacts(root);
  results.push(checkMergeDriverResidue({ legacy, ...facts }));
  if (settings) results.push(checkBeadsGuardSettings(settings));
}

// Dynamic: validate:beads passes (proves repoRoot anchoring + schema conformance).
// beads-check roda em node puro com o js-yaml vendorizado: não depende de
// aiteam/node_modules, então o "toolchain" é o próprio node que roda o doctor.
{
  const script = path.join(aiteam, "scripts", "beads-check.mjs");
  const r = spawnSync(process.execPath, [script, "--all", "--quiet"], { cwd: root, encoding: "utf8" });
  const output = (r.stdout || "") + (r.stderr || "");
  results.push(checkBeadsValidation({ toolchainPresent: true, status: r.status, output }));
}

// Dynamic: the live tier-guard denies a sample destructive Tier-3 command and asks for a sample
// deploy — through EACH command tool (Bash and PowerShell): the hook dispatches by tool name, so
// a sample through Bash alone cannot see a stale hook copy that forgot PowerShell (issue #12).
{
  const hook = path.join(aiteam, "hooks", "tier-guard.mjs");
  const sample = (command) =>
    Object.fromEntries(TIER_GUARD_SAMPLE_TOOLS.map((tool) => [tool, readTierGuardDecision(root, { hook, tool, command })]));
  const destructive = "prisma migrate reset";
  const deploy = "npx prisma migrate deploy";
  results.push(checkTierGuardSample({ expected: "deny", command: destructive, decisions: sample(destructive) }));
  results.push(checkTierGuardSample({ expected: "ask", command: deploy, decisions: sample(deploy) }));
}

// Dynamic (F13): the live gate-edit-guard asks before a Write to .claude/tier-rules.json. The hook only
// decides — it writes nothing — so the project's file is left as it is.
{
  const hook = path.join(aiteam, "hooks", "gate-edit-guard.mjs");
  results.push(checkGateEditSample({ decision: readGateEditDecision(root, { hook }) }));
}

// O plugin superpowers (rb-ai-team#51): versão instalada e se está ligado, só
// leitura, dentro de ~/.claude (ou do CLAUDE_CONFIG_DIR) e do repo. INFO ou WARN, nunca FAIL; sem o que ler,
// sem linha (a leitura vive em doctor-superpowers.mjs, testada em dirs temporários).
{
  const superpowers = checkSuperpowers({ ...readSuperpowersFacts({ root }), platform: process.platform });
  if (superpowers) results.push(superpowers);
}

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
console.log("aiteam doctor — framework wiring + non-interference check\n");
for (const r of results) {
  // A warn passes (doesn't flip the exit code) but renders distinctly so the
  // hazard isn't lost in a sea of green. An info passes too and only informs.
  const tag = !r.pass
    ? `${RED}FAIL${RESET}`
    : r.warn
      ? `${YELLOW}WARN${RESET}`
      : r.info
        ? `${CYAN}INFO${RESET}`
        : `${GREEN}PASS${RESET}`;
  console.log(`  [${tag}] ${r.name}`);
  if (r.detail) console.log(`         ${r.detail}`);
}
const s = summarize(results);
console.log(
  `\n${s.pass ? `${GREEN}✓ all checks passed${RESET}` : `${RED}✗ ${s.failed}/${s.total} checks failed${RESET}`} (${s.passed}/${s.total} passed)`
);
process.exit(s.pass ? 0 : 1);
