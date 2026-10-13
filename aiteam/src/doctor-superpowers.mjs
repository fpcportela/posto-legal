// O plugin superpowers no `aiteam doctor` (rb-ai-team#51): a versão instalada e se
// ele está ligado. É informação, não contrato — o framework não exige o plugin —,
// então o resultado é INFO ou WARN, nunca FAIL, e a linha some quando falta o que
// ler (sem o plugin, sem settings, sem cache). Só leitura, e só dentro de
// ~/.claude (ou do CLAUDE_CONFIG_DIR, quando definido) e do repo: os settings do
// usuário e do projeto, o registro de instalação e o cache de plugins; nada é
// seguido para fora, nem por symlink ou junction (o installPath que o registro
// guarda não é aberto).
//
// Vive num arquivo próprio e não no doctor-core.mjs/doctor-io.mjs porque junta o
// check e a leitura de uma coisa que só o doctor usa; a leitura recebe `root`, o
// `home` e o `env`, então o teste a roda sobre diretórios temporários.

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * A versão do superpowers com que o framework foi validado: a que o marketplace
 * oficial (anthropics/claude-plugins-official) serve — o sha 5bf4e78 do
 * obra/superpowers, package.json 6.4.1. A 6.4.2 (upstream, fora do marketplace)
 * só mexe no `writing-plans`: o ledger do SDD e do executing-plans, o TDD e a
 * revisão final, de que as regras do AGENTS.md dependem, são os da 6.4.1.
 */
export const SUPERPOWERS_VALIDATED = "6.4.1";

// Antes da 6.2.0, no Windows, o hook SessionStart do plugin falhava sem aviso
// (PowerShell e cmd): o bootstrap nunca carregava. A 6.2.0 declara `shell: "bash"`.
const WINDOWS_HOOK_FIXED = [6, 2, 0];

const PLUGIN_KEY = /^superpowers@/;

/**
 * `major.minor.patch` de um texto de versão (com ou sem o `v`, aceita sufixo), ou
 * null quando o texto não começa por três números.
 * @param {unknown} text
 * @returns {[number, number, number] | null}
 */
