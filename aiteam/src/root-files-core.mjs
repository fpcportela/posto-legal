// Os arquivos de RAIZ que o framework distribui (rb-ai-team#39) e o que o doctor
// diz deles. O ADR 0002 mantém esses arquivos fora do aiteam/ (o harness só os
// lê da raiz, e o consumidor os customiza), então o sync escopado
// (`git checkout upstream/main -- aiteam/`) não os alcança — e antes desta peça
// nada mecânico notava um deles ficar para trás: o .beads/SCHEMA.md do mesa-crm
// parou quase três meses atrás sem ninguém ver.
//
// Aqui só o julgamento, puro. A leitura de git e de arquivos vive em
// root-files-io.mjs (testada num repo temporário com um remote `upstream`
// local), no mesmo corte do doctor-core.mjs / doctor-io.mjs.
//
// Todo achado é WARN e nunca FAIL: a customização do arquivo de raiz é legítima,
// e o doctor só sabe dizer "o upstream tem isto e o seu não".

/** O remote que o guia de consumo manda criar (aiteam/docs/consuming-as-upstream.md, "Setup"). */
export const UPSTREAM_REMOTE = "upstream";

/**
 * O URL de um remote aponta para o repo rb-ai-team? O nome do repo é o último componente (ssh, https, com ou sem .git,
 * caminho local do Windows ou do Unix). `my-rb-ai-team` e `rb-ai-team-fork` não são ele. Serve para o doctor dizer qual
 * remote, com outro nome, parece ser o do framework (o vigacapital chama o seu de `rb-ai-team`; QA da #39, A11).
 * @param {string} url
 */
export function pointsAtFramework(url) {
  return /(?:^|[\/:\\])rb-ai-team(?:\.git)?[\/\\]?$/i.test(String(url ?? "").trim());
}

/** Quando o remote não tem `HEAD` simbólico, o doctor tenta estes, nesta ordem. */
export const UPSTREAM_BRANCHES = Object.freeze(["main", "master"]);

/** Onde o sync (ou o upstream-marker.mjs) registra de que commit do upstream veio o aiteam/. */
export const MARKER_PATH = "aiteam/UPSTREAM";

/**
 * Idade da ponta do upstream a partir da qual a comparação merece um `git fetch`. É a
 * idade do COMMIT, não a do último fetch (um fetch sem novidade não a move), então o
 * aviso diz "confirme", não "conserte" — o mesmo raciocínio do KB_STALE_DAYS do infra_kb.
 */
export const STALE_DAYS = 14;

/**
 * Os arquivos de raiz que o framework distribui: o caminho no consumidor e de onde
 * vem no upstream. Para o .claude/tier-rules.json, o .github/workflows/ci.yml e o
 * deploy.yml o upstream distribui um MODELO dentro do aiteam/ (a raiz do próprio
 * framework tem o seu, que não serve de cópia). `upstream` é o que o
 * `git log <último-sync>..upstream/main -- …` examina: o que mudou na fonte desde
 * o último sync é o que o consumidor precisa reconciliar.
 *
 * O doc aiteam/docs/consuming-as-upstream.md tem a tabela destes arquivos (como cada
 * um chega ao consumidor); root-files-core.test.ts confere que nenhum some dela.
 */
export const ROOT_FILES = Object.freeze([
  { path: ".beads/SCHEMA.md", upstream: Object.freeze([".beads/SCHEMA.md"]) },
  { path: "AGENTS.md", upstream: Object.freeze(["AGENTS.md"]) },
  { path: "CLAUDE.md", upstream: Object.freeze(["CLAUDE.md"]) },
  { path: "GEMINI.md", upstream: Object.freeze(["GEMINI.md"]) },
  { path: ".gitattributes", upstream: Object.freeze([".gitattributes"]) },
  { path: ".claude/tier-rules.json", upstream: Object.freeze(["aiteam/templates/tier-rules.json"]) },
  { path: ".github/workflows/ci.yml", upstream: Object.freeze(["aiteam/templates/ci.yml.example"]) },
  { path: ".github/workflows/deploy.yml", upstream: Object.freeze(["aiteam/templates/deploy.yml.example"]) },
]);

/** Os caminhos, no upstream, que o `git log` do "o que mudou na raiz" examina. */
export const ROOT_SOURCES = Object.freeze([...new Set(ROOT_FILES.flatMap((f) => f.upstream))]);

