// A decisão do aiteam/hooks/beads-guard.mjs (PreToolUse Write|Edit no Claude
// Code), pura e testável — mesma separação do tier-guard.mjs/tier-core.mjs.
//
// É um acelerador opcional (aiteam/docs/beads-schema.md §9): nega o Write/Edit
// que o pre-commit recusaria depois, já com o caminho certo na mensagem. O gate
// de verdade continua sendo o pre-commit, que vale para qualquer engine.
//
// Sem shebang e só com node:*, caminhos relativos e o vendor (ver beads-core.mjs).

import * as fs from "node:fs";
import * as path from "node:path";
import { sanitizeBranch } from "./beads-core.mjs";
import { classifyBeadsPath, ownPathFor } from "./beads-io.mjs";

/** Disco que ignora maiúsculas por padrão: Windows e macOS. */
export const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

/**
 * O caminho como o disco do Windows o entende (`platform` é a costura dos
 * testes): sem o prefixo `\\?\`, com `/c/...` e `/cygdrive/c/...` do Git Bash
 * virando `C:/...`, sem o stream alternado (`arquivo:stream`, `::$DATA`) e sem
 * ponto ou espaço no fim de cada nome — o Windows os descarta, então
 * `active.yaml.` É o `active.yaml`. Fora do Windows, nada muda.
 */
export function normalizeInputPath(p, platform = process.platform) {
  if (typeof p !== "string" || platform !== "win32") return p;
  let s = p.replace(/^[\\/]{2}[?.][\\/]UNC[\\/]/i, "\\\\").replace(/^[\\/]{2}[?.][\\/]/, "");
  const msys = /^\/(?:cygdrive\/)?([a-zA-Z])(?=\/|$)(.*)$/.exec(s);
  if (msys) s = `${msys[1].toUpperCase()}:${msys[2] || "/"}`;
  const from = /^[a-zA-Z]:/.test(s) ? 2 : 0;
  const colon = s.indexOf(":", from);
  if (colon >= 0) s = s.slice(0, colon);
  return s.replace(/[^\\/]+/g, (seg) => (seg === "." || seg === ".." ? seg : seg.replace(/[. ]+$/, "")));
}

/**
 * O alvo resolvido de verdade: o ancestral existente mais próximo passa pelo
 * realpath (symlink, junção, nome curto 8.3 e a caixa real do disco) e o resto
 * do caminho, que ainda não existe, é colado de volta. `dir` é o diretório
 * existente onde perguntar ao git pela raiz.
 */
export function realTarget(abs) {
  const rest = [];
  for (let probe = abs; ; ) {
    try {
      const real = fs.realpathSync.native(probe);
      const dir = fs.statSync(real).isDirectory() ? real : path.dirname(real);
      return { real: rest.length ? path.join(real, ...rest.reverse()) : real, dir };
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      rest.push(path.basename(probe));
      probe = parent;
    }
  }
}

/**
 * O caminho relativo à raiz do repo, com `/`, ou null quando o arquivo fica
 * fora dela — o guard só julga o que está dentro do repo. Em disco que ignora
 * maiúsculas, a raiz também se compara assim.
 */
