#!/usr/bin/env node
// PreToolUse(Write|Edit) — injeta o extrato da KB de infra quando o agente
// escreve um arquivo que define recurso no host compartilhado.
//
// NÃO é um gate: nunca bloqueia, nunca pede aprovação. O objetivo é ALIMENTAR
// a persona de arquitetura no instante em que ela define o parâmetro, não
// impedi-la. Bloquear aqui produziria falso-positivo em toda edição trivial de
// compose.
//
// Dispara uma vez por sessão (marcador em tmpdir por session_id) — mas só o
// extrato bem-sucedido consome esse tiro único: ele é caro em contexto e não
// muda no meio da sessão. Os avisos (KB inacessível, extract() falhou) NÃO
// marcam — são baratos, e silenciar a próxima edição por causa de um aviso
// transitório contradiria a própria razão do marcador existir.
//
// Casca de I/O — toda a lógica vive em ../src/infra-kb-core.mjs. Mantenha este
// arquivo fora de qualquer import (o shebang mata o módulo sob vite-node).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "node:child_process";
import { readPointer, extract, formatExtract, matchesInfraPath } from "../src/infra-kb-core.mjs";

const REPO = process.cwd();

function silent() {
  process.stdout.write("{}");
  process.exit(0);
}

function git(args, timeout = 10_000) {
  try {
    const r = spawnSync("git", args, { cwd: REPO, encoding: "utf8", timeout });
    return r.status === 0 ? String(r.stdout ?? "") : null;
  } catch {
    return null;
  }
}

function markerPath(sessionId) {
  return path.join(os.tmpdir(), `aiteam-infra-kb-${String(sessionId).replace(/[^\w-]/g, "")}`);
}

// Checagem separada da escrita: quem decide SE isso conta como "já disparou"
// é quem chama, no ponto em que o extrato de verdade está saindo — não aqui.
function hasFiredThisSession(sessionId) {
  // Sem session_id não existe chave estável: tratar como "nunca disparou" (em
  // vez de colapsar em uma chave compartilhada tipo "nosession") evita que
  // duas invocações sem id se silenciem uma à outra sem nunca terem recebido
  // o extrato.
  if (!sessionId) return false;
  try {
    return fs.existsSync(markerPath(sessionId));
  } catch {
    return false;
  }
}

function markFiredThisSession(sessionId) {
  if (!sessionId) return;
  try {
    fs.writeFileSync(markerPath(sessionId), "1");
  } catch {
    // Sem tmpdir gravável preferimos injetar de novo a ficar mudo — repetição
    // é barata, silêncio é a falha que importa.
  }
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    silent();
  }

  const tool = payload?.tool_name;
  if (tool !== "Write" && tool !== "Edit") silent();

  const filePath = payload?.tool_input?.file_path ?? "";
  if (!matchesInfraPath(filePath)) silent();

  let pointer = null;
  try {
    const specText = fs.readFileSync(path.join(REPO, "SPEC.md"), "utf8");
    const { load } = await import("js-yaml");
    pointer = readPointer(specText, load);
  } catch {
    silent();
  }
  if (!pointer) silent();

  const sessionId = payload?.session_id;
  if (hasFiredThisSession(sessionId)) silent();

  const readme = git(["show", `${pointer.remote}/${pointer.ref}:${pointer.entry}`]);
  if (readme === null) {
    // Aviso, não o extrato — não marca o tiro único: a próxima edição na
    // mesma sessão ainda deve tentar de novo depois que a KB voltar a ser
    // acessível (ex.: o agente rodou o `git fetch` que este aviso pediu).
    emit(
      `⚠️ KB de infra (${pointer.remote}) inacessível — não consegui ler ${pointer.entry}. ` +
        `Você está editando ${filePath}, que define recurso no host compartilhado. ` +
        `Rode \`git fetch ${pointer.remote} ${pointer.ref}\` e leia o registro antes de fixar porta ou limite.`
    );
  }

  const result = extract(readme);
  if (!result.ok) {
    // Idem: falha de parsing é aviso, não extrato — não consome o marcador.
    emit(`⚠️ KB de infra (${pointer.remote}): ${result.reason}`);
  }

  // Só a partir daqui o extrato de verdade está saindo — marca o disparo.
  markFiredThisSession(sessionId);

  emit(
    [
      `Antes de gravar este arquivo (${filePath}), confira contra a KB do host compartilhado:`,
      "",
      formatExtract(result),
      "",
      "Checklist:",
      "  - a porta que você vai publicar está livre na lista acima (e reservada no registro)?",
      "  - o compose roda com `-p <app>` explícito, não com o nome derivado do diretório?",
      "  - todo serviço tem `mem_limit:` da classe correspondente?",
      "  - as portas publicam em `172.17.0.1:<porta>`, nunca em `0.0.0.0` nem 80/443?",
      "  - se há Redis: `maxmemory` próprio junto do limite do container?",
    ].join("\n")
  );
}

function emit(text) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: text,
      },
    })
  );
  process.exit(0);
}

main().catch(() => silent());
