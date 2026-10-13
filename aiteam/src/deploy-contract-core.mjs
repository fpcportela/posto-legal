// Núcleo puro do contrato de deploy — AGENTS.md §CI/CD Mandate (rb-ai-team#32).
// O projeto declara no frontmatter do SPEC.md, no bloco `deploy:`, o workflow
// de deploy de produção e a URL de versão que ele consulta; este módulo lê esse
// bloco e confere, no workflow declarado, as três peças do rollback-by-rerun:
// o input `ref` que chega ao deploy, a consulta à versão servida e a tag
// `deploy/` criada depois do health check. É a única fonte dessa lógica: o
// aiteam/src/deploy-contract.test.ts (o contrato, no CI) e o doctor
// (aiteam/src/doctor-core.mjs) o importam.
//
// Existe porque o contrato era prosa em quatro arquivos e o consumidor que
// servia de dogfood violava dois itens sem que nada percebesse: o passo remoto
// fazia `git pull` (re-rodar com a tag anterior subia main de novo) e o health
// check olhava só o status, que não distingue a versão nova da antiga.
//
// Sem dependências e sem shebang, pelo mesmo motivo do ci-contract-core.mjs, de
// quem reaproveita o leitor de escalar e o tokenizador de shell: o bloco é lido
// linha a linha e os workflows chegam já parseados.

import {
  analyzeScript,
  classifyIf,
  continuesOnError,
  hasPipefail,
  jobGate,
  parseScalar,
  propagates,
  shellSegments,
} from "./ci-contract-core.mjs";
import { extractFrontmatter } from "./frontmatter.mjs";

const DEPLOY_KEYS = ["workflow", "version_url", "reason"];