export function relativeToRoot(root, filePath, cwd = root, { caseInsensitive = CASE_INSENSITIVE } = {}) {
  if (typeof filePath !== "string" || filePath === "") return null;
  const abs = path.resolve(cwd ?? root, filePath);
  const base = path.resolve(root);
  let rel = path.relative(base, abs);
  if ((rel.startsWith("..") || path.isAbsolute(rel)) && caseInsensitive) {
    const prefix = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
    if (abs.toLowerCase().startsWith(prefix.toLowerCase())) rel = abs.slice(prefix.length);
  }
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/**
 * Onde o Write/Edit vai cair: a raiz do repo DO ALVO (não a do cwd da sessão —
 * outra worktree, um repo aninhado) e o caminho relativo a ela. `topLevel` é o
 * `gitTopLevel` do beads-io. Null: fora de qualquer repo, ou fora do .beads.
 */
export function locateTarget(filePath, cwd, { topLevel, platform = process.platform, caseInsensitive = CASE_INSENSITIVE }) {
  if (typeof filePath !== "string" || filePath === "") return null;
  const abs = path.resolve(normalizeInputPath(cwd, platform), normalizeInputPath(filePath, platform));
  const target = realTarget(abs);
  // Barato antes de chamar o git: só o que cai num .beads interessa.
  if (!target || !/[\\/]\.beads([\\/]|$)/i.test(target.real)) return null;
  const top = topLevel(target.dir);
  if (!top) return null;
  let root = top;
  try {
    root = fs.realpathSync.native(top);
  } catch {
    /* fica o que o git disse */
  }
  const rel = relativeToRoot(root, target.real, root, { caseInsensitive });
  return rel ? { root, rel } : null;
}

const deny = (reason) => ({ deny: true, reason });

/**
 * A estrutura do .beads em minúsculas quando o disco ignora maiúsculas:
 * `.BEADS/TASKS/x/main.YAML` é `.beads/tasks/x/main.yaml`. O id e o nome do
 * arquivo de branch guardam a caixa (o git a diferencia no commit); os nomes
 * do topo (visões, estado local, espelhos) vão inteiros para minúsculas.
 */
function canonicalRel(rel, caseInsensitive) {
  const parts = rel.split("/");
  if (parts[0].toLowerCase() !== ".beads") return rel;
  parts[0] = ".beads";
  if (!caseInsensitive) return parts.join("/");
  if (parts.length === 2) {
    parts[1] = parts[1].toLowerCase();
  } else if (parts.length > 2) {
    parts[1] = parts[1].toLowerCase();
    parts[parts.length - 1] = parts[parts.length - 1].replace(/\.yaml$/i, ".yaml");
  }
  return parts.join("/");
}

/**
 * @param {{rel: string|null, branch: string|null, legacy: boolean, caseInsensitive?: boolean}} input
 * @returns {{deny: boolean, reason?: string}}
 */
export function beadsGuardDecision({ rel, branch, legacy, caseInsensitive = false }) {
  if (!rel) return { deny: false };
  // .BEADS/Active.yaml é a visão em qualquer disco que a deixe ser criada
  // assim; o resto da estrutura só em disco que ignora maiúsculas.
  const normalized = canonicalRel(rel, caseInsensitive);
  const lower = normalized.toLowerCase();
  const c = classifyBeadsPath(/^\.beads\/(active|index)\.yaml$/.test(lower) ? lower : normalized);
  const own = sanitizeBranch(branch ?? "");
  const target = own.file ? `.beads/tasks/<id>/${own.file}.yaml` : "uma branch (HEAD destacado não escreve beads)";
  const contract = "Contrato: aiteam/docs/beads-schema.md";

  // Modo legado: o active.yaml rastreado ainda é a fonte e fica livre; o
  // modelo novo só depois da migração (§11).
  if (legacy) {
    return c.kind === "task" || c.kind === "project"
      ? deny(`${rel}: modo legado — o .beads/active.yaml antigo ainda manda. Registre nele, ou migre antes (rode migrate-beads: node aiteam/scripts/migrate-beads.mjs --dry-run). ${contract} §11.`)
      : { deny: false };
  }

  switch (c.kind) {
    case "view":
      return deny(`${rel} é visão gerada (fora do git, reescrita a cada hook) — registre estado em ${target}. ${contract} §7.`);
    case "backup":
      return deny(`${rel} é backup de visão editada à mão — passe o que importa para ${target} como entrada nova e apague o backup. ${contract} §7.4.`);
    case "local":
      return deny(`${rel} é estado local de sessão, escrito pelo circuit breaker — não se edita à mão. ${contract} §10.`);
    case "archive":
      return deny(`${rel}: .beads/archive/ não existe no modelo por bead — registre em ${target}. ${contract} §11.`);
    case "mirror":
      return deny(`${rel} é espelho do modelo antigo, que não se cria mais — registre em ${target}. ${contract} §11.`);
    case "stray":
      return deny(`${rel}: só <branch>.yaml vive em .beads/tasks/<id>/ e em .beads/project/. ${contract} §3.4.`);
    case "task":
    case "project":
      if (!own.file) return deny(`${rel}: ${own.reason} — crie uma branch antes de registrar beads (git switch -c <nome>).`);
      if (c.branchFile !== own.file) {
        return deny(`${rel} é da branch "${c.branchFile}"; você está em "${branch}". Escreva em ${ownPathFor(c, own.file)}. ${contract} §8.`);
      }
      return { deny: false };
    default:
      return { deny: false };
  }
}
