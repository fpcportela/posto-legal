// worktree-link — o aiteam/node_modules compartilhado entre o checkout
// principal e as worktrees vinculadas (rb-ai-team#38).
//
// Uma worktree nova nasce sem aiteam/node_modules (o git o ignora) e rodar
// `npm ci` nela reescreveria o do principal. Em vez disso o post-checkout liga o
// do principal: junction no Windows, symlink nos demais (`symlinkSync(.., 'junction')`
// serve aos dois). Este módulo nunca roda npm e nunca sobrescreve nada que já
// exista no lugar do link.
//
// O PERIGO, medido com git 2.50.1 for Windows num repo de rascunho e um alvo
// descartável: `git worktree remove`, com e sem --force, SEGUE a junction e apaga
// o conteúdo do alvo (o diretório fica, vazio). Ligado ao node_modules de verdade,
// isso esvaziaria o do checkout principal. Por isso o link tem o caminho de
// remoção que o desfaz antes — `unlinkSharedModules` e `removeWorktree`, expostos
// por scripts/worktree-link.mjs. (O node `fs.rmSync` recursivo não segue a
// junction, nem o Claude Code >= 2.1.205 ao limpar as worktrees que ele criou.)
//
// Só node:* — roda no hook de qualquer worktree, sem aiteam/node_modules.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** O link, relativo à raiz de um checkout. */
export const SHARED_MODULES = "aiteam/node_modules";