// ─── o marcador aiteam/UPSTREAM ─────────────────────────────────────────────────

const MARKER_COMMIT = /^commit:[ \t]*([0-9a-f]{7,64})[ \t]*$/m;
const MARKER_DATE = /^date:[ \t]*(\d{4}-\d{2}-\d{2})[ \t]*$/m;

/**
 * Lê o texto do marcador. `{state: "absent"}` quando não há texto, `{state: "malformed"}`
 * quando há texto sem uma linha `commit:` com um sha.
 * @param {string|null|undefined} text
 * @returns {{state: "absent"} | {state: "malformed"} | {state: "ok", commit: string, date: string|null}}
 */
export function parseUpstreamMarker(text) {
  // O BOM do UTF-8 (o Out-File do PowerShell 5 e vários editores do Windows o gravam) vem como \uFEFF na frente da
  // primeira linha e quebraria o `^commit:` dela (QA da #39, A5).
  const body = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (body.trim() === "") return { state: "absent" };
  const commit = MARKER_COMMIT.exec(body);
  if (!commit) return { state: "malformed" };
  const date = MARKER_DATE.exec(body);
  return { state: "ok", commit: commit[1], date: date ? date[1] : null };
}

/**
 * O texto do marcador. As duas linhas de dados bastam ao leitor; o cabeçalho diz a
 * quem abre o arquivo por que ele existe e quem o escreve.
 * @param {{commit: string, date?: string|null}} marker
 */
export function renderUpstreamMarker({ commit, date }) {
  const lines = [
    "# De qual commit do rb-ai-team o aiteam/ deste repo veio.",
    "# Quem grava: tools/aiteam-sync, ou à mão: node aiteam/scripts/upstream-marker.mjs write",
    "# Serve para medir o que mudou nos arquivos de raiz desde o último sync (consuming-as-upstream.md).",
    `commit: ${commit}`,
  ];
  if (date) lines.push(`date: ${date}`);
  return `${lines.join("\n")}\n`;
}

const short = (sha) => String(sha ?? "").slice(0, 7);

/**
 * O resultado de measureRootChanges (root-files-io.mjs) em markdown, para o corpo do PR do
 * sync e para a saída de `upstream-marker.mjs changes`. Sem marcador, ou com um marcador
 * que o upstream local não conhece, diz que não dá para medir e manda conferir tudo.
 *
 * @param {{status: "no-marker"|"malformed"|"unknown-commit"|"same"|"changes",
 *          previous?: {commit: string, date?: string|null}|null,
 *          current?: {commit: string, date?: string|null}|null,
 *          entries?: Array<{hash: string, date: string, subject: string, files: string[]}>}} m
 * @param {{next?: string, fetched?: boolean}} [options] `next`: a frase final de "como seguir" (muda entre o sync e a CLI);
 *   `fetched`: o fetch do upstream acabou de rodar (o sync) — um marcador desconhecido então NÃO é fetch pendente
 */
