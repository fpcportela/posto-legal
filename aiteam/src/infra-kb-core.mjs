// Núcleo puro do slot infra_kb: lê o ponteiro do SPEC.md, parseia a KB do host
// compartilhado e decide o que injetar. É a ÚNICA fonte dessa lógica, importada
// pelas cascas de I/O (aiteam/hooks/session-brief.mjs,
// aiteam/hooks/infra-kb-guard.mjs, aiteam/scripts/infra-kb-claim.mjs) e pelos
// testes em aiteam/src/infra-kb-core.test.ts.
//
// Este arquivo NÃO pode carregar shebang: o strip do vite-node deixa um CR
// órfão em checkout CRLF e o módulo morre com "SyntaxError: Invalid or
// unexpected token". Mesmo split de tier-core.mjs/tier-guard.mjs — só a casca,
// que nunca é importada, tem `#!`.
//
// yamlLoad é injetado (não importado) para que um aiteam/node_modules ausente
// degrade em vez de estourar na resolução do módulo. O frontmatter sai do
// leitor compartilhado (frontmatter.mjs, local e sem dependências), o mesmo
// do tier-core e do circuit-breaker.

import { extractFrontmatter } from "./frontmatter.mjs";

/**
 * @param {string|null} specText conteúdo bruto do SPEC.md
 * @param {(t: string) => unknown} yamlLoad
 * @returns {{remote: string, url: string|null, ref: string, entry: string}|null}
 */
export function readPointer(specText, yamlLoad) {
  if (!specText) return null;
  const frontmatter = extractFrontmatter(specText);
  if (frontmatter === null) return null;

  let doc;
  try {
    doc = yamlLoad(frontmatter);
  } catch {
    return null;
  }

  const kb = doc && typeof doc === "object" ? doc.infra_kb : null;
  if (!kb || typeof kb !== "object") return null;

  const remote = String(kb.remote ?? "").trim();
  if (!remote) return null;

  return {
    remote,
    url: String(kb.url ?? "").trim() || null,
    ref: String(kb.ref ?? "").trim() || "main",
    entry: String(kb.entry ?? "").trim() || "README.md",
  };
}

/**
 * Diagnóstico do ponteiro para `doctor` — o único consumidor que precisa
 * DISTINGUIR "sem slot nenhum" de "slot presente e malformado" (spec §7:
 * "Ponteiro malformado | Tratado como ausente pelos hooks (nunca quebram);
 * doctor.mjs reclama."). `readPointer` acima colapsa as duas em `null` de
 * propósito — é o que os hooks (session-brief, infra-kb-guard) precisam pra
 * nunca quebrar — então esta função não substitui `readPointer`, é uma
 * segunda leitura, só para o doctor. Ela NÃO reimporta a lógica de fetch/git:
 * só decide se o BLOCO no frontmatter é utilizável.
 *
 * "Malformado" exige sinal real de configuração quebrada — não apenas campos
 * vazios: o próprio template deste repo (`SPEC.md` na raiz) declara
 * `infra_kb` com `remote`/`url` em branco de propósito ("o projeto não roda
 * em infra compartilhada"), e ESSE estado tem que continuar batendo com
 * "absent" (PASS silencioso), não com "malformed". O que aciona "malformed":
 *   - `infra_kb` não é um mapeamento (é string/número/lista);
 *   - algum campo do bloco é ele mesmo um objeto/lista — a assinatura de um
 *     bloco aninhado errado (ex.: `infra_kb: { config: { remote: ... } }`),
 *     onde nenhum campo reconhecido chega a aparecer direto sob `infra_kb`;
 *   - `remote` tem um tipo que não é string (um número, um objeto — ver o
 *     Minor: sem essa guarda, `readPointer` aceitaria e um objeto viraria a
 *     string literal "[object Object]");
 *   - `url` está preenchida mas `remote` ficou vazia — a combinação que só
 *     acontece por acidente (ninguém preenche a URL de um remote que não vai
 *     criar) e nunca no template deliberadamente vazio (onde as duas ficam
 *     em branco juntas).
 * Frontmatter ausente, sem bloco `infra_kb`, ou bloco com `remote`/`url`
 * ambos em branco (o template) → "absent", igual a hoje.
 *
 * @param {string|null} specText
 * @param {(t: string) => unknown} yamlLoad
 * @returns {{state: "absent"}
 *          |{state: "malformed", reason: string}
 *          |{state: "ok", pointer: {remote: string, url: string|null, ref: string, entry: string}}}
 */
