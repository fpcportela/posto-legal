// Sondagem de crescimento do tempo de um padrão regex — o teste de ReDoS que o
// tier-guard e o doctor compartilham.
//
// Por que existe. O guard roda cada padrão de tier-rules.json contra o comando
// inteiro, no motor de backtracking do V8. Um padrão com repetição ambígua
// ((\s+-\w+(\s+\S+)?)*, onde o `\S+` opcional também casa o próximo `-a`) custa
// tempo EXPONENCIAL no tamanho da entrada: `ssh` + 36 flags `-a` (111 bytes) leva
// 1 s. O hook estoura o timeout, e o timeout de um hook é falha ABERTA — o
// comando roda sem passar pelo gate. Quem controla o comando (um agente
// comprometido, um prompt injetado) controla o tempo. Esta sondagem mede o
// crescimento em vez de adivinhar pela forma do padrão: uma heurística estática
// de "quantificador aninhado" também reprova o padrão seguro
// (\s+-\w+(\s+\S+)?)* quando cada volta começa num delimitador, e reprovaria o
// padrão canônico.
//
// Como mede. Para cada "família" de entradas adversárias (um prefixo, uma unidade
// repetida até o tamanho pedido e um sufixo que força a falha no fim) o tempo do
// `regex.test` é medido numa escada de tamanhos crescentes (x`step`). Dois cortes
// param a escada, e é isso que limita o custo mesmo de um padrão exponencial:
//
//  - orçamento: uma medição acima de `budgetMs` reprova na hora;
//  - crescimento: o expoente local `log(t/t_anterior) / log(n/n_anterior)` acima de
//    `maxDegree` em `strikes` degraus SEGUIDOS (com o tempo já acima de `floorMs`).
//    Polinômio dá expoente pequeno (linear 1, quadrático 2, cúbico 3); exponencial
//    dá um expoente que só sobe. O corte é 3: o quadrático legítimo mais lento do
//    template mede ~2,1, e o cúbico de ssh+shell mediu 3,4 em 2 KB → 4 KB. Exigir degraus seguidos descarta o salto isolado que o
//    V8 dá quando realoca a pilha de backtracking, que não se repete no degrau
//    seguinte.
//
// Limite honesto: as famílias vêm do próprio padrão (as palavras e os caracteres
// dele) e de um conjunto genérico, não de uma análise do autômato. Um padrão que só
// degenera numa forma de entrada fora das famílias passa. Cobre o ReDoS de verdade
// que já aconteceu aqui; não prova ausência de ReDoS.
//
// Sem dependências e sem shebang (mesma separação de tier-core.mjs): o doctor roda
// em node puro, e o filho que ele dispara para a sondagem (scripts/regex-probe.mjs)
// importa este módulo. O tempo é medido com `performance.now()`.

/** Defaults da sondagem. O teste do template sobe `maxSize` para 4 KB; o doctor desce. */
export const PROBE_DEFAULTS = Object.freeze({
  flags: "i",
  // 12 bytes: um padrão exponencial de base 2 já leva ~5 ms em 20 bytes e ~80 ms em
  // 24; começar mais alto faria o primeiro degrau custar segundos.
  minSize: 12,
  maxSize: 4096,
  // A escada tem dois passos. Até `fineUntil` bytes ela sobe de 10% em 10%: é onde um
  // padrão exponencial se revela, e cada degrau custa no máximo ~5x o anterior (um
  // passo grande faria o degrau em que ele estoura custar minutos). Dali em diante
  // sobe de `step` em `step`, porque o que sobrou é polinomial ou um exponencial tão
  // brando que também só cresce poucas vezes por degrau. Depois de um degrau suspeito
  // volta ao passo fino, para o degrau de confirmação não custar o salto inteiro.
  fineStep: 1.1,
  fineUntil: 192,
  step: 1.5,
  budgetMs: 250,
  floorMs: 0.5,
  // 3 desde a onda 2. Era 5, e o padrão cúbico de ssh+shell passava (a 4 KB levava 0,6 s,
  // que o orçamento pegaria, mas só se a família certa existisse): polinômio de grau 2
  // mede ~2,1 (o pior padrão legítimo do template) e o cúbico mede 3 ou mais, então o corte
  // em 3 separa os dois. Um padrão de grau 4 em diante cresce mais depressa que isto.
  maxDegree: 3,
  strikes: 2,
});

