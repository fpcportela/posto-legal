// Núcleo puro do contrato de CI — AGENTS.md §CI/CD Mandate, item 1
// (rb-ai-team#31). O projeto declara no frontmatter do SPEC.md, no bloco `ci:`,
// os comandos que o CI de PR roda para a aplicação; este módulo lê esse bloco
// e confere, contra os workflows do repo, que cada comando declarado roda de
// fato num PR, no diretório declarado. É a única fonte dessa lógica: o
// aiteam/src/ci-contract.test.ts (o contrato, no CI) e o doctor
// (aiteam/src/doctor-core.mjs) o importam.
//
// Existe porque o contrato anterior casava /npm (run )?test/ em qualquer `run:`
// e aprovava um consumidor cujo único `npm run test` rodava em aiteam/: o
// working-directory faz o comando do framework e o da app virarem a mesma
// string no YAML, e o teste certificava o mandato onde a suíte da app nunca
// rodava em PR.
//
// Sem dependências e sem shebang: o doctor roda em node puro, sem garantia de
// aiteam/node_modules, e o strip de shebang do vite-node quebra o import num
// checkout CRLF (ver tier-core.mjs). Por isso o bloco `ci:` é lido linha a
// linha, como o allow_tier3 do tier-core, e os workflows chegam já parseados:
// quem chama é quem tem o parser YAML.

import { extractFrontmatter } from "./frontmatter.mjs";

/** O diretório do framework vendorizado, relativo à raiz do repo. */
export const FRAMEWORK_DIR = "aiteam";

const APP_MANIFEST = new RegExp(
  "^(?:" +
    [
      "package\\.json", // Node
      "deno\\.jsonc?", // Deno
      "pyproject\\.toml|requirements\\.txt|setup\\.py|setup\\.cfg|Pipfile", // Python
      "go\\.mod", // Go
      "Cargo\\.toml", // Rust
      "Gemfile", // Ruby
      "composer\\.json", // PHP
      "pom\\.xml|build\\.gradle(?:\\.kts)?|build\\.sbt", // JVM
      "[^/\\\\]+\\.(?:csproj|fsproj|sln)", // .NET
      "mix\\.exs", // Elixir
      "pubspec\\.yaml", // Dart
    ].join("|") +
    ")$",
);

/**
 * Um nome de arquivo da raiz que marca uma aplicação: package.json,
 * deno.json(c), pyproject.toml, requirements.txt, setup.py, setup.cfg,
 * Pipfile, go.mod, Cargo.toml, Gemfile, composer.json, pom.xml,
 * build.gradle*, build.sbt, *.csproj, *.fsproj, *.sln, mix.exs e
 * pubspec.yaml. A raiz do framework não tem nenhum. Quem chama o
 * evaluateCiContract lista a raiz e passa os que casam em `rootManifests`; o
 * núcleo segue sem ler disco.
 * @param {string} name
 */
export function isAppManifest(name) {
  return APP_MANIFEST.test(String(name ?? ""));
}

const CI_KEYS = ["workdir", "test", "local_test", "typecheck", "lint", "reason"];

