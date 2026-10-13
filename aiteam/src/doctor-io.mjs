// I/O do `aiteam doctor`: o resíduo do merge driver antigo (o registro no
// .git/config, o .gitattributes da raiz e os caminhos do driver que existem) e o
// mapa de tiers (o arquivo do projeto e a cópia canônica do framework). O
// doctor-core.mjs fica puro; o doctor.mjs executa ao ser importado e não dá para
// testá-lo sobre um repo temporário. Esta cola vive aqui para ser testada de verdade.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { driverPaths, gitattributesCitesDriver, gitattributesMapsDriver, tierRulesPatternEntries } from "./doctor-core.mjs";
import { TEMPLATE_PATH, readTierRulesFile } from "./tier-rules-loader.mjs";

/**
 * Os fatos que o checkMergeDriverResidue pede ao I/O.
 * @param {string} root raiz do repo
 * @returns {{driver: string|null, missing: string[], mapped: boolean, cited: boolean}}
 */
export function readMergeDriverFacts(root) {
  let driver = null;
  try {
    driver = execFileSync("git", ["config", "--get", "merge.beads-yaml.driver"], { cwd: root, encoding: "utf8" }).trim() || null;
  } catch {
    driver = null; // sem registro
  }
  // O git roda o driver na raiz do repo: caminho relativo resolve dali.
  const missing = driverPaths(driver).filter((p) => !existsSync(path.resolve(root, p)));
  // É o mapeamento no .gitattributes que faz o git chamar o driver (o sync manda
  // tirá-lo também em modo legado); e é qualquer `beads-yaml` nele que o contract
  // test reprova — mapeamento ou comentário.
  let attrs = "";
  try {
    attrs = readFileSync(path.join(root, ".gitattributes"), "utf8");
  } catch {
    attrs = ""; // sem .gitattributes na raiz
  }
  return { driver, missing, mapped: gitattributesMapsDriver(attrs), cited: gitattributesCitesDriver(attrs) };
}

/**
 * Os fatos que o checkUpstreamFlag pede ao I/O: o .claude/settings.json e o .claude/settings.local.json (null quando
 * ausentes ou ilegíveis) e a URL do `origin` (null quando não há). Nunca lança.
 * @param {string} root raiz do repo
 * @returns {{settings: object|null, local: object|null, origin: string|null}}
 */
