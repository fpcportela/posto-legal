#!/usr/bin/env node
// PreToolUse (Write|Edit|MultiEdit|NotebookEdit) — pede confirmação humana (ASK) quando uma edição toca
// um arquivo do GATE de tiers (F13):
//
//   - SPEC.md: o bloco `tier_defaults:` e a chave `allow_tier3` do frontmatter (o break-glass). Uma edição
//     que deixa esse trecho em paz — o texto do Overview, o roadmap — não pergunta nada;
//   - .claude/tier-rules.json: o mapa de padrões Tier 3, em qualquer edição;
//   - .claude/settings.json (e o settings.local.json): `hooks`, `permissions` e as chaves que os desligam
//     (`disableAllHooks`, `env`). As outras chaves (`worktree`...) não perguntam.
//
// O tier-guard classifica o que o agente EXECUTA; estes três arquivos decidem O QUE É o gate, e o agente
// os reescrevia sem ninguém ver. O ASK é a aprovação (decisão do PO): nenhum segundo gate. O comando de
// SHELL que grava nesses arquivos (`sed -i`, `>`, `Set-Content`, `cp`/`mv` por cima, `tee`, `node -e`
// writeFileSync) é visto pelo tier-guard (aiteam/hooks/tier-guard.mjs), com o mesmo núcleo.
//
// A decisão mora em ../src/gate-files-core.mjs (puro, testado); este arquivo é o I/O: lê o payload, lê o
// arquivo ATUAL do disco para saber o que a edição muda, e escreve a decisão. Node puro, sem
// aiteam/node_modules.
//
// NUNCA FALHA ABERTO SOZINHO. Um hook que cai (exit 1 sem JSON) é erro não-bloqueante e a edição passaria.
// O módulo do gate é carregado por import() e todo erro cai no piso: um caminho que parece do gate
// (`.claude/tier-rules.json`, `.claude/settings*.json`, `SPEC.md`) pede confirmação do mesmo jeito, só que
// sem poder dizer o que a edição muda ("could not verify"); qualquer outro arquivo passa, com aviso.

import * as fs from "node:fs";
import * as path from "node:path";

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

// Escrita em fd com writeSync: o processo sai logo depois, e um write assíncrono de pipe que não esvaziou se perde.
function write(fd, text) {
  const buffer = Buffer.from(text);
  let offset = 0;
  for (let attempt = 0; offset < buffer.length && attempt < 200; attempt++) {
    try {
      offset += fs.writeSync(fd, buffer, offset);
    } catch (e) {
      if (e?.code !== "EAGAIN") return;
    }
  }
}

function emit(object) {
  write(1, JSON.stringify(object));
  process.exit(0);
}

const allow = () => emit({});

function ask(reason) {
  emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason } });
}

function warnAllow(message) {
  write(2, `${message}\n`);
  emit({ systemMessage: message });
}

// O caminho que parece do gate, sem o núcleo: o piso quando o módulo não carrega ou lança. Os arquivos do gate por nome
// (o mapa, o settings, o SPEC.md e o MCP) valem em qualquer lugar; o código do guard (aiteam/hooks/*.mjs, aiteam/src/*.mjs e
// o template do mapa) vale num consumidor, e não no upstream (AITEAM_UPSTREAM=1), onde ele é desenvolvido. Sem o núcleo não
// há o fecho dos imports: o piso olha todo .mjs de aiteam/src, um conjunto maior que o do fecho.
const GATE_FILE = /(^|[\\/])(\.claude[\\/](tier-rules|settings(\.local)?)\.json|SPEC\.md|\.mcp\.json|\.cursor[\\/]mcp\.json)$/i;
const GUARD_CODE_FILE = /(^|[\\/])aiteam[\\/](hooks[\\/][^\\/]+\.mjs|src[\\/][^\\/]+\.mjs|templates[\\/]tier-rules\.json)$/i;
const looksLikeGate = (file) => GATE_FILE.test(file) || (process.env.AITEAM_UPSTREAM !== "1" && GUARD_CODE_FILE.test(file));