export function renderRootChanges(m, { next = "", fetched = false } = {}) {
  const tail = next ? `\n\n${next}` : "";
  const current = m.current ? `\`${short(m.current.commit)}\`${m.current.date ? ` (${m.current.date})` : ""}` : "o upstream atual";
  const previous = m.previous ? `\`${short(m.previous.commit)}\`${m.previous.date ? ` (${m.previous.date})` : ""}` : "";
  if (m.status === "no-marker") {
    return (
      "Este repo não tem `aiteam/UPSTREAM`, o marcador do último sync: **não dá para medir** o que mudou nos " +
      "arquivos de raiz desde então. Confira **todos** os itens do checklist e os avisos de arquivos de raiz do " +
      `\`node aiteam/scripts/doctor.mjs\` (eles comparam com o upstream sem precisar do histórico).${tail}`
    );
  }
  if (m.status === "malformed") {
    return (
      "O `aiteam/UPSTREAM` deste repo não tem uma linha `commit: <sha>`: **não dá para medir** o que mudou nos " +
      `arquivos de raiz desde o último sync. Confira **todos** os itens do checklist.${tail}`
    );
  }
  if (m.status === "unknown-commit") {
    // No sync o fetch acabou de rodar: o commit não vir não é fetch pendente, é histórico reescrito ou sha gravado errado.
    const why = fetched
      ? "o `git fetch upstream` acabou de rodar, então o histórico do upstream foi reescrito, ou o marcador foi gravado à mão com um sha errado"
      : "um `git fetch upstream` pendente, ou o histórico do upstream reescrito";
    return (
      `O \`aiteam/UPSTREAM\` aponta para ${previous}, que o upstream local não tem como ancestral (${why}): ` +
      `**não dá para medir** o que mudou nos arquivos de raiz desde o último sync. Confira **todos** os itens do checklist.${tail}`
    );
  }
  if (m.status === "same") {
    return `Último sync registrado: ${previous}, o mesmo commit do upstream atual. Nada mudou nos arquivos de raiz.${tail}`;
  }
  const entries = m.entries ?? [];
  const head = `Último sync registrado: ${previous}. O upstream está em ${current}.`;
  if (entries.length === 0) {
    return `${head} Nenhum commit do upstream tocou arquivos de raiz nesse intervalo.${tail}`;
  }
  const lines = entries.map((e) => `- \`${e.hash}\` ${e.date} ${e.subject} — ${e.files.map((f) => `\`${f}\``).join(", ")}`);
  return (
    `${head} ${entries.length} commit(s) do upstream tocaram arquivos de raiz desde então ` +
    `(o que o checklist e o doctor pedem para reconciliar):\n\n${lines.join("\n")}${tail}`
  );
}

// ─── o que o doctor julga ───────────────────────────────────────────────────────

/** O apontador do .beads/SCHEMA.md: o contrato do .beads viaja com o aiteam/ (rb-ai-team#37, fase 1). */
const SCHEMA_POINTER_PATH = "aiteam/docs/beads-schema.md";

/** O apontador tem de estar nestas primeiras linhas (o do upstream está na 3ª). O manifest do sync usa o mesmo limite. */
export const SCHEMA_POINTER_LINES = 10;

/** Com tantos títulos numerados (## 1., ### 2.1) o arquivo é a cópia do contrato, não o apontador. O manifest usa o mesmo número. */
export const SCHEMA_COPY_SECTIONS = 3;

/**
 * O texto é o apontador do .beads/SCHEMA.md? Um blockquote (a linha abre com `>`) que cita
 * aiteam/docs/beads-schema.md nas primeiras SCHEMA_POINTER_LINES linhas — como o do upstream. Uma menção ao
 * caminho em prosa, em código, numa lista ou num blockquote lá embaixo NÃO é o apontador: uma cópia legada do
 * contrato que cita o caminho dava PASS falso (QA da #39, A3). BOM e CRLF não mudam a leitura.
 * O item do manifest do sync (grep-absent) tem de concordar com isto; config.test.mjs confere os dois.
 * @param {string|null|undefined} text
 */
export function hasSchemaPointer(text) {
  const lines = String(text ?? "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/);
  const cites = lines.slice(0, SCHEMA_POINTER_LINES).some((line) => line.startsWith(">") && line.includes(SCHEMA_POINTER_PATH));
  if (!cites) return false;
  // Um blockquote no topo que cita o caminho não basta: a cópia legada do crm abre com um que explica o modo legado e
  // LINKA o contrato novo, e segue com as seções numeradas do contrato antigo. O apontador não carrega o contrato:
  // com SCHEMA_COPY_SECTIONS títulos numerados ou mais (## 1., ### 2.1) o arquivo é a cópia.
  const numbered = lines.filter((line) => /^#{2,3}[ \t]+\d+(?:\.\d+)*\.?[ \t]/.test(line)).length;
  return numbered < SCHEMA_COPY_SECTIONS;
}

/** O shim de cada engine e a linha que importa as instruções do framework. */
export const SHIMS = Object.freeze([
  { file: "AGENTS.md", line: "@aiteam/AGENTS.md", fix: "node aiteam/install.mjs" },
  { file: "CLAUDE.md", line: "@aiteam/CLAUDE.md", fix: "node aiteam/install.mjs" },
  // O install só injeta a linha em CLAUDE.md e AGENTS.md: o GEMINI.md vai à mão.
  { file: "GEMINI.md", line: "@aiteam/GEMINI.md", fix: null },
]);

/**
 * As regras eol=lf do .gitattributes que o checklist do sync cobra
 * (tools/aiteam-sync/manifest.json). O driver antigo e o merge=union de .beads/ são
 * regras que SOBRAM, não que faltam: o checkMergeDriverResidue do doctor-core cobre o
 * primeiro; o segundo só o checklist cobra.
 */
export const GITATTRIBUTES_EOL_PATTERNS = Object.freeze(["*.mjs", "*.mts", "aiteam/agents/*.md", ".claude/agents/*.md", "SPEC.md"]);

const lines = (text) => String(text ?? "").split(/\r?\n/);

// Mesmo critério do ensureImportLine do install-core: a linha, aparada, é o import.
const hasImportLine = (text, line) => lines(text).some((l) => l.trim() === line);

/** As regras do .gitattributes: [padrão, atributos...], sem comentário e sem linha em branco. */
function attributeRules(text) {
  const out = [];
  for (const raw of lines(text)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern, ...attrs] = line.split(/\s+/);
    out.push({ pattern: pattern.replace(/^\//, ""), attrs });
  }
  return out;
}

/** O .gitattributes tem uma regra eol=lf para o padrão (ou uma que vale para tudo, `*`)? */
function hasEolLf(rules, pattern) {
  return rules.some((r) => r.attrs.includes("eol=lf") && (r.pattern === pattern || r.pattern === "*" || r.pattern === "**"));
}

const passed = (name, detail) => ({ name, pass: true, detail });
const warned = (name, detail) => ({ name, pass: true, warn: true, detail });

/**
 * .beads/SCHEMA.md × upstream: o upstream distribui um apontador para
 * aiteam/docs/beads-schema.md; o do consumidor ainda é uma cópia do contrato (que
 * envelhece: o do mesa-crm parou no §9 enquanto o contrato foi até o §11) ou não existe.
 *
 * Em MODO LEGADO (o .beads/active.yaml do modelo antigo ainda rastreado) o contrato do framework manda seguir o
 * .beads/SCHEMA.md LOCAL até migrar (beads-schema.md §11, BOOT.md, AGENTS.md): o apontador manda escrever em
 * .beads/tasks/, que o pre-commit recusa nesse modo. A troca é da migração, então ali a cópia passa.
 *
 * @param {{ref: string, local: string|null, remote: string|null, legacy?: boolean}} facts
 *   `local`/`remote`: o texto do arquivo no consumidor e no upstream, null se não existe;
 *   `legacy`: o repo ainda está no modelo antigo de .beads
 */
export function checkSchemaPointer({ ref, local, remote, legacy = false }) {
  const name = ".beads/SCHEMA.md × upstream";
  if (remote === null || !hasSchemaPointer(remote)) {
    return passed(name, `não comparado: o ${ref} não tem um .beads/SCHEMA.md com o apontador para aiteam/docs/beads-schema.md`);
  }
  if (legacy) {
    const migrate = "node aiteam/scripts/migrate-beads.mjs --dry-run";
    if (local === null) {
      return warned(
        name,
        `o arquivo não existe, e em modo legado ele é o contrato em vigor até migrar (beads-schema.md §11): recupere a sua cópia do histórico do repo. ` +
          `O apontador do upstream só entra na migração (${migrate})`,
      );
    }
    if (hasSchemaPointer(local)) {
      return warned(
        name,
        `o arquivo já é o apontador, mas este repo ainda está em modo legado: o apontador manda escrever em .beads/tasks/, e o pre-commit recusa ` +
          `isso até migrar (beads-schema.md §11). Migre (${migrate}) ou volte à cópia do contrato até lá`,
      );
    }
    return passed(
      name,
      `modo legado: a cópia local é o contrato em vigor até migrar. O apontador do upstream manda escrever em .beads/tasks/, e o pre-commit recusa ` +
        `isso em modo legado: troque pelo apontador na migração (beads-schema.md §11, ${migrate})`,
    );
  }
  const how = `git show ${ref}:.beads/SCHEMA.md  # mantenha só o que é seu, num apêndice "Convenções locais"`;
  if (local === null) {
    return warned(name, `o arquivo não existe. O upstream distribui o apontador para aiteam/docs/beads-schema.md: ${how}`);
  }
  if (hasSchemaPointer(local)) {
    return passed(name, "aponta para aiteam/docs/beads-schema.md: o contrato viaja com o aiteam/");
  }
  return warned(
    name,
    "é uma cópia do contrato e não aponta para aiteam/docs/beads-schema.md: o texto pode estar atrás do contrato " +
      `(o upstream já o tirou deste arquivo). Troque o corpo pelo apontador: ${how}`,
  );
}