export function parseVersion(text) {
  if (typeof text !== "string") return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// O que sai na tela é só o que o doctor reconhece como versão: major.minor.patch com
// um sufixo opcional de [0-9A-Za-z.+-] (6.4.2-rc.1, 6.4.2+build.5), de até 32
// caracteres. O texto vem de arquivos que não são do doctor (o registro de instalação
// do Claude Code, o cache de plugins) e entra no `detail` que o doctor.mjs imprime: sem
// o filtro, uma "versão" feita de sequências de escape limpava a tela, mudava o título
// do terminal, forjava uma linha [PASS] ou imprimia 200 KB (revisão do QA da #51).
const VERSION_MAX_LENGTH = 32;
const VERSION_TEXT = /^v?(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)$/;

/**
 * A versão como pode ser impressa: sem o `v` e sem o espaço das pontas, ou null
 * quando o texto não é uma versão (outros caracteres, mais de 32 caracteres, não
 * é texto).
 * @param {unknown} text
 * @returns {string | null}
 */
export function cleanVersion(text) {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (t.length > VERSION_MAX_LENGTH) return null;
  const m = VERSION_TEXT.exec(t);
  return m ? (m[1] ?? null) : null;
}

/**
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * A linha do doctor: a versão instalada, se está ligado e a versão com que o
 * framework foi validado. INFO por padrão; WARN quando a versão é anterior à
 * 6.2.0 no Windows e o plugin pode estar ligado (o hook SessionStart falhava sem
 * aviso). Nunca reprova. Null quando não há versão nem estado — nada a dizer.
 *
 * Só a versão que passa no cleanVersion chega ao `detail`; qualquer outro texto vira
 * "versão ilegível".
 *
 * @param {{enabled: boolean|null, version: string|null, versionUnreadable?: boolean, platform: string}} facts
 *   enabled: o estado efetivo em enabledPlugins (null: nenhum settings o declara)
 *   versionUnreadable: havia uma versão no registro, mas não era uma versão
 * @returns {{name: string, pass: true, info?: true, warn?: true, detail: string} | null}
 */
export function checkSuperpowers({ enabled, version, versionUnreadable = false, platform }) {
  const clean = cleanVersion(version);
  const unreadable = versionUnreadable || (version !== null && version !== undefined && clean === null);
  if (enabled === null && clean === null && !unreadable) return null;
  const name = "superpowers plugin — installed version and whether it is on";
  const state = enabled === true ? "ligado" : enabled === false ? "desligado" : "estado não declarado em enabledPlugins";
  const label = clean ?? (unreadable ? "versão ilegível" : "versão não encontrada no cache de plugins");
  const validated = `framework foi validado com o superpowers ${SUPERPOWERS_VALIDATED}`;
  const parsed = parseVersion(clean);
  const old = platform === "win32" && parsed !== null && compareVersions(parsed, WINDOWS_HOOK_FIXED) < 0;
  const hazard = "no Windows, antes da 6.2.0 o hook SessionStart do plugin falhava sem aviso (PowerShell e cmd): o bootstrap nunca carregava";
  if (old && enabled !== false) {
    return { name, pass: true, warn: true, detail: `${label}, ${state} — ${hazard}; atualize o plugin. O ${validated}` };
  }
  if (old) {
    return { name, pass: true, info: true, detail: `${label}, ${state} — ${hazard}; atualize antes de ligá-lo. O ${validated}` };
  }
  return { name, pass: true, info: true, detail: `${label}, ${state} — o ${validated}` };
}

// Um BOM (U+FEFF) no começo é de editor do Windows, não parte do JSON.
const withoutBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

// "Só dentro de ~/.claude e do repo" é imposto aqui, não só prometido: cada arquivo
// ou diretório lido tem de ficar, DEPOIS de resolver symlink e junction, dentro do
// realpath do diretório dono (a "jaula": ~/.claude para os arquivos do usuário, a
// raiz do repo para os do projeto). Um ~/.claude/plugins que fosse uma junction
// para fora fazia o doctor ler a versão de um arquivo de fora (revisão do QA da
// #51). Arquivo tem de ser arquivo e ter até 1 MB: sem teto, um settings.json de
// 300 MB era lido inteiro. Fora disso, a leitura falha em silêncio (null).
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DIR_ENTRIES = 500;

/** A jaula de um diretório dono: o realpath dele, ou null quando ele não existe. */
function jailOf(dir) {
  try {
    return realpathSync.native(dir);
  } catch {
    return null;
  }
}

/** O realpath de `target` se ele fica DENTRO de `jail` (nunca igual a ela); senão null. */
function realInside(target, jail) {
  if (jail === null) return null;
  try {
    const real = realpathSync.native(target);
    const rel = path.relative(jail, real);
    const inside = rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
    return inside ? real : null;
  } catch {
    return null;
  }
}

function readJson(file, jail) {
  try {
    const real = realInside(file, jail);
    if (real === null) return null;
    const st = statSync(real);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const doc = JSON.parse(withoutBom(readFileSync(real, "utf8")));
    return doc !== null && typeof doc === "object" ? doc : null;
  } catch {
    return null;
  }
}

// Só os nomes dos subdiretórios REAIS: um symlink ou junction (que o Dirent não
// dá como diretório) não conta, e a própria pasta listada fica dentro da jaula.
function dirNames(dir, jail) {
  try {
    const real = realInside(dir, jail);
    if (real === null) return [];
    return readdirSync(real, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .slice(0, MAX_DIR_ENTRIES);
  } catch {
    return [];
  }
}

function samePath(a, b) {
  const norm = (p) => path.resolve(String(p)).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

// Do mais fraco ao mais forte, como o Claude Code os sobrepõe: usuário, projeto
// (compartilhado), projeto (local). O último que declara a chave vence. Devolve o estado
// de CADA chave superpowers@<marketplace> (a versão e o estado vêm da mesma chave, ver
// pickKey).
function enabledStates(claudeDir, root) {
  const userJail = jailOf(claudeDir);
  const repoJail = jailOf(root);
  const files = [
    [path.join(claudeDir, "settings.json"), userJail],
    [path.join(root, ".claude", "settings.json"), repoJail],
    [path.join(root, ".claude", "settings.local.json"), repoJail],
  ];
  const states = new Map();
  for (const [file, jail] of files) {
    const plugins = readJson(file, jail)?.enabledPlugins;
    if (plugins === null || typeof plugins !== "object" || Array.isArray(plugins)) continue;
    for (const [key, value] of Object.entries(plugins)) {
      if (PLUGIN_KEY.test(key) && typeof value === "boolean") states.set(key, value);
    }
  }
  return states;
}

// O registro de instalação do Claude Code: a versão de cada instalação e o escopo. Vale a
// do usuário e as do projeto atual; a de local vence a de projeto, que vence a de usuário.
// Uma entrada por chave superpowers@<marketplace>. A versão que não passa no cleanVersion
// não conta como candidata (uma entrada hostil não esconde uma boa); sem nenhuma boa, a
// chave fica com `unreadable`.
function installRecords(claudeDir, root) {
  const plugins = readJson(path.join(claudeDir, "plugins", "installed_plugins.json"), jailOf(claudeDir))?.plugins;
  const records = new Map();
  if (plugins === null || typeof plugins !== "object") return records;
  for (const [key, installs] of Object.entries(plugins)) {
    if (!PLUGIN_KEY.test(key) || !Array.isArray(installs)) continue;
    let best = null;
    let sawUnreadable = false;
    for (const inst of installs) {
      if (inst === null || typeof inst !== "object" || typeof inst.version !== "string" || inst.version.trim() === "") continue;
      const here = typeof inst.projectPath === "string" && samePath(inst.projectPath, root);
      const rank = inst.scope === "user" ? 1 : here && inst.scope === "project" ? 2 : here && inst.scope === "local" ? 3 : 0;
      if (rank === 0) continue;
      const version = cleanVersion(inst.version);
      if (version === null) {
        sawUnreadable = true;
        continue;
      }
      const parsed = parseVersion(version);
      const wins =
        best === null ||
        rank > best.rank ||
        (rank === best.rank && parsed !== null && (best.parsed === null || compareVersions(parsed, best.parsed) > 0));
      if (wins) best = { rank, parsed, version };
    }
    if (best !== null || sawUnreadable) {
      records.set(key, { version: best?.version ?? null, parsed: best?.parsed ?? null, unreadable: best === null });
    }
  }
  return records;
}

// Sem o registro, o cache de plugins: cache/<marketplace>/superpowers/<versão>/. Só os
// nomes dos diretórios, e a maior versão — o cache guarda as antigas. O nome que não é
// uma versão (cleanVersion) é ignorado. Com `marketplace`, só o dele (o da chave que o
// doctor está descrevendo); sem, qualquer um. O nome do marketplace vem de uma chave de
// settings e vira caminho: só [A-Za-z0-9._-], sem começar por ponto.
const MARKETPLACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function cachedVersion(claudeDir, marketplace) {
  const cache = path.join(claudeDir, "plugins", "cache");
  const jail = jailOf(claudeDir);
  let marketplaces;
  if (marketplace === null) marketplaces = dirNames(cache, jail);
  else if (MARKETPLACE_NAME.test(marketplace) && !marketplace.includes("..")) marketplaces = [marketplace];
  else return null;
  let best = null;
  for (const name of marketplaces) {
    for (const dir of dirNames(path.join(cache, name, "superpowers"), jail)) {
      const version = cleanVersion(dir);
      const parsed = parseVersion(version);
      if (version !== null && parsed !== null && (best === null || compareVersions(parsed, best.parsed) > 0)) best = { parsed, version };
    }
  }
  return best?.version ?? null;
}

const OFFICIAL_KEY = "superpowers@claude-plugins-official";

// A chave que o doctor descreve. O estado ("ligado") e a versão vêm da MESMA chave
// superpowers@<marketplace>: misturar o estado de uma com a versão de outra dava uma
// linha que não era de nenhuma instalação (revisão do QA da #51). Prefere a chave que tem
// estado E instalação; depois a que tem instalação; empatadas, a ligada, a do marketplace
// oficial, a de maior versão e, por fim, a de menor nome (determinístico).
function pickKey(states, installs) {
  const keys = [...new Set([...states.keys(), ...installs.keys()])];
  if (keys.length === 0) return null;
  const score = (key) => [
    states.has(key) && installs.has(key) ? 1 : 0,
    installs.has(key) ? 1 : 0,
    states.get(key) === true ? 1 : 0,
    key === OFFICIAL_KEY ? 1 : 0,
  ];
  const better = (a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i] > sb[i];
    const pa = installs.get(a)?.parsed ?? null;
    const pb = installs.get(b)?.parsed ?? null;
    if (pa !== null && pb !== null && compareVersions(pa, pb) !== 0) return compareVersions(pa, pb) > 0;
    if ((pa === null) !== (pb === null)) return pa !== null;
    return a < b;
  };
  return keys.reduce((best, key) => (better(key, best) ? key : best));
}

/**
 * Os fatos que o checkSuperpowers pede ao disco. Nunca lança: o que não existe ou
 * não lê fica null, e uma versão que não é uma versão (cleanVersion) vira
 * `versionUnreadable`. O estado e a versão são da mesma chave superpowers@<marketplace>.
 *
 * O diretório de configuração do usuário é o CLAUDE_CONFIG_DIR, quando definido (o
 * Claude Code o lê em vez de ~/.claude), ou `<home>/.claude`; é a jaula dos arquivos
 * dele. O home só é consultado quando faz falta, e DENTRO do try: um os.homedir() que
 * lança (máquina sem home) não derruba o doctor.
 *
 * @param {{root: string, home?: string, env?: Record<string, string | undefined>, homedir?: () => string}} where
 *   root: a raiz do repo; home: o diretório do usuário (padrão: homedir());
 *   env: o ambiente (padrão: process.env); homedir: só os testes trocam
 * @returns {{enabled: boolean|null, version: string|null, versionUnreadable: boolean}}
 */
export function readSuperpowersFacts({ root, home, env = process.env, homedir = os.homedir }) {
  try {
    const configured = typeof env?.["CLAUDE_CONFIG_DIR"] === "string" ? env["CLAUDE_CONFIG_DIR"].trim() : "";
    const claudeDir = configured !== "" ? path.resolve(configured) : path.join(home ?? homedir(), ".claude");
    const states = enabledStates(claudeDir, root);
    const installs = installRecords(claudeDir, root);
    const key = pickKey(states, installs);
    if (key === null) return { enabled: null, version: cachedVersion(claudeDir, null), versionUnreadable: false };
    const record = installs.get(key);
    const version = record?.version ?? cachedVersion(claudeDir, key.slice("superpowers@".length));
    return { enabled: states.get(key) ?? null, version, versionUnreadable: version === null && record?.unreadable === true };
  } catch {
    return { enabled: null, version: null, versionUnreadable: false };
  }
}