// A chave `ci` de coluna 0. O que vier depois dos dois-pontos tem de ser nada
// ou um comentário: o bloco é sempre de linhas indentadas abaixo.
const CI_HEADER = /^ci[ \t]*:(.*)$/;
const BLANK_OR_COMMENT = /^[ \t]*(?:#.*)?$/;
const NOTHING_OR_COMMENT = /^(?:[ \t]*|[ \t]+#.*)$/;
// `chave: valor` — o YAML exige espaço depois dos dois-pontos (`test:npm` é um
// escalar só, não uma chave).
const ENTRY = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:(?:[ \t]+(.*))?$/;

const malformed = (reason) => ({ state: "malformed", reason });

// Um escalar de uma linha, do jeito que o YAML o lê. Fora do subconjunto
// (bloco literal, fluxo, âncora, tag) vira erro com o motivo, nunca um palpite.
export function parseScalar(raw) {
  const s = raw.replace(/^[ \t]+/, "");
  if (s === "" || s.startsWith("#")) return { ok: true, value: null };

  if (s[0] === '"' || s[0] === "'") {
    const quote = s[0];
    let out = "";
    let i = 1;
    for (; i < s.length; i++) {
      const c = s[i];
      if (quote === "'" && c === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          i++;
          continue;
        }
        break;
      }
      if (quote === '"' && c === '"') break;
      if (quote === '"' && c === "\\") {
        const n = s[i + 1];
        const escapes = { '"': '"', "\\": "\\", "/": "/", n: "\n", t: "\t" };
        if (n === undefined || !(n in escapes)) {
          return { ok: false, reason: `escape \\${n ?? ""} não suportado entre aspas duplas` };
        }
        out += escapes[n];
        i++;
        continue;
      }
      out += c;
    }
    if (i >= s.length) return { ok: false, reason: "aspas sem fechamento" };
    if (!NOTHING_OR_COMMENT.test(s.slice(i + 1))) {
      return { ok: false, reason: "texto depois das aspas de fechamento" };
    }
    return { ok: true, value: out };
  }

  if (/^[[\]{}&*!|>%@`]/.test(s) || /^[-?:](?:[ \t]|$)/.test(s)) {
    return {
      ok: false,
      reason: "formato de YAML que o leitor do ci: não aceita — escreva o comando numa linha só, sem aspas ou entre aspas",
    };
  }
  const hash = s.search(/[ \t]#/);
  const value = (hash === -1 ? s : s.slice(0, hash)).replace(/[ \t]+$/, "");
  if (/:(?:[ \t]|$)/.test(value)) {
    return { ok: false, reason: 'o valor tem ": " — ponha o comando entre aspas' };
  }
  if (/^(?:null|Null|NULL|~)$/.test(value)) return { ok: true, value: null };
  if (/^(?:true|True|TRUE|false|False|FALSE)$/.test(value)) {
    return { ok: false, reason: "é um booleano do YAML, não um comando" };
  }
  return { ok: true, value };
}

function normalizeWorkdir(raw) {
  if (raw === null) return { ok: true, value: "" };
  const p = raw.replace(/\\/g, "/");
  if (p.includes("$")) return { ok: false, reason: "workdir não aceita variável — use o caminho literal" };
  if (/^(?:\/|[A-Za-z]:|~)/.test(p)) {
    return { ok: false, reason: "workdir tem de ser um caminho relativo à raiz do repo" };
  }
  const parts = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return { ok: false, reason: "workdir não pode sair da raiz do repo (..)" };
    parts.push(seg);
  }
  return { ok: true, value: parts.join("/") };
}

/**
 * Lê o bloco `ci:` do frontmatter do SPEC.md, sem parser YAML: linha a linha,
 * do jeito que o YAML lê o subconjunto aceito (chaves `workdir`, `test`,
 * `local_test`, `typecheck`, `lint` e `reason`, cada valor numa linha, sem
 * aspas ou entre aspas). O bloco vai da chave `ci` de coluna 0 até a próxima chave de coluna
 * 0; linha em branco e comentário não o fecham. O que o leitor não sabe ler
 * com certeza vira `malformed` com o motivo, citando a linha do SPEC.md.
 *
 * Não julga o conteúdo: `test` ausente ou `none` sem `reason` são achados do
 * evaluateCiContract, não erro de leitura. `local_test` vem null quando a chave
 * não está no bloco e "" quando está sem comando (o evaluateCiContract o reprova).
 *
 * @param {string|null|undefined} specText
 */
export function readCiBlock(specText) {
  const fm = extractFrontmatter(specText);
  if (fm === null) return { state: "absent" };
  const lines = fm.split("\n");
  // A linha 1 do SPEC.md é a cerca de abertura; a linha i do frontmatter é a i+2.
  const at = (i) => `SPEC.md:${i + 2}`;

  let header = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = CI_HEADER.exec(lines[i]);
    if (!m) continue;
    if (header !== -1) return malformed(`${at(i)}: o bloco ci: aparece duas vezes no frontmatter`);
    header = i;
    if (!NOTHING_OR_COMMENT.test(m[1])) {
      return malformed(
        `${at(i)}: ci: tem de ser um bloco, com cada chave numa linha indentada abaixo dele (ex.: "  test: npm test" na linha seguinte)`,
      );
    }
  }
  if (header === -1) return { state: "absent" };

  const values = new Map();
  let indent = null;
  for (let i = header + 1; i < lines.length; i++) {
    const line = lines[i];
    if (BLANK_OR_COMMENT.test(line)) continue;
    const lead = /^[ \t]*/.exec(line)[0];
    if (lead === "") break; // a próxima chave de topo fecha o bloco
    if (lead.includes("\t")) return malformed(`${at(i)}: tab na indentação — o YAML só aceita espaços`);
    if (indent === null) indent = lead.length;
    if (lead.length !== indent) {
      return malformed(
        `${at(i)}: indentação diferente das outras chaves de ci: — valor em mais de uma linha ou aninhado não é aceito; escreva cada comando numa linha só`,
      );
    }
    const m = ENTRY.exec(line.slice(indent));
    if (!m) return malformed(`${at(i)}: a linha não é uma chave "chave: valor" de ci:`);
    const key = m[1];
    if (!CI_KEYS.includes(key)) {
      return malformed(`${at(i)}: chave desconhecida ci.${key} — as aceitas são ${CI_KEYS.join(", ")}`);
    }
    if (values.has(key)) return malformed(`${at(i)}: ci.${key} aparece duas vezes`);
    const rest = m[2] ?? "";
    // `test:` sozinho com o valor indentado na linha seguinte é mapa aninhado
    // ou bloco: a checagem de indentação acima pega a linha de baixo.
    const v = parseScalar(rest);
    if (!v.ok) return malformed(`${at(i)}: ci.${key}: ${v.reason}`);
    values.set(key, v.value);
  }

  const workdir = normalizeWorkdir(values.get("workdir") ?? null);
  if (!workdir.ok) return malformed(`ci.workdir: ${workdir.reason}`);
  const text = (key) => {
    const v = values.get(key);
    return typeof v === "string" && v.trim() !== "" ? v : null;
  };
  return {
    state: "ok",
    ci: {
      workdir: workdir.value,
      test: text("test"),
      local_test: values.has("local_test") ? (text("local_test") ?? "") : null,
      typecheck: text("typecheck"),
      lint: text("lint"),
      reason: text("reason"),
    },
  };
}

// ── O que um `run:` executa, e onde ─────────────────────────────────────────
// Um tokenizador de shell do tamanho do problema: separa os comandos de um
// `run:` (&&, ||, ;, |, &, quebra de linha, subshell), respeita aspas,
// comentário e continuação de linha, e acompanha o diretório de cada comando
// (cd, subshell, npm --prefix). Não é um shell: `$(…)`, crase e `${…}` ficam
// como texto da palavra, e um destino que depende de variável vira diretório
// desconhecido (null), que nunca casa com o declarado.

const OPERATORS = ["&&", "||", ";;", "|&", ";", "|", "&", "(", ")"];

function tokenize(src) {
  const tokens = [];
  let word = null;
  const add = (s) => {
    word = (word ?? "") + s;
  };
  const end = () => {
    if (word !== null) tokens.push({ t: "word", v: word });
    word = null;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\" && src[i + 1] === "\n") {
      i += 2; // continuação de linha
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      end();
      i++;
      continue;
    }
    if (c === "\n") {
      end();
      tokens.push({ t: "op", v: "\n" });
      i++;
      continue;
    }
    if (c === "#" && word === null) {
      while (i < src.length && src[i] !== "\n") i++; // comentário até o fim da linha
      continue;
    }
    if (c === "'") {
      const close = src.indexOf("'", i + 1);
      const stop = close === -1 ? src.length : close;
      add(src.slice(i + 1, stop));
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length && '"\\$`\n'.includes(src[j + 1])) {
          if (src[j + 1] !== "\n") s += src[j + 1];
          j += 2;
          continue;
        }
        s += src[j];
        j++;
      }
      add(s);
      i = j + 1;
      continue;
    }
    if (c === "\\") {
      add(src[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (c === "$" && src.startsWith("${{", i)) {
      // expressão do GitHub Actions que sobrou sem resolver: texto da palavra
      const close = src.indexOf("}}", i + 3);
      const stop = close === -1 ? src.length : close + 2;
      add(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === "$" && (src[i + 1] === "(" || src[i + 1] === "{")) {
      const open = src[i + 1];
      const close = open === "(" ? ")" : "}";
      let depth = 0;
      let j = i + 1;
      for (; j < src.length; j++) {
        if (src[j] === open) depth++;
        else if (src[j] === close && --depth === 0) break;
      }
      add(src.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (c === "`") {
      const close = src.indexOf("`", i + 1);
      const stop = close === -1 ? src.length : close + 1;
      add(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === ">" || c === "<" || (c === "&" && src[i + 1] === ">")) {
      if (word !== null && /^\d+$/.test(word)) word = null; // o fd de 2>&1
      end();
      let j = i + 1;
      while (j < src.length && (src[j] === ">" || src[j] === "<" || src[j] === "&")) j++;
      tokens.push({ t: "redirect" });
      i = j;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) {
      end();
      tokens.push({ t: "op", v: op });
      i += op.length;
      continue;
    }
    add(c);
    i++;
  }
  end();
  return tokens;
}

const WORKSPACE = /^(?:\$\{\{\s*github\.workspace\s*\}\}|\$\{GITHUB_WORKSPACE\}|\$GITHUB_WORKSPACE)(?=\/|$)/;

// Resolve `rel` a partir de `base`, os dois relativos à raiz do repo ("" é a
// raiz). O que não dá para resolver estaticamente (variável, caminho absoluto,
// subir acima da raiz) vira null.
function joinDir(base, rel) {
  let p = String(rel ?? "").replace(/\\/g, "/");
  let from = base;
  const ws = WORKSPACE.exec(p);
  if (ws) {
    from = "";
    p = p.slice(ws[0].length).replace(/^\/+/, "");
  }
  if (from === null || /[$`]/.test(p) || /^(?:\/|[A-Za-z]:|~)/.test(p)) return null;
  const parts = from === "" ? [] : from.split("/");
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}

function cdTarget(cwd, args) {
  const rest = args.filter((a) => a !== "--" && !/^-[LPe@]+$/.test(a));
  if (rest.length === 0 || rest[0] === "-") return null; // cd sozinho é o $HOME
  return joinDir(cwd, rest[0]);
}

// pushd sem diretório troca o topo da pilha, e pushd +N/-N gira a pilha: nos
// dois casos o diretório não dá para resolver aqui.
const pushdTarget = (cwd, args) => {
  const rest = args.filter((a) => a !== "--" && a !== "-n");
  if (rest.length === 0 || /^[+-]\d+$/.test(rest[0])) return null;
  return cdTarget(cwd, rest);
};

const NPM_TEST = new Set(["test", "t", "tst"]);
const NPM_RUN = new Set(["run", "run-script", "rum", "urn"]);
const NPM_FLAGS_WITH_VALUE = new Set(["-w", "--workspace", "--loglevel", "--userconfig", "--cache", "--registry"]);

function npmSubcommandIndex(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") return -1;
    if (!a.startsWith("-")) return i;
    if (NPM_FLAGS_WITH_VALUE.has(a)) i++;
  }
  return -1;
}

// `npm --prefix <dir>` (ou `-C <dir>`) roda no <dir>; um `-w`/`--workspace`
// que resolve dentro de aiteam/ também — é o framework, por outro caminho.
// `npm test`, `npm t` e `npm run-script test` são o mesmo `npm run test`.
// Depois de `--` tudo é do script.
function canonicalize(argv, cwd) {
  if (argv[0] !== "npm") return { dir: cwd, argv };
  let dir = cwd;
  const rest = [];
  let passthrough = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") passthrough = true;
    if (!passthrough && (a === "--prefix" || a === "-C") && i + 1 < argv.length) {
      dir = joinDir(dir, argv[++i]);
      continue;
    }
    if (!passthrough && a.startsWith("--prefix=")) {
      dir = joinDir(dir, a.slice("--prefix=".length));
      continue;
    }
    if (!passthrough && (a === "-w" || a === "--workspace") && i + 1 < argv.length) {
      const target = joinDir(dir, argv[i + 1]);
      if (insideFramework(target)) {
        dir = target;
        i++;
        continue;
      }
    }
    if (!passthrough && /^(?:-w|--workspace)=/.test(a)) {
      const target = joinDir(dir, a.slice(a.indexOf("=") + 1));
      if (insideFramework(target)) {
        dir = target;
        continue;
      }
    }
    rest.push(a);
  }
  const k = npmSubcommandIndex(rest);
  if (k !== -1 && NPM_TEST.has(rest[k])) rest.splice(k, 1, "run", "test");
  else if (k !== -1 && NPM_RUN.has(rest[k])) rest[k] = "run";
  return { dir, argv: ["npm", ...rest] };
}

const SHELL_KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}", "time", "exec", "esac"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// `set -e`/`set +e`, `set -o pipefail`, `set -eo pipefail`: o estado que decide
// se a falha de um comando chega ao status do passo.
function applySet(args, state) {
  for (let k = 0; k < args.length; k++) {
    const m = /^([-+])([A-Za-z]+)$/.exec(args[k]);
    if (!m) {
      if (args[k] === "--") break;
      continue;
    }
    const on = m[1] === "-";
    if (m[2].includes("e")) state.errexit = on;
    if (m[2].includes("o")) {
      const name = args[++k];
      if (name === "errexit") state.errexit = on;
      if (name === "pipefail") state.pipefail = on;
    }
  }
}

// O script em eventos, na ordem: comando (seg), comando que só mexe no
// diretório (cmd), operador (op) e abre/fecha de grupo `{ }` (kw).
// A condição de um if/elif/while/until vai da palavra-chave até o then/do: o
// bash -e não para o passo por uma falha ali, que só escolhe o desvio.
const CONDITION_OPEN = new Set(["if", "elif", "while", "until"]);
const CONDITION_CLOSE = new Set(["then", "do"]);

function scriptEvents(script, baseDir, pipefail, errexit = true) {
  const events = [];
  const saved = [];
  const dirStack = []; // a pilha do pushd/popd
  const state = { errexit, pipefail: Boolean(pipefail), condition: 0 };
  // A estrutura em volta de cada comando, para quem precisa saber o que o
  // controla (o deploy-contract-core): os blocos if/while/until/for abertos,
  // com os comandos da condição, e as listas and-or, uma por grupo ( )/{ }.
  const blocks = [];
  const frames = [{ base: [], items: [], all: [], chained: false }];
  const frame = () => frames[frames.length - 1];
  const openFrame = () => {
    const f = frame();
    frames.push({ base: f.chained ? [...f.base, ...f.items] : [...f.base], items: [], all: [], chained: false });
  };
  const closeFrame = () => {
    if (frames.length === 1) return;
    const inner = frames.pop();
    frame().items.push(...inner.all);
    frame().all.push(...inner.all);
  };
  let cwd = baseDir;
  let words = [];
  let dropTarget = false;
  const flush = () => {
    const ws = words;
    words = [];
    let i = 0;
    let negated = false;
    const assignments = [];
    while (i < ws.length) {
      if (ws[i] === "{" || ws[i] === "}") events.push({ t: "kw", v: ws[i] });
      if (ws[i] === "{") openFrame();
      else if (ws[i] === "}") closeFrame();
      if (ws[i] === "!") negated = true;
      if (CONDITION_OPEN.has(ws[i])) state.condition++;
      else if (CONDITION_CLOSE.has(ws[i]) && state.condition > 0) state.condition--;
      if (ws[i] === "if" || ws[i] === "while" || ws[i] === "until") blocks.push({ cond: [], inCond: true });
      else if (ws[i] === "elif" && blocks.length > 0) blocks[blocks.length - 1] = { cond: [], inCond: true };
      else if ((ws[i] === "then" || ws[i] === "do" || ws[i] === "else") && blocks.length > 0) blocks[blocks.length - 1].inCond = false;
      else if ((ws[i] === "fi" || ws[i] === "done") && blocks.length > 0) blocks.pop();
      if (ASSIGNMENT.test(ws[i])) assignments.push(ws[i]);
      if (SHELL_KEYWORDS.has(ws[i]) || ASSIGNMENT.test(ws[i])) i++;
      else if (ws[i] === "env" && ASSIGNMENT.test(ws[i + 1] ?? "")) i++;
      else break;
    }
    const argv = ws.slice(i);
    if (argv.length === 0) {
      // Uma linha só de atribuição (`st=$?`) também roda, sucede e vira o
      // status do passo: para o shell, é um comando — e fica à esquerda do
      // `|| exit 1` que vier depois dela na lista and-or.
      if (assignments.length > 0) {
        events.push({ t: "cmd", argv: assignments });
        frame().items.push(assignments);
        frame().all.push(assignments);
      }
      return;
    }
    if (argv[0] === "cd") {
      cwd = cdTarget(cwd, argv.slice(1));
      events.push({ t: "cmd", argv });
      return;
    }
    if (argv[0] === "pushd") {
      dirStack.push(cwd);
      cwd = pushdTarget(cwd, argv.slice(1));
      events.push({ t: "cmd", argv });
      return;
    }
    if (argv[0] === "popd") {
      cwd = dirStack.length > 0 ? dirStack.pop() : null;
      events.push({ t: "cmd", argv });
      return;
    }
    if (argv[0] === "set") applySet(argv.slice(1), state);
    // `for`/`select` não são palavras-chave do tokenizador, mas abrem um bloco
    // que o `done` fecha (sem condição: o corpo não é controlado por comando).
    if (argv[0] === "for" || argv[0] === "select") blocks.push({ cond: [], inCond: false });
    const f = frame();
    const inner = blocks.length > 0 ? blocks[blocks.length - 1] : null;
    const seg = canonicalize(argv, cwd);
    events.push({
      t: "seg",
      seg,
      negated,
      errexit: state.errexit,
      pipefail: state.pipefail,
      condition: state.condition > 0,
      // Aninhamento (blocos e grupos abertos), os comandos à esquerda na lista
      // and-or (o que decide se este roda) e a condição do bloco em volta.
      nest: blocks.length + frames.length - 1,
      left: f.chained ? [...f.base, ...f.items] : [...f.base],
      control: inner && !inner.inCond ? inner.cond.map((c) => c.argv) : [],
      // Dentro de uma subshell `( )` (um exit ali sai só dela) e quantos blocos
      // if/while/until/for estão abertos (o corpo de um deles pode não rodar).
      subshell: saved.length > 0,
      blocks: blocks.length,
    });
    if (inner && inner.inCond) inner.cond.push(seg);
    f.items.push(seg.argv);
    f.all.push(seg.argv);
  };
  for (const tk of tokenize(String(script ?? ""))) {
    if (tk.t === "word") {
      if (dropTarget) dropTarget = false; // o alvo do redirecionamento
      else words.push(tk.v);
      continue;
    }
    if (tk.t === "redirect") {
      dropTarget = true;
      continue;
    }
    dropTarget = false;
    flush();
    events.push({ t: "op", v: tk.v });
    if (tk.v === "(") saved.push(cwd);
    else if (tk.v === ")" && saved.length > 0) cwd = saved.pop();
    if (tk.v === "&&" || tk.v === "||") frame().chained = true;
    else if (tk.v === ";" || tk.v === "\n" || tk.v === "&") {
      frame().items = [];
      frame().chained = false;
    } else if (tk.v === "(") openFrame();
    else if (tk.v === ")") closeFrame();
  }
  flush();
  return events;
}

const isOpen = (e) => (e.t === "op" && e.v === "(") || (e.t === "kw" && e.v === "{");
const isClose = (e) => (e.t === "op" && e.v === ")") || (e.t === "kw" && e.v === "}");
const isSeparator = (e) => e.t === "op" && (e.v === ";" || e.v === "\n" || e.v === "&");

// O operador que decide o destino do status do comando em `i`. O último
// comando de um grupo `( )`/`{ }` passa o status para o grupo, então o
// operador que conta é o depois do fechamento.
function nextOperator(events, i) {
  let j = i + 1;
  while (j < events.length) {
    const e = events[j];
    if (isClose(e)) {
      j++;
      continue;
    }
    if (e.t === "op" && (e.v === ";" || e.v === "\n")) {
      let k = j + 1;
      while (k < events.length && events[k].t === "op" && (events[k].v === ";" || events[k].v === "\n")) k++;
      if (k < events.length && isClose(events[k])) {
        j = k;
        continue;
      }
      return { v: e.v, at: j };
    }
    if (e.t === "op") return { v: e.v, at: j };
    return null;
  }
  return null;
}

// Depois do separador em `at`, ainda há comando no mesmo nível (antes de o
// grupo fechar)? Uma linha só de atribuição conta: ela roda e vira o status.
function commandAfter(events, at) {
  let depth = 0;
  for (let j = at + 1; j < events.length; j++) {
    const e = events[j];
    if (isOpen(e)) depth++;
    else if (isClose(e)) {
      if (depth === 0) return false;
      depth--;
    } else if (e.t === "seg" || e.t === "cmd") return true;
  }
  return false;
}

// O resultado de rodar um comando dentro da lista and-or: `exit` sem
// argumento, `exit $?` e `exit N` com N≠0 tiram o shell com falha, `exit 0`
// com sucesso; `false` falha; o resto se presume que sucede.
function commandOutcome(argv) {
  if (argv[0] === "exit" || argv[0] === "return") return argv[1] === "0" ? "exit-ok" : "exit-fail";
  return argv[0] === "false" ? "fail" : "ok";
}

// `exit` sem argumento, `exit $?` e `exit N` com N≠0 levam a falha adiante;
// `false` também. `exit 0` não. Exportado para o deploy-contract-core.
export const propagates = (argv) => {
  const outcome = commandOutcome(argv);
  return outcome === "fail" || outcome === "exit-fail";
};

// O operando que começa depois do operador em `at`: um comando, ou um grupo
// ( )/{ } inteiro, com `end` no último evento dele. Num grupo, o primeiro
// `exit` decide — no { } ele sai do shell, no ( ) só da subshell —, e sem
// `exit` vale o último comando.
function operandAfter(events, at) {
  let j = at + 1;
  while (j < events.length && events[j].t === "op" && events[j].v === "\n") j++; // `a &&` + quebra de linha
  const e = events[j];
  if (!e) return null;
  if (e.t === "seg") return { end: j, outcome: commandOutcome(e.seg.argv), text: e.seg.argv.join(" ") };
  if (e.t === "cmd") return { end: j, outcome: "ok", text: e.argv.join(" ") };
  if (!isOpen(e)) return null;
  const subshell = e.t === "op";
  let depth = 0;
  let outcome = "ok";
  let decided = false;
  let k = j;
  for (; k < events.length; k++) {
    const x = events[k];
    if (isOpen(x)) depth++;
    else if (isClose(x)) {
      depth--;
      if (depth === 0) break;
    } else if (x.t === "seg" && !decided) {
      outcome = commandOutcome(x.seg.argv);
      if (outcome.startsWith("exit")) {
        decided = true;
        if (subshell) outcome = outcome === "exit-ok" ? "ok" : "fail";
      }
    }
  }
  return { end: Math.min(k, events.length - 1), outcome, text: subshell ? "( … )" : "{ … }" };
}

const AND_OR = new Set(["&&", "||", "|", "|&"]);

// Segue a falha do comando em `i` pela lista and-or em que ele está: `&&`
// pula o próximo operando, `||` o executa, e `|` o executa com o status do
// pipe (o do último, ou o pior com pipefail). Para no fim da lista (`;`,
// quebra de linha, `&` ou o fim do script) ou num `exit` executado.
function followFailure(events, i, pipefail) {
  let status = "fail";
  let lastRan = true;
  let catcher = null;
  let pos = i;
  for (let guard = 0; guard <= events.length; guard++) {
    const op = nextOperator(events, pos);
    if (!op || !AND_OR.has(op.v)) return { status, lastRan, catcher, end: op };
    const opd = operandAfter(events, op.at);
    if (!opd) return { status, lastRan, catcher, end: null };
    const pipe = op.v === "|" || op.v === "|&";
    const run = pipe ? lastRan : op.v === "&&" ? status === "ok" : status === "fail";
    if (run) {
      let o = opd.outcome;
      if (pipe && o.startsWith("exit")) o = o === "exit-ok" ? "ok" : "fail"; // num pipe, o exit é de subshell
      if (o === "exit-fail") return { exited: "fail" };
      if (o === "exit-ok") return { exited: "ok", catcher: catcher ?? `${op.v} ${opd.text}` };
      const before = status;
      status = pipe && pipefail ? (status === "fail" || o === "fail" ? "fail" : "ok") : o;
      if (before === "fail" && status === "ok" && catcher === null) catcher = `${op.v} ${opd.text}`;
    }
    lastRan = run;
    pos = opd.end;
  }
  return { status, lastRan, catcher, end: null };
}

// Por que a falha do comando em `i` não chega ao status do passo, ou null.
// Numa lista and-or, a falha só chega ao status da lista se nenhum `||`
// posterior a capturar com um lado direito que não a leve adiante; e o que
// decide o lado direito é o último operando executado, não qualquer um.
function swallowReason(events, i) {
  const e = events[i];
  if (e.condition) return "na condição de um if/elif/while/until: a falha só escolhe o desvio, não para o passo";
  if (e.negated) return "negado com !: a falha vira sucesso";
  const first = nextOperator(events, i);
  if ((first?.v === "|" || first?.v === "|&") && !e.pipefail) {
    return "num pipe sem pipefail: o status do passo é o do último comando (use shell: bash)";
  }
  const r = followFailure(events, i, e.pipefail);
  if (r.exited === "fail") return null;
  if (r.exited === "ok") return `seguido de ${r.catcher} — a falha é engolida`;
  if (r.end?.v === "&") return "em segundo plano (&): o passo não espera o status";
  if (r.status === "ok") return `seguido de ${r.catcher} — a falha é engolida`;
  // A lista termina em falha. Ela só para o passo se for o último comando, ou
  // se o bash -e pegar: ele pega quando a falha vem do último operando
  // executado da lista, e não com set +e.
  if (!(r.end && commandAfter(events, r.end.at))) return null;
  if (!e.errexit) {
    // Sem errexit o que decide é o status do ÚLTIMO comando. Um `exit` sem argumento (ou
    // `exit $?`) logo depois leva o status da falha adiante; um `exit 0`, não.
    const next = events.slice(r.end.at + 1).find((x) => x.t === "seg" || x.t === "cmd");
    if (next?.t === "seg" && (next.seg.argv[0] === "exit" || next.seg.argv[0] === "return") && propagates(next.seg.argv)) return null;
    return "depois de set +e, com comando depois: a falha não para o passo";
  }
  if (!r.lastRan) return "à esquerda de && com comando depois: o bash -e não para nessa falha";
  return null;
}

// Um `exit` (ou `return`) que encerra o shell que roda o script: ao nível do
// shell, que não fica em subshell `( )`, corpo de if/while/for ou condição, que não
// tem comando à esquerda na lista and-or decidindo se roda e que não está num pipe nem
// em segundo plano. Dentro de um grupo `{ }` ele sai do shell inteiro, sim; num `( )`,
// só da subshell, e `(exit 0) && x` roda o x.
const TERMINATORS = new Set(["exit", "return"]);
const PIPE_OPS = new Set(["|", "|&"]);

function endsTheShell(events, i) {
  const e = events[i];
  if (!TERMINATORS.has(e.seg.argv[0])) return false;
  if (e.left.length > 0 || e.condition || e.subshell || e.blocks > 0) return false;
  const before = events[i - 1];
  const after = events[i + 1];
  if (before?.t === "op" && PIPE_OPS.has(before.v)) return false;
  if (after?.t === "op" && (PIPE_OPS.has(after.v) || after.v === "&")) return false;
  return true;
}

// Cada comando com o diretório em que roda e, quando for o caso, o motivo de a
// falha dele não chegar ao status. `pipefail` e `errexit`: o shell que roda o
// script — o `bash -e` de um passo de Actions é errexit ligado (o padrão); um comando
// que o agente roda à mão é um shell sem -e e sem pipefail. `unreachable`: vem depois
// de um `exit`/`return` que encerra o shell, então nunca roda. Para o
// deploy-contract-core, cada um leva também `nest` (blocos e grupos em volta; 0 é o
// nível de topo), `left` (os argv à esquerda na lista and-or, que decidem se ele roda) e
// `control` (os argv da condição do if/while/until em cujo corpo ele está).
export function analyzeScript(script, baseDir, { pipefail = false, errexit = true } = {}) {
  const events = scriptEvents(script, baseDir, pipefail, errexit);
  const out = [];
  let ended = false;
  events.forEach((e, i) => {
    if (e.t !== "seg") return;
    out.push({
      ...e.seg,
      swallow: swallowReason(events, i),
      nest: e.nest,
      left: e.left,
      control: e.control,
      unreachable: ended,
    });
    if (!ended && endsTheShell(events, i)) ended = true;
  });
  return out;
}

/**
 * Os comandos de um script de shell, cada um com o diretório em que roda
 * (relativo à raiz do repo; null quando não dá para resolver). `cd` não vira
 * comando: muda o diretório dos seguintes, e uma subshell não o deixa vazar.
 * Atribuição de ambiente, palavra-chave do shell, redirecionamento e
 * comentário ficam de fora; o npm sai na forma canônica (ver canonicalize).
 *
 * @param {string} script
 * @param {string|null} baseDir
 * @returns {{dir: string|null, argv: string[]}[]}
 */
export function shellSegments(script, baseDir) {
  return analyzeScript(script, baseDir).map(({ dir, argv }) => ({ dir, argv }));
}

// ── Os passos dos workflows ─────────────────────────────────────────────────

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isScalar = (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
const listOf = (v) => (typeof v === "string" ? [v] : Array.isArray(v) ? v.map(String) : null);
const showList = (list) => `[${list.join(", ")}]`;

// O gatilho pull_request nas três formas de `on` (escalar, lista, mapa).
// Forma desconhecida conta como "sem pull_request": o doctor não pode lançar
// por causa de um workflow estranho. `types` sem synchronize deixa o push novo
// no PR sem o check (ressalva); sem opened, o PR aberto fica sem ele até o
// primeiro push (ressalva); sem os dois, o PR nunca é validado antes do merge
// (não conta). Filtro de base vira ressalva.
// Filtro de caminho (decisão do PO na revisão da #31): `paths` positivo deixa
// sem check todo PR que não toca aqueles caminhos, e o acerto ali não conta
// (`blocker`); `paths-ignore` recorta o contrário e vira ressalva.
function pullRequestTrigger(on) {
  const plain = { pr: true, whyNot: null, cautions: [], pathFiltered: false, blocker: null };
  const none = { pr: false, whyNot: null, cautions: [], pathFiltered: false, blocker: null };
  if (on === "pull_request") return plain;
  if (Array.isArray(on)) return on.includes("pull_request") ? plain : none;
  if (!isObject(on) || !("pull_request" in on)) return none;
  const cfg = on.pull_request;
  if (!isObject(cfg)) return plain;
  const cautions = [];
  const types = listOf(cfg.types);
  if (types && !types.includes("synchronize")) {
    if (!types.includes("opened")) {
      return { ...none, whyNot: `o pull_request dele só dispara em types: ${showList(types)}, sem opened nem synchronize` };
    }
    cautions.push(`o pull_request só dispara em types: ${showList(types)}, sem synchronize: push novo no PR fica sem o check`);
  } else if (types && !types.includes("opened")) {
    cautions.push(`o pull_request só dispara em types: ${showList(types)}, sem opened: PR aberto fica sem o check até o primeiro push`);
  }
  const branches = listOf(cfg.branches);
  if (branches) cautions.push(`o pull_request só vale para branches: ${showList(branches)}: PR para outra base fica sem o check`);
  const ignored = listOf(cfg["branches-ignore"]);
  if (ignored) cautions.push(`o pull_request tem branches-ignore: ${showList(ignored)}: PR para essas bases fica sem o check`);
  const paths = listOf(cfg.paths);
  const pathsIgnore = listOf(cfg["paths-ignore"]);
  if (pathsIgnore) cautions.push(`o pull_request tem paths-ignore: ${showList(pathsIgnore)}: PR que só toca esses caminhos fica sem o check`);
  const blocker = paths
    ? `o pull_request desse workflow só dispara com paths: ${showList(paths)}, e o PR que não toca esses caminhos fica sem check — use paths-ignore ou tire o filtro`
    : null;
  return { pr: true, whyNot: null, cautions, pathFiltered: paths !== null || pathsIgnore !== null, blocker };
}

function defaultWorkingDirectory(defaults) {
  const wd = isObject(defaults) && isObject(defaults.run) ? defaults.run["working-directory"] : undefined;
  return typeof wd === "string" ? wd : undefined;
}

function defaultShell(defaults) {
  const sh = isObject(defaults) && isObject(defaults.run) ? defaults.run.shell : undefined;
  return typeof sh === "string" ? sh : undefined;
}

// O `run:` sem `shell:` roda em `bash -e {0}`, sem pipefail; `shell: bash` é
// `bash --noprofile --norc -eo pipefail {0}`.
export const hasPipefail = (shell) => typeof shell === "string" && (shell.trim() === "bash" || /pipefail/.test(shell));

const INPUT_EXPR = /\$\{\{\s*inputs\.([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g;

function substituteInputs(text, inputs) {
  if (!inputs) return text;
  return text.replace(INPUT_EXPR, (whole, name) => (Object.hasOwn(inputs, name) ? inputs[name] : whole));
}

// Os inputs de um workflow reutilizável: o `default` do workflow_call, e por
// cima o `with:` do chamador. Valor que ainda depende de expressão deixa o
// input desconhecido — a expressão fica no texto e não casa com nada.
function callInputs(calledDoc, withBlock, outer) {
  const out = {};
  const call = isObject(calledDoc.on) ? calledDoc.on.workflow_call : undefined;
  const declared = isObject(call) && isObject(call.inputs) ? call.inputs : {};
  for (const [name, spec] of Object.entries(declared)) {
    if (isObject(spec) && isScalar(spec.default)) out[name] = String(spec.default);
  }
  if (isObject(withBlock)) {
    for (const [name, value] of Object.entries(withBlock)) {
      if (!isScalar(value)) continue;
      const s = substituteInputs(String(value), outer);
      if (s.includes("${{")) delete out[name];
      else out[name] = s;
    }
  }
  return out;
}

// continue-on-error: qualquer valor presente que não seja false — inclusive uma
// expressão, que não dá para avaliar aqui — pode deixar a falha passar.
export const continuesOnError = (v) => v !== undefined && v !== null && v !== false && v !== "false";

// O `if:` de passo ou job: `false` (booleano, texto ou `${{ false }}`) nunca
// roda; always() e !cancelled() rodam mesmo com um needs pulado; success() e
// true são o padrão. O resto é condição: há PR em que o comando não roda.
export function classifyIf(value) {
  if (value === undefined || value === null || value === true) return null;
  if (value === false) return { never: true };
  const text = String(value).trim();
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(text);
  const inner = (wrapped ? wrapped[1] : text).trim();
  const compact = inner.replace(/\s+/g, "");
  if (compact === "false") return { never: true };
  if (compact === "true" || compact === "success()") return null;
  if (compact === "always()" || compact === "!cancelled()") return { always: true };
  return { cond: text };
}

// O destino de um job, com a cadeia de `needs`: um job pulado reporta Success
// no GitHub, e quem depende dele é pulado junto — a não ser que o próprio if
// seja always() ou !cancelled().
export function jobGate(jobs, jobId, memo, visiting = new Set()) {
  if (memo.has(jobId)) return memo.get(jobId);
  if (visiting.has(jobId)) return { never: null, conds: [] }; // ciclo: o GitHub recusa o workflow
  visiting.add(jobId);
  const job = jobs[jobId];
  const own = classifyIf(isObject(job) ? job.if : undefined);
  let result;
  if (own?.never) {
    result = { never: `o job ${jobId} tem if: false`, conds: [] };
  } else {
    const conds = own?.cond ? [`só roda quando if: ${own.cond} (job ${jobId})`] : [];
    let never = null;
    if (!own?.always) {
      const needs = typeof job?.needs === "string" ? [job.needs] : Array.isArray(job?.needs) ? job.needs : [];
      for (const n of needs) {
        if (typeof n !== "string" || !isObject(jobs[n])) continue;
        const up = jobGate(jobs, n, memo, visiting);
        if (up.never) {
          never = `o job ${jobId} depende (needs) de ${n}, e ${up.never}`;
          break;
        }
        for (const c of up.conds) if (!conds.includes(c)) conds.push(c);
      }
    }
    result = { never, conds };
  }
  visiting.delete(jobId);
  memo.set(jobId, result);
  return result;
}

const LOCAL_WORKFLOW = /^\.\/\.github\/workflows\/([^/@]+\.ya?ml)$/;
const MAX_CALL_DEPTH = 4; // o limite de aninhamento do GitHub Actions

function walkWorkflow(file, doc, ctx, byFile, records) {
  const jobs = isObject(doc.jobs) ? doc.jobs : {};
  const workflowDir = defaultWorkingDirectory(doc.defaults);
  const workflowShell = defaultShell(doc.defaults);
  const gates = new Map();
  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isObject(job)) continue;
    const gate = jobGate(jobs, jobId, gates);
    const never = ctx.never ?? gate.never;
    const cautions = [...ctx.cautions, ...gate.conds.filter((c) => !ctx.cautions.includes(c))];
    if (typeof job.uses === "string") {
      // Só o reutilizável local dá para seguir; o remoto fica de fora.
      const local = LOCAL_WORKFLOW.exec(job.uses.trim());
      const called = local ? local[1] : null;
      const calledDoc = called ? byFile.get(called) : undefined;
      if (!isObject(calledDoc) || ctx.stack.includes(called) || ctx.stack.length > MAX_CALL_DEPTH) continue;
      walkWorkflow(
        called,
        calledDoc,
        {
          pr: ctx.pr,
          prWhyNot: ctx.prWhyNot,
          pathFiltered: ctx.pathFiltered,
          blocker: ctx.blocker,
          never: never ? `${never} (chama ${called})` : null,
          cautions,
          inputs: callInputs(calledDoc, job.with, ctx.inputs),
          via: [...ctx.via, `${file} › ${jobId}`],
          stack: [...ctx.stack, called],
        },
        byFile,
        records,
      );
      continue;
    }
    const jobDir = defaultWorkingDirectory(job.defaults);
    const jobShell = defaultShell(job.defaults);
    const steps = Array.isArray(job.steps) ? job.steps : [];
    steps.forEach((step, index) => {
      if (!isObject(step) || typeof step.run !== "string") return;
      const coe = [step["continue-on-error"], job["continue-on-error"]].find(continuesOnError);
      const nonBlocking = coe !== undefined;
      const stepName = typeof step.name === "string" ? step.name : `passo ${index + 1}`;
      const stepIf = classifyIf(step.if);
      // Precedência do GitHub Actions: passo, depois job, depois workflow.
      const raw = typeof step["working-directory"] === "string" ? step["working-directory"] : (jobDir ?? workflowDir ?? "");
      const dir = joinDir("", substituteInputs(raw, ctx.inputs));
      records.push({
        file,
        job: jobId,
        step: stepName,
        via: ctx.via,
        pr: ctx.pr,
        prWhyNot: ctx.prWhyNot,
        pathFiltered: ctx.pathFiltered,
        blocker: ctx.blocker,
        never: never ?? (stepIf?.never ? `o passo "${stepName}" tem if: false` : null),
        nonBlocking,
        cautions: [
          ...cautions,
          ...(stepIf?.cond ? [`só roda quando if: ${stepIf.cond} (passo "${stepName}")`] : []),
          ...(nonBlocking ? [`continue-on-error: ${String(coe)}: a falha não bloqueia o PR`] : []),
        ],
        segments: analyzeScript(substituteInputs(step.run, ctx.inputs), dir, {
          pipefail: hasPipefail(typeof step.shell === "string" ? step.shell : (jobShell ?? workflowShell)),
        }),
      });
    });
  }
}

function collectSteps(workflows) {
  const records = [];
  const warnings = [];
  const byFile = new Map();
  for (const w of workflows) {
    if (!isObject(w)) continue;
    const file = String(w.file ?? "");
    if (w.error != null) {
      warnings.push(
        `${file} não é YAML válido (${w.error}) — ficou fora da conferência; o GitHub também não roda um workflow inválido`,
      );
      continue;
    }
    byFile.set(file, w.doc);
  }
  for (const [file, doc] of byFile) {
    if (!isObject(doc)) continue;
    const trigger = pullRequestTrigger(doc.on);
    const { pathFiltered } = trigger;
    walkWorkflow(
      file,
      doc,
      {
        pr: trigger.pr,
        prWhyNot: trigger.whyNot,
        pathFiltered,
        blocker: trigger.blocker,
        never: null,
        cautions: trigger.cautions,
        inputs: null,
        via: [],
        stack: [file],
      },
      byFile,
      records,
    );
  }
  return { records, warnings };
}

// ── O contrato ──────────────────────────────────────────────────────────────

const MANDATE = "aiteam/AGENTS.md §CI/CD Mandate, item 1";
const TEMPLATE = "aiteam/templates/ci.yml.example";
const WHAT = { test: "os testes", local_test: "o portão local de testes", typecheck: "o typecheck", lint: "o lint" };
// Comando que não falha nunca: um ci.test feito só disso é um opt-out sem reason.
const isNoop = (seg) =>
  ["echo", "printf", "true", ":", "set", "export", "unset", "shopt", "sleep", "pwd"].includes(seg.argv[0]) ||
  (seg.argv[0] === "exit" && (seg.argv.length === 1 || seg.argv[1] === "0"));
// Comando que não roda suíte nenhuma não decide se um script "é da app".
const TRIVIAL = new Set(["echo", "printf", "true", ":", "exit", "set", "export", "shopt", "[", "sleep"]);

const insideFramework = (dir) => typeof dir === "string" && (dir === FRAMEWORK_DIR || dir.startsWith(`${FRAMEWORK_DIR}/`));
const inDir = (dir) => (dir === null ? "num diretório que não dá para resolver" : dir === "" ? "na raiz" : `em ${dir}/`);
const workdirLabel = (dir) => (dir === "" ? "raiz" : `${dir}/`);
const whereLabel = (r) => [...r.via, `${r.file} › ${r.job}`].join(" → ");
const sameArgv = (a, b) => a.length === b.length && a.every((w, i) => w === b[i]);

// A sequência declarada aparece, em ordem, entre os comandos do passo.
// Devolve os comandos do passo que casaram, um por declarado, ou null.
function findSequence(haystack, needle, withDir) {
  const matched = [];
  for (const s of haystack) {
    if (matched.length === needle.length) break;
    const n = needle[matched.length];
    if (sameArgv(s.argv, n.argv) && (!withDir || (s.dir !== null && s.dir === n.dir))) matched.push(s);
  }
  return needle.length > 0 && matched.length === needle.length ? matched : null;
}

function dedupe(records) {
  const seen = new Set();
  return records.filter((r) => {
    const id = whereLabel(r);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// `npm run <script>`, já na forma canônica → o nome do script. Com -w ou
// --workspace o script mora noutro package.json, e o núcleo não o segue.
function npmScriptName(seg) {
  const [bin, ...args] = seg.argv;
  if (bin !== "npm") return null;
  if (args.some((a) => /^(?:-w|-ws|--workspaces?)(?:=.*)?$/.test(a))) return null;
  const k = npmSubcommandIndex(args);
  if (k === -1 || args[k] !== "run") return null;
  return args.slice(k + 1).find((a) => !a.startsWith("-")) ?? null;
}

function readScriptsSafely(readScripts, dir) {
  try {
    const scripts = readScripts(dir);
    return isObject(scripts) ? scripts : null;
  } catch {
    return null;
  }
}

// Segue os `npm run <script>` até as folhas. Para no salto que entra em
// aiteam/: dali para dentro é o framework, e é isso que se quer saber.
function expandScripts(segments, readScripts, depth, seen, trail, leaves) {
  for (const s of segments) {
    const name = npmScriptName(s);
    if (name !== null && s.dir !== null && !insideFramework(s.dir) && depth < 8) {
      const scripts = readScriptsSafely(readScripts, s.dir);
      const body = scripts && typeof scripts[name] === "string" ? scripts[name] : null;
      const id = `${s.dir}\u0000${name}`;
      if (body !== null && !seen.has(id)) {
        seen.add(id);
        trail.push({ dir: s.dir, name, body });
        expandScripts(shellSegments(body, s.dir), readScripts, depth + 1, seen, trail, leaves);
        continue;
      }
    }
    leaves.push(s);
  }
}

// O caso do vigacapital: o `npm test` da raiz existe e roda em PR, mas o
// script é `npm --prefix aiteam run test` — roda a suíte do framework. Segue a
// cadeia de scripts npm e recusa quando tudo o que sobra roda dentro de
// aiteam/. No próprio framework (workdir dentro de aiteam/) não se aplica.
function frameworkDelegation(key, declared, workdir, readScripts) {
  if (insideFramework(workdir)) return null;
  const trail = [];
  const leaves = [];
  expandScripts(declared, readScripts, 0, new Set(), trail, leaves);
  const real = leaves.filter((s) => !TRIVIAL.has(s.argv[0]));
  if (real.length === 0 || !real.every((s) => insideFramework(s.dir))) return null;
  const fix = `declare em ci.${key} o comando que roda ${WHAT[key]} da aplicação`;
  if (trail.length === 0) return `roda ${inDir(real[0].dir)}, que é o framework vendorizado, não a app — ${fix}`;
  const chain = trail.map((t) => `o script ${t.name} de ${t.dir === "" ? "" : `${t.dir}/`}package.json é \`${t.body}\``);
  return `só delega para o framework vendorizado: ${chain.join(", e ")} — isso roda a suíte do ${FRAMEWORK_DIR}/, não a da app; ${fix}`;
}

const OTHER_RUNNERS = new Set(["pnpm", "yarn", "bun"]);

// O script de package.json que o comando chama: `npm run <script>` (já na forma
// canônica) ou `pnpm|yarn|bun run <script>`. Flag antes do `run` (pnpm --filter x
// run …) deixa o nome desconhecido: nesse caso não se julga, nunca se chuta.
function scriptRunName(seg) {
  const bin = seg.argv[0];
  if (bin === "npm") return npmScriptName(seg);
  if (!OTHER_RUNNERS.has(bin)) return null;
  const [run, name] = seg.argv.slice(1);
  return run === "run" && typeof name === "string" && !name.startsWith("-") ? name : null;
}

const within = (dir, base) => base === "" || dir === base || dir.startsWith(`${base}/`);

// O portão local do TDD (ci.local_test, rb-ai-team#51): o comando que o agente
// roda no loop Red-Green-Refactor no lugar do ci.test, quando o projeto o
// declara — a suíte completa pode não caber na máquina de quem a roda. É só
// local: nenhum workflow precisa rodá-lo, e ele não entra na conferência dos
// workflows nem dispensa o `test`, que o CI de PR segue rodando por inteiro.
// O que se confere é que o comando é um portão de verdade e é o da app do
// workdir: não é vazio nem `none`, pode falhar, não só delega para o framework
// vendorizado, o script de package.json que chama existe onde roda, e roda
// dentro do workdir (fora dele, ressalva).
function judgeLocalTest(ci, scripts, fail, warn) {
  const key = "local_test";
  const command = ci.local_test.trim();
  if (command === "") {
    fail(key, "ci.local_test está declarado sem comando — omita a chave (sem ela os agentes rodam o ci.test) ou declare o comando do portão local");
    return;
  }
  if (command.toLowerCase() === "none") {
    fail(key, "ci.local_test: none não é opt-out — omita a chave: sem ela os agentes rodam o ci.test");
    return;
  }
  const label = `ci.local_test \`${command}\` (workdir: ${workdirLabel(ci.workdir)})`;
  // Quem roda o local_test é o agente, à mão: um shell sem -e e sem pipefail, e não o
  // `bash -e` de um passo de Actions. Analisado como os passos (errexit ligado), um
  // `npm run test:changed; exit 0` passava limpo, e um portão que não pode falhar não é um.
  const declared = analyzeScript(command, ci.workdir, { pipefail: false, errexit: false });
  if (declared.length === 0) {
    fail(key, `${label} não roda comando nenhum`);
    return;
  }
  // O que vem depois de um exit/return que encerra o shell nunca roda.
  const live = declared.filter((s) => !s.unreachable);
  const dead = declared.filter((s) => s.unreachable && !TRIVIAL.has(s.argv[0]));
  if (dead.length > 0 && live.every((s) => TRIVIAL.has(s.argv[0]) || s.argv[0] === "return")) {
    fail(
      key,
      `${label} nunca roda o que declara: ${dead.map((s) => s.argv.join(" ")).join(", ")} vem depois de um exit/return, e o shell sai antes — tire o exit`,
    );
    return;
  }
  if (live.every(isNoop)) {
    fail(key, `${label} não roda nada que possa falhar — se o projeto não tem portão local, omita a chave`);
    return;
  }
  if (dead.length > 0) {
    warn(key, `${label} tem código que nunca roda: ${dead.map((s) => s.argv.join(" ")).join(", ")} vem depois de um exit/return`);
  }
  const asAgent = (reason) =>
    reason
      .replace("depois de set +e", "num shell sem set -e (o do agente)")
      .replace("(use shell: bash)", "(o agente roda num shell sem pipefail: use && em vez de |)");
  for (const s of live) {
    if (s.swallow) warn(key, `${label} engole a própria falha: ${s.argv.join(" ")} ${asAgent(s.swallow)}`);
  }
  if (live.some((s) => s.argv[0] === "npm" && s.argv.includes("--if-present"))) {
    warn(key, `${label} usa --if-present: sem o script, o comando passa sem rodar nada`);
  }
  const delegation = frameworkDelegation(key, live, ci.workdir, scripts);
  if (delegation) {
    fail(key, `${label} ${delegation}`);
    return;
  }
  const seen = new Set();
  for (const s of live) {
    const name = scriptRunName(s);
    if (name === null || s.dir === null) continue;
    const id = `${s.dir}\u0000${name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const list = readScriptsSafely(scripts, s.dir);
    if (list !== null && !Object.hasOwn(list, name)) {
      fail(
        key,
        `${label} chama o script ${name}, que o package.json ${s.dir === "" ? "da raiz" : `de ${s.dir}/`} não tem — declare o script lá, ou o comando que roda de verdade`,
      );
    }
  }
  // Um diretório que não se resolve (cd /tmp, cd $HOME, npm --prefix /abs, subir acima da
  // raiz) também é fora do workdir: não dá para provar que é o da app, e antes era o
  // que escapava do aviso.
  const outside = [
    ...new Set(live.filter((s) => !TRIVIAL.has(s.argv[0]) && (s.dir === null || !within(s.dir, ci.workdir))).map((s) => s.dir)),
  ];
  if (outside.length > 0) {
    warn(
      key,
      `${label} roda ${outside.map(inDir).join(" e ")}, fora do workdir declarado (${workdirLabel(ci.workdir)}) — o portão local tem de ser o da app do workdir`,
    );
  }
}

/**
 * O contrato do item 1 do CI/CD Mandate: cada comando declarado no bloco `ci:`
 * do SPEC.md tem de aparecer num passo `run:` de workflow disparado em
 * pull_request, rodando no `workdir` declarado — contando o working-directory
 * do passo, do job e do workflow, `cd`, `npm --prefix` e os workflows
 * reutilizáveis locais. `test` é obrigatório (ou `test: none` com `reason:`);
 * `typecheck` e `lint`, só quando declarados. Um comando que só delega para o
 * aiteam/ é recusado. `local_test`, o portão local do TDD, é opcional e só
 * local: não é procurado nos workflows e não substitui o `test` (ver judgeLocalTest).
 *
 * Achado `fail` reprova; `warn` passa com ressalva (opt-out, paths-ignore,
 * types sem synchronize, filtro de base, if: condicional, continue-on-error,
 * falha engolida pelo shell, workflow ilegível, workflows não conferidos). Um
 * `paths:` positivo no workflow do acerto reprova.
 *
 * @param {{specText: string|null|undefined,
 *          workflows: Array<{file: string, doc?: unknown, error?: string}>|null,
 *          readScripts?: (dir: string) => Record<string, unknown>|null|undefined,
 *          rootManifests?: string[]}} input
 *   workflows: null quando não há parser YAML para lê-los (o doctor sem
 *   node_modules) — o bloco e a delegação ainda são julgados.
 *   readScripts(dir): o `scripts` do package.json em <dir> (relativo à raiz),
 *   ou null quando não há.
 *   rootManifests: os manifestos de app achados na raiz (ver isAppManifest).
 *   Com algum deles, um ci.workdir dentro de aiteam/ reprova: só o repo do
 *   próprio framework, que não tem manifesto na raiz, declara o workdir ali.
 */
export function evaluateCiContract({ specText, workflows, readScripts, rootManifests }) {
  const findings = [];
  const located = [];
  const fail = (key, message) => findings.push({ level: "fail", key, message });
  const warn = (key, message) => findings.push({ level: "warn", key, message });
  const scripts = typeof readScripts === "function" ? readScripts : () => null;

  if (specText === null || specText === undefined) {
    fail("spec", `SPEC.md não encontrado na raiz do repo — é ele que declara, no bloco ci: do frontmatter, o que o CI de PR roda (${MANDATE})`);
    return { block: { state: "absent" }, findings, located };
  }
  const block = readCiBlock(specText);
  if (block.state === "absent") {
    fail(
      "ci",
      "SPEC.md não declara o bloco ci: no frontmatter. Declare nele o comando que roda os testes da APP em PR " +
        "(test:, obrigatório), typecheck: e lint: se o projeto os tiver, e workdir: se a app não estiver na raiz — " +
        `ou, sem suíte automatizada, test: none com reason:. Ver ${MANDATE}`,
    );
    return { block, findings, located };
  }
  if (block.state === "malformed") {
    fail("ci", `o bloco ci: do SPEC.md não pôde ser lido — ${block.reason}`);
    return { block, findings, located };
  }

  const { ci } = block;
  // Quem clona o framework como template herda o workdir: aiteam deste SPEC.md
  // e põe a app na raiz; o contrato passava testando só o framework.
  const manifests = Array.isArray(rootManifests) ? rootManifests.filter((m) => typeof m === "string") : [];
  if (insideFramework(ci.workdir) && manifests.length > 0) {
    fail(
      "ci",
      `a raiz tem uma app (${manifests.join(", ")}), mas ci.workdir aponta para o framework vendorizado ` +
        `(${workdirLabel(ci.workdir)}) — declare em ci.workdir o diretório da app (a raiz, por padrão) e rode os ` +
        `comandos dela num job de PR (modelo: ${TEMPLATE}, job app)`,
    );
    return { block, findings, located };
  }
  const commands = [];
  if (ci.test === null) {
    fail("test", "ci.test é obrigatório: o comando que roda os testes da app em PR — ou test: none com reason:, se o projeto não tem suíte automatizada");
  } else if (ci.test.trim() === "none") {
    if (ci.reason === null) fail("test", "ci.test: none exige reason: — o motivo de o projeto não ter suíte automatizada fica visível no SPEC.md e no doctor");
    else warn("test", `opt-out declarado: ci.test é none — ${ci.reason}`);
  } else {
    commands.push({ key: "test", command: ci.test.trim() });
  }
  for (const key of ["typecheck", "lint"]) {
    const v = ci[key];
    if (v === null) continue;
    if (v.trim() === "none") {
      fail(key, `ci.${key}: none não é opt-out — omita a chave: ${key} só é exigido quando declarado`);
      continue;
    }
    commands.push({ key, command: v.trim() });
  }

  let records = null;
  if (workflows === null || workflows === undefined) {
    warn("workflows", "os workflows de .github/workflows não foram conferidos — só o bloco ci: e os scripts do package.json");
  } else {
    const collected = collectSteps(workflows);
    records = collected.records;
    for (const w of collected.warnings) warn("workflows", w);
  }

  for (const { key, command } of commands) {
    const label = `ci.${key} \`${command}\` (workdir: ${workdirLabel(ci.workdir)})`;
    // pipefail ligado: o pipe se julga pelo shell do passo, não aqui.
    const declared = analyzeScript(command, ci.workdir, { pipefail: true });
    if (declared.length === 0) {
      fail(key, `${label} não roda comando nenhum`);
      continue;
    }
    // Só comando que não falha nunca: um opt-out disfarçado, sem o reason.
    if (declared.every(isNoop)) {
      fail(
        key,
        key === "test"
          ? `${label} não roda nada que possa falhar — se o projeto não tem suíte automatizada, use test: none com reason:`
          : `${label} não roda nada que possa falhar — se o projeto não tem ${key}, omita a chave`,
      );
      continue;
    }
    for (const s of declared) {
      if (s.swallow) warn(key, `${label} engole a própria falha: ${s.argv.join(" ")} ${s.swallow}`);
    }
    if (declared.some((s) => s.argv[0] === "npm" && s.argv.includes("--if-present"))) {
      warn(key, `${label} usa --if-present: sem o script, o comando passa sem rodar nada`);
    }
    const delegation = frameworkDelegation(key, declared, ci.workdir, scripts);
    if (delegation) {
      fail(key, `${label} ${delegation}`);
      continue;
    }
    if (records === null) continue;

    const hits = [];
    for (const r of records) {
      const m = r.pr && !r.never ? findSequence(r.segments, declared, true) : null;
      if (!m) continue;
      // Ressalva do passo (gatilho, continue-on-error) e a do shell: o
      // comando achado cuja falha não chega ao status do passo.
      // A ressalva que já vem da própria declaração (|| true) não se repete aqui.
      const swallowed = m.map((s, k) => (declared[k].swallow ? null : s.swallow)).filter(Boolean);
      hits.push({ ...r, dir: m[0].dir, cautions: [...new Set([...r.cautions, ...swallowed])] });
    }
    // Acerto num workflow de paths positivo não conta: há PR sem esse check.
    const blocked = hits.filter((h) => h.blocker);
    const usable = hits.filter((h) => !h.blocker);
    if (usable.length === 0 && blocked.length > 0) {
      const b = dedupe(blocked);
      fail(key, `${label} só roda em ${b.map(whereLabel).join(", ")}, mas ${b[0].blocker}`);
      continue;
    }
    if (usable.length > 0) {
      const clean = usable.filter((h) => h.cautions.length === 0);
      const unique = dedupe(clean.length > 0 ? clean : usable);
      located.push({
        key,
        command,
        workdir: ci.workdir,
        where: unique.map((h) => ({
          file: h.file,
          job: h.job,
          step: h.step,
          via: h.via,
          dir: h.dir,
          pathFiltered: h.pathFiltered,
          nonBlocking: h.nonBlocking,
          cautions: h.cautions,
        })),
      });
      if (clean.length === 0) {
        warn(key, `${label} só roda com ressalva — ${unique.map((h) => `${whereLabel(h)} (${h.cautions.join("; ")})`).join(", ")}`);
      }
      continue;
    }

    const parts = [`${label} não roda em nenhum passo run: de workflow disparado em pull_request ${inDir(ci.workdir)}`];
    for (const r of records) {
      const m = r.pr && !r.never ? findSequence(r.segments, declared, false) : null;
      if (!m) continue;
      parts.push(
        `o mesmo comando roda ${inDir(m[0].dir)}, em ${whereLabel(r)}` +
          (insideFramework(m[0].dir) ? ", que é o framework vendorizado, não a app" : ""),
      );
      break;
    }
    const never = records.find((r) => r.pr && r.never && findSequence(r.segments, declared, true));
    if (never) parts.push(`está em ${whereLabel(never)}, mas não roda nunca: ${never.never}`);
    const offPr = records.find((r) => !r.pr && findSequence(r.segments, declared, true));
    if (offPr) parts.push(`roda em ${whereLabel(offPr)}, mas ${offPr.prWhyNot ?? "esse workflow não dispara em pull_request"}`);
    parts.push(`rode-o num job de PR ${inDir(ci.workdir)} — modelo: ${TEMPLATE} (job app)`);
    fail(key, parts.join("; "));
  }

  if (ci.local_test !== null) judgeLocalTest(ci, scripts, fail, warn);

  return { block, findings, located };
}