/**
 * AGENTS.md / CLAUDE.md / GEMINI.md × upstream: cada shim do upstream traz a linha que importa as
 * instruções do framework; sem ela o harness não carrega o framework. Só se cobra a linha de um shim
 * que o upstream tem.
 *
 * @param {{ref: string, local: Record<string, string|null>, remote: Record<string, string|null>}} facts
 *   `local`/`remote`: o texto de cada shim, indexado pelo nome do arquivo
 */
export function checkShimImports({ ref, local, remote }) {
  const name = "AGENTS.md / CLAUDE.md / GEMINI.md × upstream";
  const problems = [];
  let compared = 0;
  for (const { file, line, fix } of SHIMS) {
    const upstreamText = remote?.[file] ?? null;
    if (upstreamText === null || !hasImportLine(upstreamText, line)) continue; // o upstream não tem este shim
    compared += 1;
    const mine = local?.[file] ?? null;
    if (mine !== null && hasImportLine(mine, line)) continue;
    const how = fix ? `rode ${fix}` : `acrescente a linha ${line} (o install não a injeta; modelo: git show ${ref}:${file})`;
    problems.push(mine === null ? `${file} não existe — ${how}` : `${file} sem a linha ${line} — ${how}`);
  }
  if (compared === 0) return passed(name, `não comparado: o ${ref} não tem nenhum destes shims com a linha de import`);
  if (problems.length === 0) return passed(name, `os ${compared} shims têm a linha @aiteam/… que o upstream tem`);
  return warned(name, `${problems.join("; ")}. Sem a linha o harness não carrega as instruções do framework`);
}