export function diagnosePointer(specText, yamlLoad) {
  if (!specText) return { state: "absent" };
  const frontmatter = extractFrontmatter(specText);
  if (frontmatter === null) return { state: "absent" };

  let doc;
  try {
    doc = yamlLoad(frontmatter);
  } catch {
    return { state: "malformed", reason: "o frontmatter do SPEC.md não é YAML válido" };
  }

  if (!doc || typeof doc !== "object" || !("infra_kb" in doc)) {
    return { state: "absent" };
  }

  const kb = doc.infra_kb;
  if (kb === null || kb === undefined) return { state: "absent" };
  if (typeof kb !== "object") {
    return {
      state: "malformed",
      reason: "infra_kb não é um mapeamento (esperado remote/url/ref/entry) — confira a indentação",
    };
  }

  const hasNestedField = Object.values(kb).some((v) => v !== null && typeof v === "object");
  if (hasNestedField) {
    return {
      state: "malformed",
      reason: "infra_kb tem um campo aninhado onde deveria haver um texto simples — confira a indentação",
    };
  }

  const remoteRaw = kb.remote;
  const remoteTypeInvalid = remoteRaw !== undefined && remoteRaw !== null && typeof remoteRaw !== "string";
  const remote = typeof remoteRaw === "string" ? remoteRaw.trim() : "";
  const url = typeof kb.url === "string" ? kb.url.trim() : "";

  if (!remote) {
    // Ambos em branco (nenhum sinal de configuração real) == template vazio ==
    // absent. Só é "malformed" quando HÁ sinal de que alguém tentou preencher.
    if (!url && !remoteTypeInvalid) return { state: "absent" };
    return {
      state: "malformed",
      reason: remoteTypeInvalid
        ? "infra_kb.remote não é um texto — confira o valor no frontmatter"
        : "infra_kb.url está preenchida mas infra_kb.remote está vazia — sem remote não há como criar o git remote nem ler a KB",
    };
  }

  return {
    state: "ok",
    pointer: {
      remote,
      url: url || null,
      ref: (typeof kb.ref === "string" && kb.ref.trim()) || "main",
      entry: (typeof kb.entry === "string" && kb.entry.trim()) || "README.md",
    },
  };
}

// A tabela é localizada pelo CABEÇALHO, não pelo número da seção: o README do
// host é renumerado de tempos em tempos (o §13 nasceu depois do §11), e um
// parser ancorado em "## 4." quebraria em silêncio na próxima renumeração.
const PORT_TABLE_HEADER = /^\|\s*Port\s*\|\s*App\s*\|\s*Service\s*\|/im;
const LIMIT_TABLE_HEADER = /^\|\s*Class\s*\|\s*Suggested limit\s*\|/im;
const RULES_HEADING = /^#{1,6}\s+[\d.\s]*Rules?\b.*$/im;
const FREE_RANGES_LINE = /^.*Free ranges.*$/im;
const SEPARATOR_ROW = /^\|[\s:-]+\|/;

function cells(line) {
  return line
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

/** Menor inteiro >= seed que não está em `claimed`. */
export function nextFreePort(claimed, seed) {
  const taken = new Set((claimed ?? []).filter((n) => Number.isInteger(n)));
  let p = seed;
  while (taken.has(p)) p += 1;
  return p;
}

function tableRowsAfter(lines, headerIndex) {
  const rows = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trimStart().startsWith("|")) break;
    if (SEPARATOR_ROW.test(line.trim())) continue;
    rows.push(line);
  }
  return rows;
}