let target = null; // o caminho da edição, assim que se sabe
let failing = false;

function describe(error) {
  let text;
  try {
    text = String(error?.message ?? error);
  } catch {
    text = "unprintable error";
  }
  return text.replace(/\s+/g, " ").slice(0, 200);
}

function failClosed(error) {
  if (failing) allow();
  failing = true;
  try {
    const why = describe(error);
    if (typeof target === "string" && looksLikeGate(target)) {
      ask(
        `Gate file edit — one-shot human approval required: ${target} (the guard hit an internal error and could not verify what this edit changes: ${why}). ` +
          `Approve in chat to apply it once; headless sessions fail closed. Run node aiteam/scripts/doctor.mjs.`
      );
    }
    warnAllow(`aiteam gate-edit-guard: internal error (${why}); this edit is not of a gate-looking file, so it was let through. Run node aiteam/scripts/doctor.mjs.`);
  } catch {
    allow();
  }
}

process.on("uncaughtException", failClosed);
process.on("unhandledRejection", failClosed);

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin() || "{}");
  } catch {
    return allow();
  }
  const tool = payload?.tool_name;
  if (!EDIT_TOOLS.has(tool)) return allow();
  const input = payload?.tool_input;
  const file = input?.file_path ?? input?.notebook_path;
  if (typeof file !== "string" || file === "") return allow();
  target = file;

  const core = await import("../src/gate-files-core.mjs");
  const cwd = typeof payload?.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  const read = (p) => {
    try {
      return fs.readFileSync(path.resolve(cwd, p), "utf8");
    } catch (e) {
      if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null;
      throw e;
    }
  };
  // Uma raiz de repo do framework: tem .claude/ ou aiteam/ (uma worktree, outro checkout).
  const isFrameworkRoot = (dir) => fs.existsSync(path.join(dir, ".claude")) || fs.existsSync(path.join(dir, "aiteam"));

  // O código do próprio gate (aiteam/hooks, o fecho dos imports deles, o template do mapa): só num consumidor,
  // onde o vendor ninguém edita. No upstream o guard é desenvolvido, e os subagentes em segundo plano não
  // respondem a um ASK. Quem diz que é o upstream é a variável AITEAM_UPSTREAM=1, posta pelo `env` do
  // .claude/settings.json do próprio rb-ai-team (arquivo que é gate, e que o install nunca escreve num consumidor):
  // não um arquivo que o agente possa criar.
  const guardCode = core.guardCodeMatcher(
    cwd,
    {
      exists: (p) => fs.existsSync(p),
      read: (p) => {
        try {
          return fs.readFileSync(p, "utf8");
        } catch {
          return null;
        }
      },
      list: (dir) => {
        try {
          return fs.readdirSync(dir);
        } catch {
          return [];
        }
      },
    },
    { upstream: process.env.AITEAM_UPSTREAM === "1" }
  );

  let verdict = core.gateEditVerdict({ tool, input, read, cwd, isFrameworkRoot, guardCode });
  // O caminho REAL: um symlink ou uma junction para um arquivo do gate não pode escondê-lo. A edição que
  // o Claude Code faz cai no arquivo para onde o link aponta, então é ele que se classifica também.
  if (!verdict) {
    const real = realTarget(cwd, file);
    if (real !== null) verdict = core.gateEditVerdict({ tool, input: { ...input, file_path: real }, read, cwd, isFrameworkRoot, guardCode });
  }
  if (verdict) return ask(core.gateEditReason(verdict));
  return allow();
}

// O caminho do alvo depois de seguir symlinks e junctions: o do próprio arquivo, ou — quando ele ainda não
// existe — o do pai mais próximo que existe, com o resto do caminho por cima. null quando nada resolve.
function realTarget(cwd, file) {
  let probe = path.resolve(cwd, file);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(probe), ...rest.slice().reverse());
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      rest.push(path.basename(probe));
      probe = parent;
    }
  }
}

main().catch(failClosed);