/**
 * .gitattributes × upstream: as regras eol=lf que o checklist do sync cobra e o upstream tem.
 *
 * @param {{ref: string, local: string|null, remote: string|null}} facts
 */
export function checkGitattributesEol({ ref, local, remote }) {
  const name = ".gitattributes × upstream";
  if (remote === null) return passed(name, `não comparado: o ${ref} não tem .gitattributes`);
  const wanted = GITATTRIBUTES_EOL_PATTERNS.filter((p) => hasEolLf(attributeRules(remote), p));
  if (wanted.length === 0) return passed(name, `não comparado: o ${ref} não tem as regras eol=lf que o checklist cobra`);
  const mine = attributeRules(local ?? "");
  const missing = wanted.filter((p) => !hasEolLf(mine, p));
  if (missing.length === 0) return passed(name, `tem as ${wanted.length} regras eol=lf que o checklist cobra`);
  const rules = missing.map((p) => `${p} text eol=lf`).join("; ");
  return warned(
    name,
    `${local === null ? "o arquivo não existe; " : ""}faltam ${missing.length} regra(s) eol=lf que o upstream tem — ${rules}. ` +
      "Sem elas um checkout Windows (core.autocrlf=true) grava CRLF em scripts com shebang, nas personas e no SPEC.md. " +
      "Depois de acrescentar: git add --renormalize -- <padrões>",
  );
}

// ─── o ci.yml × o modelo ────────────────────────────────────────────────────────

const STEP_RUN = /\b(?:npm|pnpm|yarn)\b[^\n]*?\brun(?:-script)?\s+(?:--?\S+\s+)*([\w:.-]+)/g;