const DEPLOY_HEADER = /^deploy[ \t]*:(.*)$/;
const BLANK_OR_COMMENT = /^[ \t]*(?:#.*)?$/;
const NOTHING_OR_COMMENT = /^(?:[ \t]*|[ \t]+#.*)$/;
const ENTRY = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:(?:[ \t]+(.*))?$/;

const malformed = (reason) => ({ state: "malformed", reason });

// O parseScalar é do bloco ci:, e as mensagens dele falam de "comando" e do
// "leitor do ci:". Aqui o valor é um arquivo ou uma URL.
const asDeploy = (reason) =>
  String(reason).replace(/leitor do ci:/g, "leitor do deploy:").replace(/\bo comando\b/g, "o valor").replace(/\bum comando\b/g, "um valor");

// O nome do arquivo em .github/workflows/; o caminho completo também vale.
function normalizeWorkflow(raw) {
  if (raw === null) return { ok: true, value: null };
  const p = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (p === "none") return { ok: true, value: "none" };
  if (p.includes("$")) return { ok: false, reason: "workflow não aceita variável — use o nome literal do arquivo" };
  const m = /^(?:\.github\/workflows\/)?([^/]+)$/.exec(p);
  if (!m || m[1] === "." || m[1] === "..") {
    return { ok: false, reason: `workflow é um arquivo de .github/workflows/ (ex.: deploy.yml), não "${raw}"` };
  }
  if (!/\.ya?ml$/.test(m[1])) return { ok: false, reason: `workflow tem de ser um .yml ou .yaml de .github/workflows/, não "${raw}"` };
  return { ok: true, value: m[1] };
}

/**
 * Lê o bloco `deploy:` do frontmatter do SPEC.md, sem parser YAML, do mesmo
 * jeito que o readCiBlock lê o `ci:`: chaves `workflow`, `version_url` e
 * `reason`, cada valor numa linha, sem aspas ou entre aspas. O bloco vai da
 * chave `deploy` de coluna 0 até a próxima chave de coluna 0. O opt-out é
 * `workflow: none` com `reason:`. O que o leitor não sabe ler com certeza vira
 * `malformed` com o motivo, citando a linha do SPEC.md.
 *
 * Não julga o conteúdo: workflow ausente, version_url ausente ou `none` sem
 * `reason` são achados do evaluateDeployContract, não erro de leitura.
 *
 * @param {string|null|undefined} specText
 */
export function readDeployBlock(specText) {
  const fm = extractFrontmatter(specText);
  if (fm === null) return { state: "absent" };
  const lines = fm.split("\n");
  const at = (i) => `SPEC.md:${i + 2}`;

  let header = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = DEPLOY_HEADER.exec(lines[i]);
    if (!m) continue;
    if (header !== -1) return malformed(`${at(i)}: o bloco deploy: aparece duas vezes no frontmatter`);
    header = i;
    if (!NOTHING_OR_COMMENT.test(m[1])) {
      return malformed(
        `${at(i)}: deploy: tem de ser um bloco, com cada chave numa linha indentada abaixo dele — ` +
          `workflow: e version_url:, ou o opt-out workflow: none com reason:`,
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
    if (lead === "") break;
    if (lead.includes("\t")) return malformed(`${at(i)}: tab na indentação — o YAML só aceita espaços`);
    if (indent === null) indent = lead.length;
    if (lead.length !== indent) {
      return malformed(
        `${at(i)}: indentação diferente das outras chaves de deploy: — valor em mais de uma linha ou aninhado não é aceito; escreva cada valor numa linha só`,
      );
    }
    const m = ENTRY.exec(line.slice(indent));
    if (!m) return malformed(`${at(i)}: a linha não é uma chave "chave: valor" de deploy:`);
    const key = m[1];
    if (!DEPLOY_KEYS.includes(key)) {
      return malformed(`${at(i)}: chave desconhecida deploy.${key} — as aceitas são ${DEPLOY_KEYS.join(", ")}`);
    }
    if (values.has(key)) return malformed(`${at(i)}: deploy.${key} aparece duas vezes`);
    const v = parseScalar(m[2] ?? "");
    if (!v.ok) return malformed(`${at(i)}: deploy.${key}: ${asDeploy(v.reason)}`);
    values.set(key, v.value);
  }

  const text = (key) => {
    const v = values.get(key);
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  };
  const workflow = normalizeWorkflow(text("workflow"));
  if (!workflow.ok) return malformed(`deploy.workflow: ${workflow.reason}`);
  return {
    state: "ok",
    deploy: { workflow: workflow.value, version_url: text("version_url"), reason: text("reason") },
  };
}

// ── Os passos do workflow declarado ─────────────────────────────────────────

const TEMPLATE = "aiteam/templates/deploy.yml.example";
const MANDATE = "aiteam/AGENTS.md §CI/CD Mandate";
const LOCAL_WORKFLOW = /^\.\/\.github\/workflows\/([^/@]+\.ya?ml)$/;
const MAX_CALL_DEPTH = 4;
const MAX_SCRIPT_DEPTH = 3;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isScalar = (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const refersVar = (text, name) => new RegExp(`\\$\\{?${escapeRe(name)}(?![A-Za-z0-9_])`).test(text);

// Uma expressão `${{ … }}` que contém um dos padrões de `inner`.
const exprWith = (inner) => new RegExp(String.raw`\$\{\{[^}]*?(?:${inner})[^}]*\}\}`);
// O input do dispatch: `inputs.ref` e `github.event.inputs.ref`, nunca
// `inputs.refs` nem `inputs.ref_name`. Num workflow reutilizável, `inputs.*` é
// do chamado: ali a ref chega pelo input que o chamador preencheu com ela.
const TOP_REF = String.raw`\binputs\.ref(?![\w-])`;
const calleeRef = (names) =>
  [String.raw`\bgithub\.event\.inputs\.ref(?![\w-])`, ...names.map((n) => String.raw`\binputs\.${escapeRe(n)}(?![\w-])`)].join("|");

// `git pull` só sabe avançar o branch corrente: pousa sempre na main, e o
// rollback com a tag anterior sobe a main de novo.
const GIT_PULL = /\bgit(?:\s+(?:-[cC]\s+\S+|--[\w-]+(?:=\S+)?))*\s+pull\b/;
// Num workflow_dispatch, github.sha é o HEAD do branch do dispatch, não o SHA
// da ref pedida: o rollback subiria a main e marcaria uma tag nova nela.
const GITHUB_SHA = /\$\{\{[^}]*\bgithub\.sha\b[^}]*\}\}|\$\{?GITHUB_SHA\b/;
// git reset --hard origin/<branch>, e git checkout/switch de um nome literal
// (sem variável): o host pousa num branch fixo, seja qual for a ref pedida.
// Não avisa quando não muda de versão — restaurar arquivo (checkout ., ou
// qualquer coisa com `--`) — nem quando um reset --hard / checkout / switch
// posterior, no mesmo texto, pousa na variável que carrega o SHA
// (`git checkout main && git reset --hard $V`). `carries(args)` diz se os
// argumentos de um comando git referenciam essa variável.
const GIT_PIN = /\bgit(?:\s+(?:-[cC]\s+\S+|--[\w-]+(?:=\S+)?))*\s+(reset\s+--hard|checkout|switch)\b([^\n;&|)]*)/g;
function pinnedRefs(text, carries = () => false) {
  const out = [];
  const t = String(text);
  for (const m of t.matchAll(GIT_PIN)) {
    const args = m[2].trim().split(/\s+/).map((a) => a.replace(/^["']+|["']+$/g, "")).filter(Boolean);
    if (args.includes("--")) continue;
    const target = args.find((a) => !a.startsWith("-"));
    if (!target || target === "." || /[$`]/.test(target)) continue;
    if (m[1].startsWith("reset") && !/^(?:origin|upstream)\/[\w./-]+$/.test(target)) continue;
    const rest = t.slice(m.index + m[0].length);
    if ([...rest.matchAll(GIT_PIN)].some((later) => carries(later[2]))) continue;
    out.push(`git ${m[1].replace(/\s+/g, " ")} ${target}`);
  }
  return out;
}

// Um passo que fala com o host: ssh, scp, rsync, ou uma action deles.
const REMOTE_COMMANDS = new Set(["ssh", "scp", "rsync", "sshpass"]);
const REMOTE_ACTION = /ssh|scp|rsync/i;
// ssh, scp ou rsync como palavra em qualquer lugar do código sem comentário:
// cobre o que o remoteCommand não desembrulha (eval "ssh …", "$SSH" h com
// SSH=ssh, stdbuf, flock). Não casa ~/.ssh, ssh-keyscan nem ssh_config.
const REMOTE_WORD = /(?:^|[^\w.-])(?:ssh|scp|rsync)(?![\w.-])/m;
// Um comando fala com o host? Antes de olhar ssh/scp/rsync, tira os embrulhos
// (timeout, sudo, env, nice, nohup, command, com as flags e atribuições deles)
// e entra no script de um bash -c / sh -c.
const SUDO_WITH_ARG = new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U", "-r", "-t", "--user", "--group", "--host", "--prompt"]);
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
function remoteCommand(argv, depth = 0) {
  let i = 0;
  const skipFlags = (withArg) => {
    while (i < argv.length && (argv[i].startsWith("-") || ENV_ASSIGN.test(argv[i]))) {
      if (withArg.has(argv[i])) i++;
      i++;
    }
  };
  while (i < argv.length) {
    const cmd = String(argv[i]).split("/").pop();
    if (cmd === "timeout") {
      i++;
      skipFlags(new Set(["-s", "-k", "--signal", "--kill-after"]));
      i++; // a duração
    } else if (cmd === "sudo") {
      i++;
      skipFlags(SUDO_WITH_ARG);
    } else if (cmd === "env") {
      i++;
      skipFlags(new Set(["-u", "-C", "--unset", "--chdir"]));
    } else if (cmd === "nice") {
      i++;
      skipFlags(new Set(["-n", "--adjustment"]));
    } else if (cmd === "nohup" || cmd === "command") {
      i++;
    } else if (["bash", "sh", "dash", "zsh"].includes(cmd)) {
      const c = argv.findIndex((a, k) => k > i && /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
      if (c === -1 || argv[c + 1] === undefined || depth >= 3) return false;
      return shellSegments(argv[c + 1], "").some((g) => remoteCommand(g.argv, depth + 1));
    } else {
      return REMOTE_COMMANDS.has(cmd);
    }
  }
  return false;
}

// Comando que não faz deploy: a ref nele não chega a lugar nenhum.
const INERT = new Set(["echo", "printf", "[", "[[", "test", ":", "true", "false", "exit", "sleep"]);

// O texto sem comentário de shell — a linha inteira e o fim de linha depois de
// ` #`. Para procurar git pull e github.sha, que um comentário cita à toa.
const codeOnly = (text) =>
  String(text ?? "")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/(^|\s)#.*$/, ""))
    .join("\n");

// Linha que é só comentário sai: o comentário que explica "nunca git pull"
// não é o passo fazendo git pull. Em script JS/TS, `//` também é comentário.
function stripComments(text, file = "") {
  const slashes = /\.(?:m?js|cjs|ts)$/.test(file);
  return String(text ?? "")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l) && !(slashes && /^\s*\/\//.test(l)))
    .join("\n");
}

function envOf(env) {
  const out = {};
  if (!isObject(env)) return out;
  for (const [name, value] of Object.entries(env)) if (isScalar(value)) out[name] = String(value);
  return out;
}

const withValues = (step) => (isObject(step.with) ? Object.values(step.with).filter(isScalar).map(String) : []);

// Diretório relativo à raiz do repo, ou null quando não dá para resolver.
function relPath(base, p) {
  const raw = String(p ?? "").replace(/\\/g, "/");
  if (raw.includes("$") || /^(?:\/|[A-Za-z]:|~)/.test(raw)) return null;
  const parts = base ? base.split("/") : [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null;
    parts.push(seg);
  }
  return parts.join("/");
}

function workingDirectory(...candidates) {
  const wd = candidates.find((c) => typeof c === "string");
  return wd === undefined ? "" : relPath("", wd);
}

const defaultsDir = (defaults) =>
  isObject(defaults) && isObject(defaults.run) ? defaults.run["working-directory"] : undefined;
const defaultsShell = (defaults) =>
  isObject(defaults) && isObject(defaults.run) && typeof defaults.run.shell === "string" ? defaults.run.shell : undefined;

// O permissions que vale para um job: o dele, senão o do workflow. Sem nenhum
// dos dois, o GITHUB_TOKEN fica com o default do repo — `declared: false`.
function jobPermissions(file, doc, jobId, job) {
  const where = `${file} › ${jobId}`;
  if (Object.hasOwn(job, "permissions")) return { declared: true, value: job.permissions, where };
  if (Object.hasOwn(doc, "permissions")) return { declared: true, value: doc.permissions, where: file };
  return { declared: false, where };
}

// Os jobs irmãos de que um job depende via needs:, em cadeia.
function neededJobs(jobs, jobId, seen = new Set()) {
  const job = jobs[jobId];
  const raw = isObject(job) ? job.needs : undefined;
  const direct = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw.filter((n) => typeof n === "string") : [];
  for (const n of direct) {
    if (seen.has(n) || !Object.hasOwn(jobs, n)) continue;
    seen.add(n);
    neededJobs(jobs, n, seen);
  }
  return seen;
}

const isCheckout = (step) => typeof step.uses === "string" && /^actions\/checkout@/.test(step.uses.trim());

// Um if: com always(), failure() ou cancelled() roda depois de um passo ou job
// vermelho — inclusive !cancelled() e success() || failure().
const RUNS_AFTER_FAILURE = /\b(?:always|failure|cancelled)\s*\(\s*\)/;
const riskyIf = (value, where) =>
  value !== undefined && value !== null && RUNS_AFTER_FAILURE.test(String(value)) ? `if: ${String(value)} (${where})` : null;

// Os ids dos passos cujo output é o SHA da ref: um `git rev-parse` depois do
// checkout dela, no mesmo job. É o que o template faz no passo "Resolve".
function shaStepIds(steps, refRe) {
  const ids = [];
  let checkedOut = false;
  for (const st of steps) {
    if (!isObject(st)) continue;
    if (isCheckout(st)) checkedOut = isObject(st.with) && isScalar(st.with.ref) && refRe.test(String(st.with.ref));
    else if (checkedOut && typeof st.id === "string" && typeof st.run === "string" && /\bgit\s+rev-parse\b/.test(codeOnly(st.run))) {
      ids.push(st.id);
    }
  }
  return ids;
}

// O contexto de cada nível de chamada: `perms` é a cadeia de permissions do
// chamador para dentro (um reutilizável só rebaixa o token de quem o chama);
// `preds` são os jobs que terminam antes deste começar, como prefixo (um job
// que chama um reutilizável cobre os jobs de dentro dele); `refInner` é como a
// ref aparece neste workflow.
function collectSteps(file, doc, byFile, ctx, out) {
  const { via, stack, perms, preds, refInner } = ctx;
  const refRe = exprWith(refInner);
  const wfEnv = envOf(doc.env);
  const jobs = isObject(doc.jobs) ? doc.jobs : {};
  const jobKey = (id) => [...via, `${file} › ${id}`].join(" → ");
  const gates = new Map();
  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isObject(job)) continue;
    const jobPerms = [...perms, jobPermissions(file, doc, jobId, job)];
    const jobPreds = [...preds, ...[...neededJobs(jobs, jobId)].map(jobKey)];
    // O destino do job, com a cadeia de needs (jobGate, da #31), e o do
    // chamador quando este é um workflow reutilizável.
    const jobNever = ctx.never ?? jobGate(jobs, jobId, gates).never;
    const jobCoe = continuesOnError(job["continue-on-error"]) ? `continue-on-error: ${String(job["continue-on-error"])} no job ${jobId}` : (ctx.coe ?? null);
    const jobRisky = riskyIf(job.if, `job ${jobId}`) ?? ctx.risky ?? null;
    if (typeof job.uses === "string") {
      const withBlock = isObject(job.with) ? job.with : {};
      const carried = Object.entries(withBlock)
        .filter(([, v]) => isScalar(v) && refRe.test(String(v)))
        .map(([k]) => k);
      const local = LOCAL_WORKFLOW.exec(job.uses.trim());
      const called = local ? local[1] : null;
      const calledDoc = called ? byFile.get(called) : undefined;
      const followed = isObject(calledDoc) && !stack.includes(called) && stack.length <= MAX_CALL_DEPTH;
      out.calls.push({ where: jobKey(jobId), carriesRef: carried.length > 0, followed });
      if (followed) {
        collectSteps(
          called,
          calledDoc,
          byFile,
          {
            via: [...via, `${file} › ${jobId}`],
            stack: [...stack, called],
            perms: jobPerms,
            preds: jobPreds,
            refInner: calleeRef(carried),
            never: jobNever,
            coe: jobCoe,
            risky: jobRisky,
          },
          out,
        );
      }
      continue;
    }
    const jobEnv = { ...wfEnv, ...envOf(job.env) };
    const steps = Array.isArray(job.steps) ? job.steps : [];
    const ids = shaStepIds(steps, refRe);
    const carrierRe = exprWith(
      ids.length > 0 ? `${refInner}|\\bsteps\\.(?:${ids.map(escapeRe).join("|")})\\.outputs\\.[\\w-]+` : refInner,
    );
    steps.forEach((step, index) => {
      if (!isObject(step)) return;
      const label = typeof step.name === "string" ? step.name : typeof step.uses === "string" ? step.uses : `passo ${index + 1}`;
      const run = typeof step.run === "string" ? stripComments(step.run) : null;
      out.steps.push({
        where: [...via, `${file} › ${jobId} › ${label}`].join(" → "),
        step,
        run,
        stepEnv: envOf(step.env),
        env: { ...jobEnv, ...envOf(step.env) },
        dir: workingDirectory(step["working-directory"], defaultsDir(job.defaults), defaultsDir(doc.defaults)),
        shell: typeof step.shell === "string" ? step.shell : (defaultsShell(job.defaults) ?? defaultsShell(doc.defaults)),
        perms: jobPerms,
        job: jobKey(jobId),
        index,
        preds: jobPreds,
        // Por que o passo nunca roda, ou deixa o job seguir depois de falhar, ou
        // roda mesmo com um passo anterior vermelho — null quando não é o caso.
        never: jobNever ?? (classifyIf(step.if)?.never ? `o passo "${label}" tem if: false` : null),
        coe: continuesOnError(step["continue-on-error"]) ? `continue-on-error: ${String(step["continue-on-error"])} no passo "${label}"` : jobCoe,
        risky: riskyIf(step.if, `passo "${label}"`) ?? jobRisky,
        // A condição do próprio passo: num run em que ela é falsa, ele é pulado
        // e o job segue. A do job inteiro pula o deploy junto, e não entra aqui.
        cond: classifyIf(step.if)?.cond ?? null,
        refRe,
        carrierRe,
        checkoutRef: isCheckout(step) && isObject(step.with) && isScalar(step.with.ref) && refRe.test(String(step.with.ref)),
        remote:
          run !== null
            ? shellSegments(codeOnly(run), "").some((g) => remoteCommand(g.argv)) || REMOTE_WORD.test(codeOnly(run))
            : typeof step.uses === "string" && REMOTE_ACTION.test(step.uses),
        // Os scripts do repo que o passo chama e que falam com o host; o
        // evaluateDeployContract os preenche, porque ler arquivo é dele.
        remoteScripts: [],
      });
    });
  }
}

// ── As três peças do rollback-by-rerun ──────────────────────────────────────

function dispatchHasRef(on) {
  if (!isObject(on)) return false;
  const dispatch = on.workflow_dispatch;
  return isObject(dispatch) && isObject(dispatch.inputs) && Object.hasOwn(dispatch.inputs, "ref");
}

// As variáveis que carregam a ref num passo: as do env: (passo, job,
// workflow) cujo valor a contém, e as de shell que o run: monta com elas — o
// REMOTE_CMD="… DEPLOY_REF=$DEPLOY_REF …" do omni-chat.
function carrierVars(s) {
  const vars = new Set(Object.entries(s.env).filter(([, v]) => s.carrierRe.test(v)).map(([k]) => k));
  if (s.run === null) return vars;
  const assigns = [...codeOnly(s.run).matchAll(/(?:^|[\s;&|(])(?:export\s+|local\s+|readonly\s+)?([A-Za-z_]\w*)=("[^"\n]*"|'[^'\n]*'|[^\s;&|]*)/gm)];
  let grew = true;
  while (grew) {
    grew = false;
    for (const [, name, value] of assigns) {
      if (vars.has(name)) continue;
      if (s.carrierRe.test(value) || [...vars].some((v) => refersVar(value, v))) {
        vars.add(name);
        grew = true;
      }
    }
  }
  return vars;
}

// Onde a ref chega a um passo de deploy — um que fala com o host, que não é o
// da tag —, num comando que não é echo nem teste: no with: ou no env: de uma
// action de ssh, ou num comando do run: (direto ou por variável).
function refReach(s) {
  if (s.run === null) {
    if (withValues(s.step).some((v) => s.carrierRe.test(v))) return `${s.where} (with:)`;
    const name = Object.keys(s.env).find((k) => s.carrierRe.test(s.env[k]));
    return name ? `${s.where} (env ${name})` : null;
  }
  const vars = carrierVars(s);
  for (const g of shellSegments(codeOnly(s.run), "")) {
    if (INERT.has(g.argv[0])) continue;
    if (g.argv.some((w) => s.carrierRe.test(w))) return `${s.where} (run:)`;
    const v = [...vars].find((name) => g.argv.some((w) => refersVar(w, name)));
    if (v) return `${s.where} (env ${v})`;
  }
  // O script que fala com o host herda o env: do passo: a ref chega se ele a
  // lê, num comando que não é echo.
  for (const sc of s.remoteScripts) {
    for (const g of shellSegments(codeOnly(sc.text), "")) {
      if (INERT.has(g.argv[0])) continue;
      const v = [...vars].find((name) => g.argv.some((w) => refersVar(w, name)));
      if (v) return `${[s.where, ...sc.chain].join(" → ")} (env ${v})`;
    }
  }
  return null;
}

// Caminho de script do repo citado num texto de shell — inclusive dentro do
// comando que o ssh manda para o host, que roda no checkout do repo.
const SCRIPT_REF = /(?:^|[\s'"=;&|(`])((?:\.\/)?[A-Za-z0-9_][\w.-]*(?:\/[\w.-]+)*\.(?:sh|bash|mjs|cjs|js|ts|py))(?=$|[\s'"`;&|)])/gm;

function readSafely(readFile, rel) {
  try {
    const text = readFile(rel);
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
}

// Os scripts do repo que um texto de shell chama, seguindo os que eles chamam:
// [{ chain: ["scripts/a.sh", "scripts/b.sh"], text }], sem comentário.
function followScripts(text, dir, readFile, depth = 0, seen = new Set(), chain = []) {
  const out = [];
  if (depth >= MAX_SCRIPT_DEPTH) return out;
  for (const m of String(text).matchAll(SCRIPT_REF)) {
    const candidates = [...new Set([relPath(dir, m[1]), relPath("", m[1])])].filter((p) => p);
    for (const rel of candidates) {
      if (seen.has(rel)) continue;
      seen.add(rel);
      const body = readSafely(readFile, rel);
      if (body === null) continue;
      const clean = stripComments(body, rel);
      out.push({ chain: [...chain, rel], text: clean });
      out.push(...followScripts(clean, dir, readFile, depth + 1, seen, [...chain, rel]));
    }
  }
  return out;
}

// Os textos que um passo executa ou entrega: o run:, os with:, e os scripts do
// repo que eles chamam — cada um com o rótulo de onde está.
function executedTexts(s, readFile) {
  const own = [...(s.run !== null ? [s.run] : []), ...withValues(s.step)];
  const out = own.map((text) => ({ where: s.where, text }));
  for (const text of own) {
    for (const sc of followScripts(text, s.dir, readFile)) out.push({ where: [s.where, ...sc.chain].join(" → "), text: sc.text });
  }
  return out;
}


// O que conta como o SHA implantado: o output de um passo ou job (o Resolve do
// template), o APP_VERSION que o build recebe, ou um git rev-parse. github.sha
// não conta: num workflow_dispatch ele é o HEAD do branch do dispatch.
const SHA_SOURCE = /\$\{\{[^}]*\b(?:steps|needs)\.[\w-]+\.outputs\.[\w-]+[^}]*\}\}|\bAPP_VERSION\b|\bgit\s+rev-parse\b/;

// A URL termina onde termina: depois dela vem fim, aspas, espaço, query,
// fragmento ou um separador de shell — ou uma / e então um desses. Assim
// .../api/version-old e .../api/healthz não casam com .../api/version e .../api.
const URL_END = /["'\s?#)`;&|<>,\]}]/;
function hasUrl(text, url) {
  const t = String(text);
  for (let i = t.indexOf(url); i !== -1; i = t.indexOf(url, i + 1)) {
    const a = t[i + url.length];
    const b = t[i + url.length + 1];
    if (a === undefined || URL_END.test(a) || (a === "/" && (b === undefined || URL_END.test(b)))) return true;
  }
  return false;
}

// Comando que só escreve: o SHA ou a URL nele não é comparação nem consulta.
const NOT_COMPARING = new Set(["echo", "printf", ":"]);

// As funções definidas no próprio script cujo último comando é um exit N≠0 —
// o helper `fail() { echo "::error::$1"; exit 1; }`. Chamar uma delas é
// propagar a falha, como um exit.
function failingFunctions(code) {
  const out = new Set();
  const def = /(?:^|[\n;&|])\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\s*\)\s*\{/g;
  for (const m of code.matchAll(def)) {
    let depth = 1;
    let j = m.index + m[0].length;
    for (; j < code.length && depth > 0; j++) {
      if (code[j] === "{") depth++;
      else if (code[j] === "}") depth--;
    }
    const body = analyzeScript(code.slice(m.index + m[0].length, j - 1), "");
    if (body.length > 0 && propagates(body[body.length - 1].argv)) out.add(m[1]);
  }
  return out;
}

// O passo consulta a version_url? Se consulta: compara com uma fonte do SHA
// implantado, e a falha dessa comparação chega ao status do passo?
//
// Só conta o que vem a partir da primeira consulta, na ordem do script: a
// guarda `[[ "$SHA" =~ … ]] || exit 1` antes dela não é comparação, e o laço do
// template, que compara num if e termina em exit 1, é. A análise de falha
// engolida é a do contrato de CI (analyzeScript): || true, pipe sem pipefail,
// && com comando depois, set +e, condição de if/while/until. echo, printf e :
// não contam, e um script chamado só conta se estiver na cadeia que contém a
// URL ou o SHA.
function versionCheck(s, url, readFile) {
  const urlVars = Object.keys(s.env).filter((k) => hasUrl(s.env[k], url));
  const shaVars = Object.keys(s.env).filter((k) => SHA_SOURCE.test(s.env[k]));
  if (s.run === null) {
    // Uma action recebe o env: do passo, do job e do workflow.
    if (typeof s.step.uses !== "string") return null;
    const withHit = withValues(s.step).some((v) => hasUrl(v, url));
    if (!withHit && urlVars.length === 0) return null;
    const compares = withValues(s.step).some((v) => SHA_SOURCE.test(v)) || shaVars.length > 0;
    return { s, where: withHit ? `${s.where} (with:)` : `${s.where} (env ${urlVars[0]})`, compares, swallowed: null };
  }
  const code = codeOnly(s.run);
  const scripts = followScripts(code, s.dir, readFile);
  const viaVar = urlVars.find((n) => refersVar(code, n));
  // O script herda o env: do passo: lendo $VERSION_URL, ele consulta a URL.
  const inScript = scripts.find((sc) => hasUrl(sc.text, url) || urlVars.some((n) => refersVar(sc.text, n)));
  let where = null;
  if (hasUrl(code, url)) where = s.where;
  else if (viaVar) where = `${s.where} (env ${viaVar})`;
  else if (inScript) where = [s.where, ...inScript.chain].join(" → ");
  if (where === null) return null;

  const urlRef = (t) => hasUrl(t, url) || urlVars.some((n) => refersVar(t, n));
  const shaRef = (t) => SHA_SOURCE.test(t) || shaVars.some((n) => refersVar(t, n));
  // Os scripts chamados pelo passo cuja cadeia contém a URL, ou o SHA.
  const chainWith = (pred) => new Set(scripts.filter((sc) => pred(sc.text)).map((sc) => sc.chain[0]));
  const urlScripts = chainWith(urlRef);
  const shaScripts = chainWith(shaRef);
  const calls = (words, set) =>
    words.some((w) =>
      [...String(w).matchAll(SCRIPT_REF)].some((m) => [relPath(s.dir, m[1]), relPath("", m[1])].some((p) => p && set.has(p))),
    );
  const writesOnly = (g) => NOT_COMPARING.has(g.argv[0]);

  // O script inteiro é analisado, para o estado do shell de antes da consulta
  // (set +e, set -o pipefail) valer. A primeira consulta é achada por comando
  // nessa análise — um que não só escreve, com a URL ou um script da cadeia
  // dela —, porque um comando pode atravessar linhas (o ssh de várias linhas
  // do mesa-crm). A consulta numa substituição `x=$(curl … $U)` não vira
  // comando na análise: para ela vale a linha, convertida em índice pelos
  // comandos que as linhas anteriores produzem.
  const all = analyzeScript(code, s.dir, { pipefail: hasPipefail(s.shell) });
  const lines = code.split("\n");
  let first = all.findIndex((g) => !writesOnly(g) && (g.argv.some(urlRef) || calls(g.argv, urlScripts)));
  const substLine = lines.findIndex((line) => urlRef(line) && /\$\(/.test(line));
  if (substLine !== -1) {
    const k = analyzeScript(lines.slice(0, substLine).join("\n"), s.dir).length;
    if (first === -1 || k < first) first = k;
  }
  if (first === -1) return { s, where, compares: false, swallowed: "a URL só aparece num echo" };
  const segments = all.slice(first);
  const relevant = (g) => !writesOnly(g) && (g.argv.some(urlRef) || g.argv.some(shaRef) || calls(g.argv, new Set([...urlScripts, ...shaScripts])));
  const compares =
    segments.some((g) => !writesOnly(g) && (g.argv.some(shaRef) || calls(g.argv, shaScripts))) ||
    lines.slice(Math.max(substLine, 0)).some((line) => /^\s*[A-Za-z_]\w*=.*\$\(/.test(line) && shaRef(line));
  // A falha do passo amarrada à comparação: um comando com o SHA que não só
  // escreve e não foi engolido; ou um exit N≠0 no nível de topo (o exit 1 do
  // fim do laço do template), ou cuja condição — o lado esquerdo do ||, a
  // condição do if/while — referencia o SHA. Um exit atrás de
  // `[ -n "$corpo" ] ||` ou de `if [ -z "$corpo" ]` não diz nada da versão.
  const refsSha = (argvs) => argvs.some((argv) => argv.some(shaRef) || calls(argv, shaScripts));
  const comparesHere = (g) => !writesOnly(g) && (g.argv.some(shaRef) || calls(g.argv, shaScripts));
  const failFns = failingFunctions(code);
  const exitOnMismatch = (g) =>
    (propagates(g.argv) || failFns.has(g.argv[0])) &&
    ((g.nest === 0 && g.left.length === 0) || refsSha(g.left) || refsSha(g.control));
  const canFail = segments.some((g) => !g.swallow && (comparesHere(g) || exitOnMismatch(g)));
  // O último comando engolido da comparação é o que decidiria o status.
  const swallowedSeg = canFail ? null : segments.findLast((g) => g.swallow && relevant(g));
  return {
    s,
    where,
    compares,
    swallowed: canFail ? null : swallowedSeg ? `${swallowedSeg.argv.join(" ")} ${swallowedSeg.swallow}` : "nenhum comando depois da consulta faz o passo falhar",
  };
}

// git [-c k=v | -C dir | --opção]… <subcomando>
function gitSubcommand(argv) {
  if (argv[0] !== "git") return null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (["-c", "-C", "--git-dir", "--work-tree", "--namespace"].includes(a)) i++;
    else if (!a.startsWith("-")) return { name: a, args: argv.slice(i + 1) };
  }
  return null;
}

const NOT_CREATING = new Set(["-l", "--list", "-d", "--delete", "-v", "--verify"]);
const DEPLOY_TAG = /(?:^|refs\/tags\/)deploy\//;

// O passo cria uma tag deploy/ e a envia: `git tag` com um nome deploy/… (ou
// uma variável atribuída a deploy/…) mais `git push` no mesmo passo, ou a ref
// criada direto pela API.
function tagReach(s) {
  if (s.run === null) {
    if (typeof s.step.uses !== "string") return null;
    const vals = withValues(s.step);
    const ok = vals.some((v) => /refs\/tags\/deploy\//.test(v)) || (/tag/i.test(s.step.uses) && vals.some((v) => /(?:^|\/)deploy\//.test(v)));
    return ok ? s.where : null;
  }
  if (!/deploy\//.test(s.run)) return null;
  const vars = new Set([...s.run.matchAll(/\b([A-Za-z_]\w*)=["']?(?:refs\/tags\/)?deploy\//g)].map((m) => m[1]));
  for (const [name, value] of Object.entries(s.env)) if (DEPLOY_TAG.test(value)) vars.add(name);
  const namesDeployTag = (args) => args.some((a) => DEPLOY_TAG.test(a) || [...vars].some((v) => refersVar(a, v)));
  const segments = shellSegments(s.run, "");
  const tagged = segments.some((g) => {
    const sub = gitSubcommand(g.argv);
    return sub?.name === "tag" && !sub.args.some((a) => NOT_CREATING.has(a)) && namesDeployTag(sub.args);
  });
  // O push tem de enviar a tag — pelo nome, por --tags ou --follow-tags — e de
  // verdade: push da main ou --dry-run deixam a tag só no runner.
  const pushed = segments.some((g) => {
    const sub = gitSubcommand(g.argv);
    if (sub?.name !== "push" || sub.args.some((a) => a === "--dry-run" || a === "-n")) return false;
    return sub.args.some((a) => a === "--tags" || a === "--follow-tags") || namesDeployTag(sub.args);
  });
  const viaApi = segments.some(
    (g) => g.argv[0] === "gh" && g.argv[1] === "api" && g.argv.some((a) => /\/git\/refs\b/.test(a)) && namesDeployTag(g.argv),
  );
  return (tagged && pushed) || viaApi ? s.where : null;
}

// A tag deploy/ é obrigatória, então a permissão de enviá-la também: sem
// contents: write, o git push da tag falha com o GITHUB_TOKEN DEPOIS de um
// deploy verde — o run fica vermelho com produção certa e sem tag de rollback.
const writesContents = (value) => value === "write-all" || (isObject(value) && value.contents === "write");

function describePermissions(value) {
  if (typeof value === "string") return `permissions: ${value}`;
  if (!isObject(value)) return "permissions vazio";
  if (Object.keys(value).length === 0) return "permissions: {}";
  return isScalar(value.contents) ? `contents: ${value.contents}` : "permissions sem contents";
}

function checkTagPermissions(tagStep, fail, warn) {
  const lacking = tagStep.perms.find((p) => p.declared && !writesContents(p.value));
  if (lacking) {
    fail(
      "permissions",
      `o passo da tag deploy/ (${tagStep.where}) roda com ${describePermissions(lacking.value)}, declarado em ${lacking.where} — ` +
        "o git push da tag falha com o GITHUB_TOKEN depois de um deploy verde, e não sobra tag de rollback. " +
        `Declare permissions: contents: write no job da tag ou no workflow — modelo: ${TEMPLATE}`,
    );
    return;
  }
  // Num reutilizável, o chamado sem permissions herda o token do chamador; só
  // o nível de fora, sem declaração, cai no default do repo.
  const undeclared = tagStep.perms[0]?.declared === false ? tagStep.perms[0] : null;
  if (undeclared) {
    warn(
      "permissions",
      `${undeclared.where} não declara permissions, nem no job nem no workflow, e o passo da tag deploy/ (${tagStep.where}) ` +
        "depende do default do GITHUB_TOKEN, que é configuração do repo: se for só-leitura, o git push da tag falha depois " +
        `de um deploy verde. Declare permissions: contents: write — modelo: ${TEMPLATE}`,
    );
  }
}

// A tag marca só deploy verificado: o passo dela vem depois de um passo que
// consulta a version_url, no mesmo job ou num job que dependa dele via needs:.
// Dentro de um mesmo run: o núcleo não sabe a ordem — pede dois passos.
const runsBefore = (v, t) =>
  v.job === t.job ? v.index < t.index : t.preds.some((p) => v.job === p || v.job.startsWith(`${p} → `));

function checkTagOrder(tagStep, versionHits, fail, warn) {
  if (versionHits.some((h) => runsBefore(h.s, tagStep))) return;
  if (versionHits.some((h) => h.s === tagStep)) {
    warn(
      "order",
      `o mesmo passo (${tagStep.where}) consulta a version_url e cria a tag deploy/, e o núcleo não confere a ordem dentro de um run: — ` +
        `separe a tag num passo depois do health check. Modelo: ${TEMPLATE} (job tag, com needs: deploy)`,
    );
    return;
  }
  fail(
    "order",
    `a tag deploy/ (${tagStep.where}) não vem depois da comparação com a version_url (${versionHits[0].where}) — a tag marca só ` +
      "deploy verificado, então o passo dela fica depois do health check: no mesmo job, mais abaixo, ou num job que dependa dele via " +
      `needs:. Sem isso ela marca também o deploy que reprovou. Modelo: ${TEMPLATE} (job tag, com needs: deploy)`,
  );
}

const firstOf = (items, fn) => {
  for (const it of items) {
    const hit = fn(it);
    if (hit) return hit;
  }
  return null;
};

// ── O contrato ──────────────────────────────────────────────────────────────

/**
 * O contrato do deploy (AGENTS.md §CI/CD Mandate): o SPEC.md declara no bloco
 * `deploy:` o workflow de deploy de produção e o endpoint de versão, e o
 * workflow declarado tem de ter as três peças do rollback-by-rerun —
 *   ref:     um workflow_dispatch com o input `ref`, que chega ao checkout, a
 *            um with: de action ou a um run: (direto ou via env:);
 *   version: algum passo, ou script do repo chamado por um passo, consulta a
 *            `version_url` declarada;
 *   tag:     algum passo cria e envia a tag `deploy/`.
 * Segue os workflows reutilizáveis locais. O opt-out é `workflow: none` com
 * `reason:`, e passa com aviso.
 *
 * @param {{specText: string|null|undefined,
 *          workflows: Array<{file: string, doc?: unknown, error?: string}>|null,
 *          readFile?: (rel: string) => string|null|undefined}} input
 *   workflows: null quando não há parser YAML para lê-los (o doctor sem
 *   node_modules) — o bloco ainda é julgado.
 *   readFile(rel): o texto de um arquivo do repo (caminho relativo à raiz), ou
 *   null. Só é chamado com caminhos dentro do repo.
 */
export function evaluateDeployContract({ specText, workflows, readFile }) {
  const findings = [];
  const located = [];
  const fail = (key, message) => findings.push({ level: "fail", key, message });
  const warn = (key, message) => findings.push({ level: "warn", key, message });
  const read = typeof readFile === "function" ? readFile : () => null;

  if (specText === null || specText === undefined) {
    fail("spec", `SPEC.md não encontrado na raiz do repo — é ele que declara, no bloco deploy: do frontmatter, o workflow de deploy de produção (${MANDATE})`);
    return { block: { state: "absent" }, findings, located };
  }
  const block = readDeployBlock(specText);
  if (block.state === "absent") {
    fail(
      "deploy",
      "SPEC.md não declara o bloco deploy: no frontmatter. Declare nele o workflow de deploy de produção " +
        "(workflow: deploy.yml) e o endpoint sem cache que devolve o SHA servido (version_url: https://<domínio>/api/version) — " +
        `ou, sem deploy de produção, workflow: none com reason:. Modelo do workflow: ${TEMPLATE}; ver ${MANDATE}`,
    );
    return { block, findings, located };
  }
  if (block.state === "malformed") {
    fail("deploy", `o bloco deploy: do SPEC.md não pôde ser lido — ${block.reason}`);
    return { block, findings, located };
  }

  const { deploy } = block;
  if (deploy.workflow === null) {
    fail(
      "workflow",
      "deploy.workflow é obrigatório: o arquivo de .github/workflows/ que faz o deploy de produção (ex.: deploy.yml) — " +
        "ou workflow: none com reason:, se o projeto não tem deploy de produção",
    );
    return { block, findings, located };
  }
  if (deploy.workflow === "none") {
    if (deploy.reason === null) {
      fail("workflow", "deploy.workflow: none exige reason: — o motivo de o projeto não ter deploy de produção fica visível no SPEC.md e no doctor");
    } else {
      warn("workflow", `opt-out declarado: deploy.workflow é none — ${deploy.reason}`);
    }
    return { block, findings, located };
  }

  let url = null;
  if (deploy.version_url === null) {
    fail(
      "version_url",
      'deploy.version_url é obrigatório: o endpoint sem cache que devolve o SHA servido (ex.: https://<domínio>/api/version, JSON {"version": "<sha>"}), ' +
        `que o health check do workflow consulta até ele devolver o SHA implantado — modelo: ${TEMPLATE}`,
    );
  } else if (!/^https?:\/\/\S+$/.test(deploy.version_url)) {
    fail("version_url", `deploy.version_url tem de ser uma URL http(s)://, não "${deploy.version_url}"`);
  } else {
    url = deploy.version_url.replace(/\/+$/, "");
  }

  const wfPath = `.github/workflows/${deploy.workflow}`;
  if (workflows === null || workflows === undefined) {
    warn("workflows", `o workflow declarado (${wfPath}) não foi conferido — só o bloco deploy:`);
    return { block, findings, located };
  }
  const byFile = new Map();
  for (const w of workflows) if (isObject(w) && w.error == null) byFile.set(String(w.file ?? ""), w.doc);
  const entry = workflows.find((w) => isObject(w) && w.file === deploy.workflow);
  if (!entry) {
    fail("workflow", `${wfPath} não existe — copie ${TEMPLATE} para ele e adapte o passo Deploy to VPS, ou corrija deploy.workflow no SPEC.md`);
    return { block, findings, located };
  }
  if (entry.error != null) {
    fail("workflow", `${wfPath} não é YAML válido (${entry.error}) — o GitHub não roda um workflow inválido; compare com ${TEMPLATE}`);
    return { block, findings, located };
  }
  if (!isObject(entry.doc)) {
    fail("workflow", `${wfPath} não é um workflow (o YAML não é um mapa) — modelo: ${TEMPLATE}`);
    return { block, findings, located };
  }

  const collected = { steps: [], calls: [] };
  collectSteps(
    deploy.workflow,
    entry.doc,
    byFile,
    { via: [], stack: [deploy.workflow], perms: [], preds: [], refInner: TOP_REF },
    collected,
  );
  const { steps, calls } = collected;
  // O passo que chama um script do repo que fala com o host também é passo de
  // deploy (run: ./infra/deploy.sh com o ssh dentro).
  for (const s of steps) {
    if (s.run === null) continue;
    s.remoteScripts = followScripts(codeOnly(s.run), s.dir, read).filter((sc) =>
      shellSegments(codeOnly(sc.text), "").some((g) => remoteCommand(g.argv)),
    );
    if (s.remoteScripts.length > 0) s.remote = true;
  }
  const tagSteps = new Set(steps.filter((s) => tagReach(s) !== null));
  // urlHits: os passos que consultam a version_url; versionHits: os que
  // comparam a resposta com o SHA implantado, com a falha chegando ao passo.
  const urlHits = url === null ? [] : steps.map((s) => versionCheck(s, url, read)).filter((h) => h !== null);
  const versionHits = urlHits.filter((h) => h.compares && h.swallowed === null);

  // O host pousando num branch fixo — reset --hard origin/<branch>, checkout
  // ou switch de um nome literal — no comando remoto ou num script seguido.
  const pins = steps
    .filter((s) => s.remote && !tagSteps.has(s))
    .flatMap((s) => {
      const vars = [...carrierVars(s)];
      const carries = (args) => s.carrierRe.test(args) || vars.some((v) => refersVar(args, v));
      return executedTexts(s, read).flatMap((t) => pinnedRefs(codeOnly(t.text), carries).map((p) => `${t.where}: ${p}`));
    });
  if (pins.length > 0) {
    warn(
      "pinned",
      `${[...new Set(pins)].join(", ")} — o host pousa num branch fixo, não na ref recebida: re-rodar com a tag deploy/ anterior ` +
        `subiria a ponta do branch de novo. Faça checkout --detach do SHA recebido — modelo: ${TEMPLATE} (Deploy to VPS)`,
    );
  }

  // git pull reprova onde estiver: no run:, num with:, no comando do ssh ou
  // num script do repo que um passo chama.
  const pulls = steps.flatMap((s) => executedTexts(s, read).filter((t) => GIT_PULL.test(codeOnly(t.text))).map((t) => t.where));
  if (pulls.length > 0) {
    fail(
      "pull",
      `git pull em ${[...new Set(pulls)].join(", ")} — ele só avança o branch corrente e pousa sempre na main, então re-rodar com a tag ` +
        `deploy/ anterior sobe a main de novo, sem erro nenhum. O host faz checkout da ref recebida (do SHA dela) — modelo: ${TEMPLATE} (Deploy to VPS)`,
    );
  }

  if (!dispatchHasRef(entry.doc.on)) {
    fail(
      "ref",
      `${wfPath} não tem workflow_dispatch com o input ref. O rollback do Release Loop é re-rodar o workflow com ` +
        `-f ref=<tag deploy/ anterior>, e sem o input não há como pedir outra versão. Declare on.workflow_dispatch.inputs.ref — modelo: ${TEMPLATE}`,
    );
  } else {
    // O passo que consulta a version_url confere o deploy, não o faz: com outro
    // passo remoto no workflow, a ref tem de chegar a esse outro (a topologia
    // do mesa-crm: o deploy pousava em origin/main e só o smoke recebia o
    // SHA). Se o único passo remoto faz deploy e checagem juntos, ele conta.
    let deploySteps = steps.filter((s) => s.remote && !tagSteps.has(s));
    const consulting = new Set(urlHits.map((h) => h.s));
    if (deploySteps.some((s) => !consulting.has(s))) deploySteps = deploySteps.filter((s) => !consulting.has(s));
    const where = firstOf(deploySteps, refReach);
    const checkout = steps.find((s) => s.checkoutRef);
    const unfollowed = calls.find((c) => c.carriesRef && !c.followed);
    if (where) {
      located.push({ key: "ref", where });
    } else if (deploySteps.length === 0 && (checkout || unfollowed)) {
      const seen = checkout ? checkout.where : `${unfollowed.where} (workflow chamado que o núcleo não segue)`;
      located.push({ key: "ref", where: seen });
      warn(
        "ref",
        `a ref chega a ${seen}, mas ${wfPath} não tem passo que fale com o host (ssh, scp, rsync): o deploy roda no runner, ` +
          "onde o núcleo não o vê. Confira que ele implanta o que esse checkout trouxe, e não outra coisa. " +
          `Modelo: ${TEMPLATE} (Deploy to VPS)`,
      );
    } else {
      fail(
        "ref",
        `o input ref de ${wfPath} não chega ao deploy: nenhum passo que fala com o host (ssh, scp, rsync) recebe a ref, ou o SHA que ` +
          "um git rev-parse tirou do checkout dela, num comando — o passo da tag e um echo não contam. Re-rodar com uma tag " +
          `anterior subiria de novo a mesma versão. O passo remoto faz checkout da ref recebida — modelo: ${TEMPLATE} (Resolve e Deploy to VPS)`,
      );
    }

    // github.sha no deploy, no health check ou na tag é o HEAD do branch do
    // dispatch, não a ref pedida.
    const relevant = steps.filter((s) => (s.remote && !tagSteps.has(s)) || tagSteps.has(s) || urlHits.some((h) => h.s === s));
    const shaWheres = relevant.flatMap((s) => {
      const texts = executedTexts(s, read);
      const envHits = Object.entries(s.env).filter(
        ([name, value]) => GITHUB_SHA.test(value) && (Object.hasOwn(s.stepEnv, name) || texts.some((t) => refersVar(t.text, name))),
      );
      return [
        ...texts.filter((t) => GITHUB_SHA.test(codeOnly(t.text))).map((t) => t.where),
        ...envHits.map(([name]) => `${s.where} (env ${name})`),
      ];
    });
    if (shaWheres.length > 0) {
      fail(
        "sha",
        `github.sha em ${[...new Set(shaWheres)].join(", ")} — num workflow_dispatch ele é o HEAD do branch do dispatch (a main), ` +
          "não o SHA da ref pedida: o rollback subiria a main e marcaria uma tag deploy/ nova nela. Use o SHA que um git rev-parse " +
          `tira do checkout da ref (steps.version.outputs.sha) — modelo: ${TEMPLATE} (Resolve a versão)`,
      );
    }
  }

  // A comparação que barra a tag: roda (sem if: false, nem job pulado na
  // cadeia de needs) e a falha dela para o job (sem continue-on-error).
  const gating = versionHits.filter((h) => !h.s.never && !h.s.coe);
  if (url !== null) {
    const comparing = urlHits.filter((h) => h.compares);
    if (gating.length > 0) {
      located.push({ key: "version", where: gating[0].where });
      // Comparação com if: próprio: num run em que a condição é falsa, ela é
      // pulada, o job segue verde e a tag sai.
      if (gating.every((h) => h.s.cond !== null)) {
        warn(
          "condition",
          `${gating.map((h) => `${h.where} só roda quando if: ${h.s.cond}`).join(", ")} — num run em que a condição é falsa, o ` +
            "passo é pulado, o deploy segue verde sem a comparação e ganha tag. Tire o if: do passo que compara — " +
            `modelo: ${TEMPLATE} (Health check)`,
        );
      }
    } else if (versionHits.length > 0) {
      const h = versionHits[0];
      fail(
        "version",
        `${versionHits.map((v) => v.where).join(", ")} compara a versão servida com o SHA, mas não barra nada: ` +
          `${h.s.never ?? h.s.coe} — o deploy com a versão antiga no ar seguiria, e ganharia tag. ` +
          `A comparação roda sempre e a falha dela para o job — modelo: ${TEMPLATE} (Health check)`,
      );
    } else if (comparing.length > 0) {
      fail(
        "version",
        `${comparing.map((h) => h.where).join(", ")} compara a versão servida com o SHA, mas a falha não chega ao status do passo ` +
          `(${comparing[0].swallowed}) — o deploy com a versão antiga no ar passaria verde, e ganharia tag. ` +
          `Deixe a comparação reprovar o passo — modelo: ${TEMPLATE} (Health check, que termina em exit 1)`,
      );
    } else if (urlHits.length > 0) {
      fail(
        "version",
        `${urlHits.map((h) => h.where).join(", ")} cita deploy.version_url mas não a compara com o SHA implantado: nem o passo nem o ` +
          "script que ele chama referencia uma fonte do SHA (steps.<id>.outputs.*, needs.<job>.outputs.*, APP_VERSION, git rev-parse, " +
          "ou uma env ligada a eles; github.sha não serve). Um curl que só olha o 200 não distingue a versão nova da antiga que " +
          `nunca caiu. Modelo: ${TEMPLATE} (Health check, com SHA e VERSION_URL)`,
      );
    } else {
      fail(
        "version",
        `nenhum passo de ${wfPath}, nem script do repo chamado por um passo, consulta deploy.version_url (${deploy.version_url}). ` +
          "O health check tem de consultar esse endpoint sem cache até ele devolver o SHA implantado — status 200 não distingue " +
          `a versão nova da antiga que nunca caiu. Modelo: ${TEMPLATE} (passo Health check, com VERSION_URL)`,
      );
    }
  }

  const tagStep = steps.find((s) => tagSteps.has(s));
  if (tagStep) {
    located.push({ key: "tag", where: tagStep.where });
    checkTagPermissions(tagStep, fail, warn);
    if (tagStep.risky) {
      fail(
        "order",
        `o passo da tag deploy/ (${tagStep.where}) roda com ${tagStep.risky}, e portanto também depois de um health check vermelho: ` +
          `marcaria como ponto de rollback o deploy que acabou de reprovar. Tire a condição — modelo: ${TEMPLATE} (job tag, com needs: deploy)`,
      );
    }
    if (gating.length > 0) checkTagOrder(tagStep, gating, fail, warn);
  } else {
    fail(
      "tag",
      `${wfPath} não cria a tag deploy/ depois do health check: nenhum passo faz git tag deploy/… e git push (ou gh api …/git/refs). ` +
        `Sem ela não há tag de rollback para re-rodar. Modelo: ${TEMPLATE} (passo Tag deploy/, com permissions: contents: write)`,
    );
  }

  return { block, findings, located };
}

// Os avisos que o contract test também barra: deixam o rollback quebrado sem
// que o run do deploy perceba — permissions não declarado (o push da tag
// depende do default do repo), a tag no mesmo passo da consulta (a ordem que
// o núcleo não confere), a comparação com if: próprio (pode ser pulada) e o
// host pousando num branch fixo. O opt-out e o deploy no runner seguem só
// avisos.
const BLOCKING_WARNS = new Set(["permissions", "order", "condition", "pinned"]);

/**
 * As mensagens que o deploy-contract.test.ts reprova: toda falha e os avisos
 * de permissions, de ordem e de condição. O doctor segue mostrando esses
 * avisos como WARN.
 * @param {{findings: Array<{level: string, key: string, message: string}>}} evaluation
 */
export function contractBlockers(evaluation) {
  return evaluation.findings.filter((f) => f.level === "fail" || BLOCKING_WARNS.has(f.key)).map((f) => f.message);
}