function git(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

/** Forma canônica para comparar caminhos: links resolvidos e, no Windows, sem caixa. */
function canon(p) {
  let real;
  try {
    real = fs.realpathSync.native(p);
  } catch {
    real = path.resolve(p);
  }
  const s = real.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
}

const same = (a, b) => canon(a) === canon(b);

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** Raiz do checkout (principal ou vinculado) que contém `cwd`; null fora de um repo. */
export function checkoutRoot(cwd) {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  return top ? path.resolve(top) : null;
}

/** Os checkouts do repo, do `git worktree list --porcelain`: o principal vem primeiro. */
export function listCheckouts(cwd) {
  const out = git(cwd, ["worktree", "list", "--porcelain"]);
  if (!out) return [];
  const found = [];
  for (const block of out.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const head = lines.find((l) => l.startsWith("worktree "));
    if (head) found.push({ path: path.resolve(head.slice("worktree ".length)), bare: lines.includes("bare") });
  }
  return found;
}

/** O checkout principal do repo de `cwd`; null se não houver (repo bare, fora de um repo). */
export function mainCheckout(cwd) {
  const first = listCheckouts(cwd)[0];
  return first && !first.bare ? first.path : null;
}

/** `git check-ignore` sai com 0 quando o caminho é ignorado; qualquer outra coisa conta como não ignorado. */
function isIgnored(top, rel) {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", rel], { cwd: top, stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Desfaz um link sem segui-lo. No Windows o link normal é uma junction, que só o
 * rmdir desfaz; nos demais é um symlink, que o unlink desfaz. Um symlink de
 * ARQUIVO inverte isso (o rmdir falha com ENOTDIR no Windows), então tenta o
 * outro jeito antes de desistir — e nunca lança: devolve o erro. Nenhum dos dois
 * segue o link: o rmdir só remove diretório vazio e o unlink só o próprio link.
 *
 * @param {string} link
 * @param {Pick<typeof fs, "rmdirSync" | "unlinkSync">} [ops]
 * @param {NodeJS.Platform} [platform]
 * @returns {{ok: true} | {ok: false, message: string}}
 */
export function removeLink(link, ops = fs, platform = process.platform) {
  const order = platform === "win32" ? ["rmdirSync", "unlinkSync"] : ["unlinkSync", "rmdirSync"];
  let last;
  for (const op of order) {
    try {
      ops[op](link);
      return { ok: true };
    } catch (err) {
      last = err;
    }
  }
  return { ok: false, message: String(last?.message ?? last) };
}

/** Refaz um link que o `remove` desfez, para o MESMO alvo que ele tinha. Melhor esforço. */
function restoreLink(link, target) {
  if (!target) return;
  let type = "junction";
  try {
    type = fs.statSync(path.resolve(path.dirname(link), target)).isDirectory() ? "junction" : "file";
  } catch {
    // alvo ilegível: segue com o padrão
  }
  try {
    fs.symlinkSync(target, link, type);
  } catch {
    // sem como refazer: a mensagem de recusa do git já diz o que houve
  }
}

/**
 * Liga `aiteam/node_modules` desta worktree vinculada ao do checkout principal.
 * Não faz nada — e diz por quê — fora de uma worktree vinculada, sem
 * node_modules no principal, sem `aiteam/` na worktree ou com qualquer coisa já
 * no lugar do link (diretório de verdade, outro link, link quebrado).
 *
 * @returns {{status: "linked", link: string, source: string, message: string}
 *   | {status: "skipped", reason: string}
 *   | {status: "error", message: string}}
 */
export function linkSharedModules(cwd = process.cwd()) {
  const top = checkoutRoot(cwd);
  if (!top) return { status: "skipped", reason: "fora de um repositório" };
  const main = mainCheckout(top);
  if (!main) return { status: "skipped", reason: "sem checkout principal" };
  if (same(main, top)) return { status: "skipped", reason: "é o checkout principal" };

  const source = path.join(main, ...SHARED_MODULES.split("/"));
  let sourceStat;
  try {
    sourceStat = fs.statSync(source);
  } catch {
    return { status: "skipped", reason: "o principal não tem aiteam/node_modules" };
  }
  if (!sourceStat.isDirectory()) return { status: "skipped", reason: "o aiteam/node_modules do principal não é um diretório" };

  const aiteam = path.join(top, "aiteam");
  if (!fs.existsSync(aiteam)) return { status: "skipped", reason: "a worktree não tem aiteam/" };

  const link = path.join(top, ...SHARED_MODULES.split("/"));
  if (lstatOrNull(link)) return { status: "skipped", reason: "já existe aiteam/node_modules" };

  try {
    fs.symlinkSync(source, link, "junction");
  } catch (err) {
    return { status: "error", message: `não consegui ligar ${SHARED_MODULES} ao do principal: ${err?.message ?? err}` };
  }
  // Em Linux/macOS o link é um symlink, que o `node_modules/` do .gitignore não
  // casa: sem a regra `/node_modules` de aiteam/.gitignore ele viraria `??` e o
  // `git add -A` o commitaria. Não fica um link que o git não ignora.
  if (!isIgnored(top, SHARED_MODULES)) {
    const undone = removeLink(link);
    return {
      status: "error",
      message:
        `${SHARED_MODULES} não seria ignorado pelo git (falta /node_modules em aiteam/.gitignore): ` +
        (undone.ok
          ? "o link foi desfeito para não virar conteúdo commitável."
          : `o link NÃO pôde ser desfeito (${undone.message}) — apague-o à mão antes de qualquer git add.`),
    };
  }
  return {
    status: "linked",
    link,
    source,
    message:
      `[aiteam] ${SHARED_MODULES} ligado ao do checkout principal (${main}). ` +
      `Não rode npm install/ci aqui: reescreveria o do principal. ` +
      `Para remover esta worktree use node aiteam/scripts/worktree-link.mjs remove <caminho> — ` +
      `o git worktree remove segue a junction no Windows e apaga o node_modules do principal.`,
  };
}

/**
 * Desfaz o link `aiteam/node_modules` do checkout que contém `dir`, sem tocar no
 * alvo. Só remove o que o lstat diz ser link; um diretório de verdade fica. O
 * checkout principal é recusado: o node_modules dele é o ALVO dos links, e um
 * link ali seria do próprio usuário (um cache, por exemplo), não deste
 * mecanismo. `target` é para onde o link apontava, para quem precisar refazê-lo.
 *
 * @returns {{status: "unlinked", link: string, target: string}
 *   | {status: "absent"}
 *   | {status: "not-a-link", link: string}
 *   | {status: "main-checkout", link: string}
 *   | {status: "error", link: string, message: string}}
 */
export function unlinkSharedModules(dir = process.cwd()) {
  const top = checkoutRoot(dir) ?? path.resolve(dir);
  const link = path.join(top, ...SHARED_MODULES.split("/"));
  const main = mainCheckout(top);
  if (main && same(main, top)) return { status: "main-checkout", link };
  const st = lstatOrNull(link);
  if (!st) return { status: "absent" };
  if (!st.isSymbolicLink()) return { status: "not-a-link", link };
  let target = "";
  try {
    target = fs.readlinkSync(link);
  } catch {
    // sem o alvo, o remove recusado não terá como refazer o link
  }
  const removed = removeLink(link);
  if (!removed.ok) return { status: "error", link, message: removed.message };
  return { status: "unlinked", link, target };
}

/**
 * Remove uma worktree vinculada pelo caminho seguro: desfaz o link do
 * node_modules e só então roda `git worktree remove`. Recusa o checkout
 * principal e qualquer caminho que o git não liste. Desfaz qualquer link em
 * aiteam/node_modules, também o do usuário; se o git recusar (worktree suja sem
 * `force`), o link volta para o MESMO alvo que tinha, e a worktree fica como estava.
 *
 * @returns {{status: "removed", path: string} | {status: "refused", message: string}}
 */
export function removeWorktree(target, { force = false } = {}) {
  const abs = path.resolve(target);
  const probe = fs.existsSync(abs) ? abs : process.cwd();
  const checkouts = listCheckouts(probe);
  const main = checkouts[0];

  if (!main || !checkouts.some((c) => same(c.path, abs))) {
    return { status: "refused", message: `${abs} não é uma worktree deste repositório (git worktree list)` };
  }
  if (same(main.path, abs)) {
    return { status: "refused", message: `${abs} é o checkout principal — só worktrees vinculadas se removem` };
  }

  // Qualquer link em aiteam/node_modules sai antes do git, o do usuário também:
  // no Windows o git seguiria até o alvo dele. Se não der para desfazê-lo, nada
  // é removido — rodar o git assim esvaziaria o alvo.
  const un = unlinkSharedModules(abs);
  if (un.status === "error") {
    return {
      status: "refused",
      message: `não consegui desfazer o link ${un.link} (${un.message}); nada foi removido para não esvaziar o alvo dele`,
    };
  }
  try {
    execFileSync("git", ["worktree", "remove", ...(force ? ["--force"] : []), abs], {
      cwd: main.path,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (err) {
    if (un.status === "unlinked") restoreLink(un.link, un.target);
    const detail = String(err?.stderr ?? err?.message ?? err).trim();
    return { status: "refused", message: detail || "git worktree remove falhou" };
  }
  return { status: "removed", path: abs };
}