/** Os scripts de `npm run <script>` que um job roda, na ordem em que aparecem, sem repetir. */
function jobScripts(job) {
  const found = [];
  for (const step of Array.isArray(job?.steps) ? job.steps : []) {
    const run = typeof step?.run === "string" ? step.run : "";
    for (const m of run.matchAll(STEP_RUN)) if (!found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

/** O workflow dispara em pull_request? (`on:` como texto, lista ou mapa). */
function triggersOnPullRequest(doc) {
  const on = doc?.on;
  if (typeof on === "string") return on === "pull_request";
  if (Array.isArray(on)) return on.includes("pull_request");
  return on !== null && typeof on === "object" && "pull_request" in on;
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Algum comando de passo roda o script? Tolera `npm --prefix aiteam run x`, `pnpm run x`, flags depois. */
function runsScript(commands, script) {
  const re = new RegExp(`\\b(?:npm|pnpm|yarn)\\b[^\\n]*(?<![\\w:.-])${escapeRegExp(script)}(?![\\w:.-])`);
  return commands.some((c) => re.test(c));
}

/**
 * Os workflows de PR do consumidor × o modelo do upstream (aiteam/templates/ci.yml.example): o job
 * `framework` do modelo valida o aiteam/ vendorizado (typecheck, validate:beads, validate:agents,
 * testes). O consumidor copia o modelo uma vez e o arquivo envelhece: quem copiou antes do
 * `validate:agents` nunca o roda. O doctor lista os scripts do job `framework` do modelo que
 * nenhum workflow de PR do consumidor roda. O que o contrato de CI (checkCiContract) já cobra —
 * os comandos do ci: do SPEC.md, concurrency, timeouts — não se repete aqui, e o nome do arquivo
 * não importa (os consumidores têm ci.yml, build.yml, python-ci.yml...).
 *
 * @param {{ref: string, template: {error?: string, doc?: unknown}|null,
 *          workflows: Array<{file: string, doc?: unknown, error?: string}>|null,
 *          workflowsUnavailable?: string|null}} facts
 */
export function checkCiTemplateSteps({ ref, template, workflows, workflowsUnavailable = null }) {
  const name = "CI de PR × modelo do upstream";
  const model = "aiteam/templates/ci.yml.example";
  if (workflowsUnavailable) return passed(name, `não comparado: ${workflowsUnavailable}`);
  if (!template) return passed(name, `não comparado: o ${ref} não tem ${model}`);
  if (template.error || !template.doc) return passed(name, `não comparado: ${model} do ${ref} não pôde ser lido (${template.error ?? "vazio"})`);
  const wanted = jobScripts(template.doc.jobs?.framework);
  if (wanted.length === 0) return passed(name, `não comparado: o ${model} do ${ref} não tem o job framework`);
  const pr = (workflows ?? []).filter((w) => w.doc && triggersOnPullRequest(w.doc));
  if (pr.length === 0) {
    return passed(name, "não comparado: nenhum workflow dispara em pull_request (o contrato de CI, acima, é quem cobra o pipeline de PR)");
  }
  const commands = pr.flatMap((w) =>
    Object.values(w.doc.jobs ?? {}).flatMap((job) => (Array.isArray(job?.steps) ? job.steps : []).map((s) => String(s?.run ?? ""))),
  );
  const missing = wanted.filter((script) => !runsScript(commands, script));
  const files = pr.map((w) => w.file).join(", ");
  if (missing.length === 0) return passed(name, `os workflows de PR (${files}) rodam os ${wanted.length} scripts do job framework do modelo`);
  return warned(
    name,
    `o job framework de ${model} (${ref}) roda ${missing.map((s) => `npm run ${s}`).join(", ")}; nenhum workflow de PR seu (${files}) o roda. ` +
      `O modelo é copiado uma vez e envelhece: git show ${ref}:${model}. Se roda por outro caminho, ignore`,
  );
}

// ─── a ref do upstream e o marcador ─────────────────────────────────────────────

/**
 * A linha do remote/ref do upstream: se dá para comparar, se a ref está velha e o que o marcador
 * aiteam/UPSTREAM diz do último sync. Não tem `git fetch`: o doctor é só leitura e sem rede.
 *
 * @param {{upstream: {state: "no-git"|"no-remote"|"no-ref"|"ok", ref?: string, sha?: string, ageDays?: number|null},
 *          marker?: {state: "absent"|"malformed"|"ok", commit?: string, date?: string|null},
 *          since?: {status: string, entries?: unknown[]}|null}} facts
 */
export function checkUpstreamRef({ upstream, marker = { state: "absent" }, since = null }) {
  const name = "upstream do rb-ai-team (arquivos de raiz)";
  if (upstream.state === "no-git") return passed(name, "não comparado: o git não respondeu");
  if (upstream.state === "no-remote" && upstream.alias) {
    return warned(
      name,
      `não há o remote ${UPSTREAM_REMOTE}, mas o remote ${upstream.alias} aponta para o rb-ai-team: renomeie-o para o doctor e o aiteam-sync o acharem ` +
        `(o guia manda o nome ${UPSTREAM_REMOTE}): git remote rename ${upstream.alias} ${UPSTREAM_REMOTE}`,
    );
  }
  if (upstream.state === "no-remote") {
    return passed(
      name,
      `não comparado: sem o remote ${UPSTREAM_REMOTE} (git remote add ${UPSTREAM_REMOTE} <url do rb-ai-team>; ver aiteam/docs/consuming-as-upstream.md)`,
    );
  }
  if (upstream.state === "no-ref") {
    return warned(
      name,
      `o remote ${UPSTREAM_REMOTE} existe, mas nem ${UPSTREAM_BRANCHES.map((b) => `${UPSTREAM_REMOTE}/${b}`).join(" nem ")} foi buscado: ` +
        `rode git fetch ${UPSTREAM_REMOTE} (o doctor nunca roda fetch)`,
    );
  }
  const ref = upstream.ref;
  const parts = [`${ref} = ${short(upstream.sha)}`];
  const stale = typeof upstream.ageDays === "number" && upstream.ageDays > STALE_DAYS;
  if (typeof upstream.ageDays === "number") parts[0] += ` (${upstream.ageDays} ${upstream.ageDays === 1 ? "dia" : "dias"})`;

  if (marker.state === "ok") {
    parts.push(`último sync: ${short(marker.commit)}${marker.date ? ` (${marker.date})` : ""}`);
    if (since?.status === "changes") {
      const n = since.entries?.length ?? 0;
      parts.push(
        n === 0
          ? "nenhum commit do upstream tocou arquivos de raiz desde então"
          : `${n} commit(s) do upstream tocaram arquivos de raiz desde então (node aiteam/scripts/upstream-marker.mjs changes)`,
      );
    } else if (since?.status === "same") {
      parts.push("aiteam/ já veio deste commit");
    } else if (since?.status === "unknown-commit") {
      parts.push(`o ${ref} local não tem esse commit (git fetch ${UPSTREAM_REMOTE}?): não dá para medir o que mudou na raiz`);
    }
  } else if (marker.state === "malformed") {
    parts.push("aiteam/UPSTREAM sem uma linha commit: <sha> — não dá para medir o que mudou na raiz desde o último sync");
  } else {
    parts.push(
      "sem aiteam/UPSTREAM — não dá para medir o que mudou na raiz desde o último sync; confira todos os arquivos de raiz abaixo " +
        "(o sync e node aiteam/scripts/upstream-marker.mjs write gravam o marcador)",
    );
  }
  if (stale) {
    parts.push(
      `a ponta do ${ref} tem ${upstream.ageDays} dias: pode ser normal se o upstream andou devagar, mas confirme com git fetch ${UPSTREAM_REMOTE} ` +
        "antes de confiar nesta comparação (o doctor nunca roda fetch)",
    );
    return warned(name, parts.join("; "));
  }
  return passed(name, parts.join("; "));
}

/**
 * Todas as linhas dos arquivos de raiz × upstream. Sem remote ou sem ref, só a linha da ref (que diz por quê).
 *
 * @param {object} facts o que readRootFilesFacts (root-files-io.mjs) devolve
 * @returns {Array<{name: string, pass: boolean, warn?: boolean, detail?: string}>}
 */
export function checkRootFilesUpstream(facts) {
  const header = checkUpstreamRef(facts);
  if (facts.upstream.state !== "ok") return [header];
  const ref = facts.upstream.ref;
  return [
    header,
    checkSchemaPointer({
      ref,
      local: facts.local[".beads/SCHEMA.md"] ?? null,
      remote: facts.remote[".beads/SCHEMA.md"] ?? null,
      legacy: facts.legacy === true,
    }),
    checkShimImports({ ref, local: facts.local, remote: facts.remote }),
    checkGitattributesEol({ ref, local: facts.local[".gitattributes"] ?? null, remote: facts.remote[".gitattributes"] ?? null }),
    checkCiTemplateSteps({
      ref,
      template: facts.template ?? null,
      workflows: facts.workflows ?? null,
      workflowsUnavailable: facts.workflowsUnavailable ?? null,
    }),
  ];
}