function sectionAfter(text, headingRe) {
  const m = headingRe.exec(text);
  if (!m) return "";
  const rest = text.slice(m.index + m[0].length);
  const next = /^#{1,6}\s+/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

function limitsTable(text, lines) {
  const m = LIMIT_TABLE_HEADER.exec(text);
  if (!m) return "";
  const headerIndex = lines.findIndex((l) => LIMIT_TABLE_HEADER.test(l));
  if (headerIndex < 0) return "";
  return [lines[headerIndex], ...tableRowsAfter(lines, headerIndex)].join("\n");
}

/**
 * @param {string|null} readmeText
 * @returns {{ok: true, ports: Array<object>, freeRanges: number[], sections: {rules: string, limits: string}}
 *          |{ok: false, reason: string}}
 */
export function extract(readmeText) {
  const text = String(readmeText ?? "");
  if (!text.trim()) {
    return { ok: false, reason: "KB vazia ou ilegível." };
  }
  if (!PORT_TABLE_HEADER.test(text)) {
    return {
      ok: false,
      reason:
        "não encontrei o registro de portas (cabeçalho `| Port | App | Service |`) — a KB pode ter sido reestruturada; leia o documento inteiro antes de reservar qualquer porta.",
    };
  }

  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((l) => PORT_TABLE_HEADER.test(l));
  const rawRows = tableRowsAfter(lines, headerIndex);
  // "Lista vazia disfarçada de sucesso": o cabeçalho existe mas nenhuma linha
  // de dado o segue (ex.: uma linha em branco entre o cabeçalho e as linhas).
  // Devolver ok:true com ports:[] faria a faixa livre derivada colapsar de
  // volta pra frase desatualizada — o bug exato que este módulo existe pra
  // evitar. Falha barulhenta, nunca vazia.
  if (rawRows.length === 0) {
    return {
      ok: false,
      reason:
        "encontrei o cabeçalho do registro de portas (`| Port | App | Service |`), mas nenhuma linha de dado depois dele — leia o documento inteiro antes de declarar qualquer coisa sobre portas.",
    };
  }
  const ports = rawRows.map((line) => {
    const c = cells(line);
    const raw = c[0] ?? "";
    // "80 / 443" não é uma porta reservável: guarda o texto e deixa port nulo
    // em vez de fingir que é 80.
    const solo = /^(\d+)$/.exec(raw.trim());
    return {
      port: solo ? Number(solo[1]) : null,
      raw,
      app: c[1] ?? "",
      service: c[2] ?? "",
      notes: c[3] ?? "",
    };
  });

  const claimed = ports.map((p) => p.port).filter((p) => Number.isInteger(p));
  // A frase "Free ranges" dá as SEMENTES (onde cada bloco começa); as linhas
  // dão a verdade. Semear pela frase e avançar pelas linhas devolve a faixa
  // certa mesmo quando a frase está desatualizada — que é o caso comum.
  const freeLine = FREE_RANGES_LINE.exec(text);
  const seeds = freeLine ? [...freeLine[0].matchAll(/`(\d+)\+`/g)].map((m) => Number(m[1])) : [];
  const freeRanges = seeds.map((seed) => nextFreePort(claimed, seed));

  return {
    ok: true,
    ports,
    freeRanges,
    sections: {
      rules: sectionAfter(text, RULES_HEADING),
      limits: limitsTable(text, lines),
    },
  };
}

const INFRA_PATTERNS = [
  /(^|\/)docker-compose[^/]*\.ya?ml$/i,
  /(^|\/)Dockerfile(\.[\w-]+)?$/,
  /(^|\/)infra\//i,
  /(^|\/)terraform\//i,
  /(^|\/)nginx\/.*\.conf$/i,
  /\.tf$/i,
];

/**
 * O gatilho de arquivo. Documentação SOBRE infra não é infra — um `.md` que
 * explica o Dockerfile não muda recurso nenhum no host, e injetar o extrato
 * nele seria ruído em toda edição de doc.
 * @param {string|null} filePath
 */
export function matchesInfraPath(filePath) {
  const p = String(filePath ?? "").replace(/\\/g, "/");
  if (!p) return false;
  if (/\.(md|markdown|txt)$/i.test(p)) return false;
  return INFRA_PATTERNS.some((re) => re.test(p));
}

const DEFAULT_MAX_NOTE = 90;

function truncate(s, max) {
  const t = String(s ?? "").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * Rende o extrato que entra em contexto. Deliberadamente compacto: o README do
 * host passa de 40k caracteres, e injetá-lo inteiro custaria mais que o
 * problema que resolve.
 * @param {{ports: Array<object>, freeRanges: number[], sections: {rules: string, limits: string}}} result
 * @param {{maxNoteChars?: number}} [opts]
 */
export function formatExtract(result, opts = {}) {
  const maxNote = opts.maxNoteChars ?? DEFAULT_MAX_NOTE;
  const out = ["## KB de infra — recursos já em uso no host"];

  out.push("", "Portas reservadas:");
  for (const row of result.ports ?? []) {
    out.push(`  ${row.raw} · ${row.app} · ${row.service} — ${truncate(row.notes, maxNote)}`);
  }

  if ((result.freeRanges ?? []).length) {
    out.push("", `Faixas livres (derivadas das linhas acima): ${result.freeRanges.map((p) => `${p}+`).join(", ")}`);
  }

  if (result.sections?.rules) {
    out.push("", "Regras do host:", result.sections.rules);
  }
  if (result.sections?.limits) {
    out.push("", "Limites por classe de serviço:", result.sections.limits);
  }
  return out.join("\n");
}

/**
 * Detecta o terminador de linha dominante do texto de entrada, para que o
 * texto de SAÍDA herde o MESMO terminador — nunca imponha LF. O write-back
 * clona a KB no disco do operador; num checkout Windows com
 * `core.autocrlf=true` e sem regra de `.gitattributes` para o path da KB, o
 * arquivo chega com CRLF. Impor LF na saída reescreveria (removeria o `\r`
 * de) TODA linha do arquivo — exatamente a corrupção que `claimPort` existe
 * para impedir, só que disfarçada de "só mudei o join".
 *
 * Critério, explícito por ser uma escolha: conta pares `\r\n` vs. `\n`
 * solitário e usa o mais frequente; texto sem terminador nenhum (ou empate,
 * inclusive 0 a 0) cai no default `\n`. Não tenta preservar mistura — um
 * arquivo com os dois terminadores sai inteiro com o dominante.
 * @param {string} text
 */
function detectEol(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const loneLf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > loneLf ? "\r\n" : "\n";
}

/**
 * Reserva uma porta no registro. Escreve UMA linha nova, mantém o bloco de
 * portas em ordem numérica ascendente e, quando necessário, reescreve a frase
 * "Free ranges" — nada mais muda. O KB real nem sempre chega ordenado (linhas
 * agrupadas por app/cronologia, não por porta — ver `8090` antes de `3212` na
 * fixture), então manter "ordem numérica" às vezes exige reposicionar uma
 * linha existente; quando isso acontece, o CONTEÚDO da linha sai byte a byte
 * idêntico, só a posição muda. Num repo compartilhado, alterar o conteúdo de
 * uma linha alheia apagaria a reserva de outro projeto — essa é a garantia
 * que substitui a revisão por PR. Essa garantia inclui o terminador de linha:
 * a saída usa o MESMO terminador do input (ver `detectEol`) — se impuséssemos
 * LF num input CRLF, toda linha "sobreviveria" com conteúdo idêntico mas
 * BYTES diferentes (sem o `\r`), e o teste que existe pra pegar exatamente
 * essa corrupção reportaria, corretamente, que nenhuma linha sobrou intacta.
 *
 * @param {string} readmeText
 * @param {{port: number, app: string, service: string, notes: string}} claim
 * @returns {{ok: true, text: string, changed: boolean}|{ok: false, reason: string}}
 */
export function claimPort(readmeText, claim) {
  const parsed = extract(readmeText);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const dono = parsed.ports.find((p) => p.port === claim.port);
  if (dono && dono.app !== claim.app) {
    return {
      ok: false,
      reason: `porta ${claim.port} já é de "${dono.app}" (${dono.service}) — escolha outra; a próxima livre é ${nextFreePort(
        parsed.ports.map((p) => p.port).filter((p) => Number.isInteger(p)),
        claim.port
      )}`,
    };
  }
  if (dono) return { ok: true, text: readmeText, changed: false };

  const eol = detectEol(readmeText);
  const lines = readmeText.split(/\r?\n/);
  const headerIndex = lines.findIndex((l) => PORT_TABLE_HEADER.test(l));
  const rowLine = `| ${claim.port} | ${claim.app} | ${claim.service} | ${claim.notes} |`;

  // Delimita o bloco de linhas de dado: começa logo após o separador, termina
  // na primeira linha que não abre mais com "|".
  let rowsStart = headerIndex + 1;
  let rowsEnd = headerIndex + 1;
  for (; rowsEnd < lines.length; rowsEnd += 1) {
    const line = lines[rowsEnd];
    if (!line.trimStart().startsWith("|")) break;
    if (SEPARATOR_ROW.test(line.trim())) rowsStart = rowsEnd + 1;
  }

  const portOf = (line) => {
    const solo = /^(\d+)$/.exec(cells(line)[0]?.trim() ?? "");
    return solo ? Number(solo[1]) : Number.NEGATIVE_INFINITY;
  };

  // DECISÃO DO OPERADOR (não um acidente): a tabela é mantida canonicamente
  // ordenada por porta. O registro real HOJE não chega ordenado — linhas
  // agrupadas por app/cronologia, não por porta (`8090` antes de `3212` na
  // KB de verdade) — então a primeira reserva real vai reposicionar linhas
  // existentes para restaurar a ordem. Isso é esperado: o diff resultante vai
  // mostrar linhas antigas "movendo". O que NUNCA acontece é o conteúdo de
  // uma linha mudar — o sort abaixo é estável e só troca a POSIÇÃO das
  // linhas, nunca os bytes de nenhuma delas (ver o teste "não altera, não
  // perde e não duplica nenhuma linha existente").
  const sortedRows = [...lines.slice(rowsStart, rowsEnd), rowLine]
    .map((line, i) => ({ line, i, port: portOf(line) }))
    .sort((a, b) => a.port - b.port || a.i - b.i)
    .map((x) => x.line);
  lines.splice(rowsStart, rowsEnd - rowsStart, ...sortedRows);

  // Reescreve a frase de faixas livres a partir do estado NOVO da tabela.
  const claimedDepois = [...parsed.ports.map((p) => p.port).filter((p) => Number.isInteger(p)), claim.port];
  const freeIdx = lines.findIndex((l) => /Free ranges/i.test(l));
  if (freeIdx >= 0) {
    lines[freeIdx] = lines[freeIdx].replace(/`(\d+)\+`/g, (_m, n) => `\`${nextFreePort(claimedDepois, Number(n))}+\``);
  }

  return { ok: true, text: lines.join(eol), changed: true };
}

/**
 * Uma linha (ou duas) para o brief de SessionStart. Devolve null quando o
 * projeto não declara infra_kb — nenhum projeto fora do host compartilhado
 * paga ruído por essa feature existir.
 * @param {{pointer: object|null, fetched: boolean, remoteExists: boolean,
 *          refDate: string|null, ageDays: number|null, extracted: object|null}} input
 */
export function buildInfraKbLine(input) {
  const { pointer, fetched, remoteExists, refDate, ageDays, extracted } = input ?? {};
  if (!pointer) return null;

  if (!remoteExists) {
    return `⚠️ infra KB: remote "${pointer.remote}" não existe neste repo — rode \`node aiteam/install.mjs\` (ou \`git remote add ${pointer.remote} <url>\`).`;
  }

  if (!fetched) {
    const idade = ageDays === null || ageDays === undefined ? "idade desconhecida" : `${ageDays} dias`;
    return `⚠️ infra KB: fetch de ${pointer.remote} falhou · ref local de ${refDate ?? "?"} (${idade}) — NÃO reserve porta nem parâmetro de recurso sem sincronizar; proponha e peça confirmação humana.`;
  }

  if (!extracted || extracted.ok !== true) {
    const motivo = extracted?.reason ?? "erro desconhecido";
    return `⚠️ infra KB: ${pointer.remote} sincronizada, mas ${motivo}`;
  }

  const faixas = extracted.freeRanges.length
    ? ` · portas livres ${extracted.freeRanges.map((p) => `${p}+`).join(", ")}`
    : "";
  // "sincronizada" é verdade agora mesmo (fetched === true, acabamos de rodar
  // o fetch com sucesso) — mas refDate é a data do COMMIT no topo do ref, não
  // a data do fetch. As duas coisas parecem a mesma coisa numa linha só
  // ("sincronizada (main @ <data>)" lê como "sincronizado NA data"), então o
  // conteúdo ganha o rótulo próprio para não prometer frescor que a data não
  // mede (mesma distinção do checkInfraKb em doctor-core.mjs).
  return `infra KB: ${pointer.remote} sincronizada agora · conteúdo do ref ${pointer.ref} é de ${refDate ?? "?"}${faixas} · leia \`git show ${pointer.remote}/${pointer.ref}:${pointer.entry}\` antes de definir recurso novo.`;
}