// Unidades genéricas: o que quase todo quantificador de padrão de shell repete.
const GENERIC_UNITS = [
  "a", "x ", "-", "/", ".", "0", "_", "=", "\"", "'", "\\", " ", "\t", "  ",
  "-a ", "-rf ", "-r ", "a.sh ", "./x ", "--x ", "-p 22 ", "ab",
];

// Entre dois degraus o tamanho cresce ao menos isto, para a escada sempre avançar.
const MIN_STEP_BYTES = 4;

// As famílias de duas palavras combinam as PAIR_WORDS primeiras palavras do padrão, e as de quatro
// tokens separam as duas por fichas de uma letra que não são palavra de ninguém.
const PAIR_WORDS = 6;
const PAIR_FILLERS = ["h", "a"];

// A partir deste tamanho, uma família cujo custo projetado em maxSize (no expoente de corte)
// fica abaixo do orçamento deixa de subir a escada. Abaixo de 1 KB nada é cortado.
const SETTLE_FROM = 1024;

// Escapes de classe e de borda (\s \S \w \b \d ...): não são texto literal.
const ESCAPE = /\\[a-zA-Z]/g;

/**
 * As palavras literais do padrão (docker, ssh, remove-item, prod...): o que as
 * famílias usam para fazer o começo do padrão casar e o laço repetir.
 * @param {string} source
 * @returns {string[]}
 */
export function patternWords(source) {
  const words = String(source ?? "").replace(ESCAPE, " ").match(/[A-Za-z][A-Za-z-]{1,}/g) ?? [];
  return [...new Set(words.map((w) => w.toLowerCase()))].slice(0, 10);
}

// Os caracteres literais soltos do padrão (o `x` e o `y` de (x+x+)+y): cada um
// repetido é a entrada que faz um laço sobre esse caractere degenerar.
function patternChars(source) {
  const chars = String(source ?? "").replace(ESCAPE, " ").match(/[A-Za-z0-9]/g) ?? [];
  return [...new Set(chars.map((c) => c.toLowerCase()))].slice(0, 8);
}

/**
 * As famílias de entradas adversárias de um padrão: `{label, build(size)}`, com
 * `build` devolvendo uma string de ~`size` caracteres. Cada família é
 * prefixo + unidade repetida + sufixo; o sufixo "!" faz falhar um padrão que, sem
 * ele, casaria no fim da entrada e nunca voltaria atrás.
 * @param {string} source
 * @returns {Array<{label: string, build: (size: number) => string}>}
 */
export function adversarialFamilies(source) {
  const words = patternWords(source);
  const prefixes = ["", ...words.map((w) => `${w} `)];
  const units = [...new Set([...GENERIC_UNITS, ...patternChars(source), ...words.map((w) => `${w} `)])];
  const families = [];
  const add = (prefix, unit, suffix) => {
    families.push({
      label: `${JSON.stringify(prefix)} + ${JSON.stringify(unit)} repetida${suffix ? ` + ${JSON.stringify(suffix)}` : ""}`,
      build: (size) => {
        const room = Math.max(0, size - prefix.length);
        return prefix + unit.repeat(Math.ceil(room / unit.length)).slice(0, room) + suffix;
      },
    });
  };
  for (const prefix of prefixes) {
    for (const unit of units) {
      for (const suffix of ["", "!"]) add(prefix, unit, suffix);
    }
  }
  // Famílias de DUAS palavras do padrão ("ssh sh " repetido, "ssh h sh a "): o padrão de ssh+shell
  // tinha três escolhas livres (qual `ssh`, qual shell, onde para o `[^|;&]*`) e só degenerava
  // quando as duas palavras se alternavam — "ssh ssh ssh" ou "sh sh sh" sozinhos o deixavam em ms.
  // Só com prefixo vazio e só as PAIR_WORDS primeiras palavras, para o custo não multiplicar.
  const head = words.slice(0, PAIR_WORDS);
  for (const first of head) {
    for (const second of head) {
      for (const unit of [`${first} ${second} `, `${first} ${PAIR_FILLERS[0]} ${second} ${PAIR_FILLERS[1]} `]) {
        for (const suffix of ["", "!"]) add("", unit, suffix);
      }
    }
  }
  return families;
}

function defaultTimeOnce(re, text) {
  const start = performance.now();
  re.test(text);
  return performance.now() - start;
}

// O menor de `runs` tempos: o ruído (GC, escalonador) só soma. Uma medição lenta
// não é repetida — já passou do que importa.
function bestOf(timeOnce, re, text, runs) {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const ms = timeOnce(re, text);
    if (ms < best) best = ms;
    if (best > 20) break;
  }
  return best;
}