export function readUpstreamFacts(root) {
  const json = (rel) => {
    try {
      const parsed = JSON.parse(readFileSync(path.join(root, rel), "utf8"));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  };
  let origin = null;
  try {
    origin = execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    origin = null; // sem origin, ou sem git
  }
  return { settings: json(".claude/settings.json"), local: json(".claude/settings.local.json"), origin };
}

/**
 * O que o tier-guard decide para um comando, rodado de verdade: o hook num processo
 * filho, no cwd da raiz do projeto (é de lá que ele lê SPEC.md e o mapa), com o payload
 * de PreToolUse da ferramenta dada. Devolve "deny" | "ask" | "allow" ("{}" é allow),
 * ou null quando o hook não respondeu: não existe, saiu sem JSON ou estourou o tempo.
 * Nunca lança. O hook despacha pelo nome da ferramenta, então é o `tool` que decide se
 * um despacho esquecido de uma ferramenta de comando aparece (doctor-core.mjs,
 * checkTierGuardSample).
 *
 * @param {string} root raiz do projeto
 * @param {{hook: string, tool: string, command: string, timeoutMs?: number}} options
 * @returns {"deny"|"ask"|"allow"|null}
 */
export function readTierGuardDecision(root, { hook, tool, command, timeoutMs = 30_000 }) {
  const r = spawnSync(process.execPath, [hook], {
    cwd: root,
    input: JSON.stringify({ tool_name: tool, tool_input: { command } }),
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (r.error || r.status !== 0) return null;
  try {
    const out = JSON.parse(String(r.stdout || "{}"));
    return out?.hookSpecificOutput?.permissionDecision ?? "allow";
  } catch {
    return null;
  }
}

/**
 * O que o gate-edit-guard (F13) decide para uma edição do mapa de tiers, rodado de verdade: o hook num
 * processo filho, com um payload de Write no .claude/tier-rules.json da raiz. O hook nunca escreve nada
 * (só decide), então o arquivo do projeto fica como está. Devolve "ask" | "allow" | "deny" ("{}" é allow),
 * ou null quando o hook não respondeu: não existe, saiu sem JSON ou estourou o tempo. Nunca lança.
 *
 * @param {string} root raiz do projeto
 * @param {{hook: string, timeoutMs?: number}} options
 * @returns {"deny"|"ask"|"allow"|null}
 */
export function readGateEditDecision(root, { hook, timeoutMs = 30_000 }) {
  const r = spawnSync(process.execPath, [hook], {
    cwd: root,
    input: JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: path.join(root, ".claude", "tier-rules.json"), content: "{}" },
      cwd: root,
    }),
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (r.error || r.status !== 0) return null;
  try {
    const out = JSON.parse(String(r.stdout || "{}"));
    return out?.hookSpecificOutput?.permissionDecision ?? "allow";
  } catch {
    return null;
  }
}

/** O filho da sondagem: aiteam/scripts/regex-probe.mjs, resolvido a partir deste módulo. */
const PROBE_SCRIPT = fileURLToPath(new URL("../scripts/regex-probe.mjs", import.meta.url));

// A sondagem do doctor sobe até 4 KB com orçamento de 100 ms. O exponencial (ssh + flags) se
// revela abaixo de 150 bytes, mas o CÚBICO não: o de ssh+shell levava 0,3 ms a 512 bytes e só
// aparece perto dos 3 KB (~190 ms), onde o melhor padrão quadrático legítimo do template custa
// ~10 ms — dez vezes de folga para cada lado. O custo é limitado pelo corte da escada
// (regex-probe.mjs, SETTLE_FROM): o mapa canônico inteiro leva ~2 s, bem abaixo do teto de
// 10 s do filho. Uma medição acima do orçamento é refeita uma vez antes de reprovar.
const DOCTOR_PROBE_OPTIONS = { maxSize: 4096, budgetMs: 100 };

function parseProbeLines(stdout) {
  const lines = [];
  for (const line of String(stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      // linha cortada pela morte do filho: ignora
    }
  }
  return lines;
}

/**
 * A sondagem de ReDoS dos padrões do mapa (aiteam/src/regex-probe.mjs), feita num
 * processo filho para NUNCA pendurar o doctor: um padrão exponencial não termina, e um
 * regex em andamento só se interrompe matando o processo. O filho escreve uma linha ao
 * começar e outra ao terminar cada padrão; se o tempo do filho estoura, o padrão que
 * começou e não terminou é o que travou (vai para `hung`), e a sondagem recomeça no
 * resto. O orçamento total limita o conjunto; o que sobra fica em `unprobed`. Nunca
 * lança: o que deu errado vai em `error`.
 *
 * @param {unknown} rules o mapa parseado (tier3, tier2)
 * @param {{script?: string, timeoutMs?: number, totalMs?: number, probeOptions?: object}} [options]
 *   só os testes trocam o `script`
 * @returns {{probed: number, findings: object[], hung: object[], unprobed: object[], error: string|null}}
 */
export function readTierRulesProbe(
  rules,
  { script = PROBE_SCRIPT, timeoutMs = 10_000, totalMs = 60_000, probeOptions = DOCTOR_PROBE_OPTIONS } = {},
) {
  const facts = { probed: 0, findings: [], hung: [], unprobed: [], error: null };
  let pending = tierRulesPatternEntries(rules);
  const deadline = Date.now() + totalMs;

  while (pending.length > 0) {
    const left = deadline - Date.now();
    if (left <= 0) {
      facts.unprobed.push(...pending);
      break;
    }
    const r = spawnSync(process.execPath, [script], {
      input: JSON.stringify({ entries: pending.map((e) => ({ source: e.source })), options: probeOptions }),
      encoding: "utf8",
      timeout: Math.min(timeoutMs, left),
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });

    let started = -1;
    let finished = 0;
    for (const line of parseProbeLines(r.stdout)) {
      if (typeof line.start === "number") started = line.start;
      if (typeof line.done === "number" && line.result) {
        const entry = pending[line.done];
        finished = Math.max(finished, line.done + 1);
        facts.probed += 1;
        if (entry && line.result.ok === false) {
          const { reason, ms, size, label, previousMs } = line.result;
          facts.findings.push({ ...entry, reason, ms, size, label, previousMs });
        }
      }
    }

    if (r.error?.code === "ETIMEDOUT") {
      if (started === finished && started >= 0 && pending[finished]) {
        // Começou o padrão `finished` e não terminou: é ele que trava.
        facts.hung.push(pending[finished]);
        pending = pending.slice(finished + 1);
        continue;
      }
      facts.error = `o filho da sondagem não respondeu em ${Math.round(timeoutMs / 1000)} s`;
    } else if (r.error) {
      facts.error = `o filho da sondagem não rodou: ${r.error.message}`;
    } else if (r.status !== 0) {
      const why = String(r.stderr ?? "").trim().split("\n").find((l) => l.trim()) ?? "";
      facts.error = `o filho da sondagem saiu com status ${r.status}${why ? `: ${why}` : ""}`;
    } else if (finished < pending.length) {
      facts.error = "o filho da sondagem terminou sem sondar todos os padrões";
    } else {
      pending = [];
      continue;
    }
    facts.unprobed.push(...pending.slice(finished));
    break;
  }
  return facts;
}

/**
 * Os fatos do mapa de tiers que o doctor pede ao I/O: o arquivo do projeto e a
 * cópia canônica do framework, lidos com o mesmo carregador do tier-guard
 * (tier-rules-loader.mjs) — o doctor julga o que o guard enxerga de verdade.
 * @param {string} root raiz do repo (onde fica .claude/)
 * @param {{templatePath?: string}} [options] só os testes trocam o template
 */
export function readTierRulesFacts(root, { templatePath = TEMPLATE_PATH } = {}) {
  return {
    project: readTierRulesFile(path.join(root, ".claude", "tier-rules.json")),
    canonical: readTierRulesFile(templatePath),
  };
}