/**
 * Mede o crescimento do tempo de um padrão. Devolve
 *  - `{ok: true, skipped: "..."}` quando o padrão não compila (quem o nomeia é o
 *    checkTierRules do doctor; aqui não há o que medir);
 *  - `{ok: true, worstMs, worstSize, worstLabel}` quando nenhuma família estoura;
 *  - `{ok: false, reason: "budget"|"growth", ms, size, label, previousMs}` na
 *    primeira família que estoura o orçamento (`budget`) ou cujo expoente local
 *    passa de `maxDegree` em `strikes` degraus seguidos (`growth`).
 *
 * Uma medição acima do orçamento é refeita UMA vez antes de reprovar (A4): um tropeço de GC
 * ou do escalonador, que uma máquina carregada tem de sobra, não reprova um padrão bom. Vale o
 * menor dos dois tempos.
 *
 * @param {string} source o padrão, como está no tier-rules.json
 * @param {{flags?: string, minSize?: number, maxSize?: number, fineStep?: number, fineUntil?: number, step?: number, budgetMs?: number, floorMs?: number, maxDegree?: number, strikes?: number, timeOnce?: (re: RegExp, text: string) => number}} [options]
 *   `timeOnce` é o relógio (uma medição, em ms); só os testes o trocam.
 */
export function probePattern(source, options = {}) {
  const { flags, minSize, maxSize, fineStep, fineUntil, step, budgetMs, floorMs, maxDegree, strikes, timeOnce = defaultTimeOnce } = {
    ...PROBE_DEFAULTS,
    ...options,
  };
  let re;
  try {
    re = new RegExp(source, flags);
  } catch (e) {
    return { ok: true, skipped: `não compila: ${e?.message ?? e}` };
  }
  re.test(""); // aquece: a compilação lazy do V8 não conta como crescimento

  let worst = { ms: 0, size: 0, label: "" };
  for (const family of adversarialFamilies(source)) {
    let previousMs = 0;
    let previousSize = 0;
    let streak = 0;
    let size = minSize;
    for (;;) {
      const text = family.build(size);
      let ms = bestOf(timeOnce, re, text, 2);
      if (ms > budgetMs) {
        // A4: confirma uma vez antes de reprovar. O padrão realmente lento repete o tempo; o pico
        // de uma máquina carregada não.
        ms = Math.min(ms, bestOf(timeOnce, re, text, 2));
        if (ms > budgetMs) {
          return { ok: false, reason: "budget", ms, size: text.length, label: family.label, previousMs };
        }
      }
      // `ms > previousMs * (size / previousSize) ** maxDegree` é o expoente local acima de maxDegree.
      const suspect = ms >= floorMs && previousMs > 0 && ms > previousMs * (size / previousSize) ** maxDegree;
      if (suspect) {
        // Confirma a medição antes de contá-la: um tropeço de GC vira um degrau enorme.
        ms = bestOf(timeOnce, re, text, 3);
        const before = bestOf(timeOnce, re, family.build(previousSize), 3);
        if (ms >= floorMs && ms > Math.max(before, 0.02) * (size / previousSize) ** maxDegree) {
          streak += 1;
          if (streak >= strikes) {
            return { ok: false, reason: "growth", ms, size: text.length, label: family.label, previousMs: before };
          }
        } else {
          streak = 0;
        }
      } else {
        streak = 0;
      }
      if (ms > worst.ms) worst = { ms, size: text.length, label: family.label };
      previousMs = ms;
      previousSize = size;
      if (size >= maxSize) break;
      // A família não tem como estourar o orçamento em maxSize nem crescendo no expoente de corte:
      // os degraus grandes são os caros (um quadrático de 4 KB leva ~10 ms por medição, em
      // centenas de famílias), e só os que ainda têm chance valem a pena. Só a partir de SETTLE_FROM,
      // para o expoente já ter tido degraus medidos acima do ruído.
      if (size >= SETTLE_FROM && streak === 0 && ms * (maxSize / size) ** maxDegree < budgetMs) break;
      const factor = streak > 0 || size < fineUntil ? Math.min(fineStep, step) : step;
      size = Math.min(maxSize, Math.max(size + MIN_STEP_BYTES, Math.ceil(size * factor)));
    }
  }
  return { ok: true, worstMs: worst.ms, worstSize: worst.size, worstLabel: worst.label };
}
