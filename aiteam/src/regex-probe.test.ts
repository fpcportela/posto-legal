import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adversarialFamilies, patternWords, PROBE_DEFAULTS, probePattern } from "./regex-probe.mjs";

// O padrão de ssh que a canônica tinha até 2026-10-06: `(\s+\S+)?` também casa o
// próximo `-a`, então `-a -a -a` tem um número exponencial de formas de ser lido.
// `ssh` + 36 flags (111 bytes) leva ~1 s; o hook estoura o timeout e, como o
// timeout de um hook é falha aberta, o comando passa. Guardado em fixture como
// controle negativo: a sondagem tem de reconhecê-lo.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OLD_SSH_PATTERN: string = JSON.parse(readFileSync(path.join(HERE, "__fixtures__", "legacy-tier-patterns.json"), "utf8")).sshScriptByPath;

describe("patternWords", () => {
  it("tira as palavras literais, sem os escapes de classe (\\s, \\b, \\S, \\w)", () => {
    expect(patternWords(OLD_SSH_PATTERN)).toEqual(["ssh", "sh", "bash"]);
    expect(patternWords("\\b(remove-item|rm|ri)\\b(?=.*\\s-r(e(c)?)?\\b)")).toEqual(["remove-item", "rm", "ri"]);
  });

  it("devolve lista vazia para um padrão sem palavra", () => {
    expect(patternWords("\\s+\\d*")).toEqual([]);
  });
});

describe("adversarialFamilies", () => {
  it("gera famílias com o tamanho pedido e o sufixo que força a falha", () => {
    const families = adversarialFamilies("\\bssh\\b.*docker");
    expect(families.length).toBeGreaterThan(20);
    const f = families.find((x) => x.label === '"ssh " + "-a " repetida + "!"');
    expect(f).toBeDefined();
    const text = f!.build(40);
    expect(text.startsWith("ssh -a -a")).toBe(true);
    expect(text.endsWith("!")).toBe(true);
    expect(text.length).toBeGreaterThanOrEqual(40);
    expect(text.length).toBeLessThanOrEqual(41);
  });
});

describe("probePattern", () => {
  it("reprova o padrão de ssh antigo (crescimento exponencial) sem pendurar", () => {
    const started = Date.now();
    const r = probePattern(OLD_SSH_PATTERN);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(["growth", "budget"]).toContain(r.reason);
      expect(r.size).toBeLessThan(400); // pegou cedo, longe dos 4 KB
    }
    // O corte vale também para a escada: a sondagem de um padrão exponencial não
    // pode custar mais que uns segundos.
    expect(Date.now() - started).toBeLessThan(8000);
  });

  // O custo da sondagem é limitado pela escada, não pelo padrão: um exponencial de
  // base 2 custa 2^n passos, e um passo de tamanho grande faria o degrau em que ele
  // estoura levar minutos.
  it("um exponencial de base 2 é reprovado em poucos ms, não em minutos", () => {
    const started = performance.now();
    const r = probePattern("^(a+)+$");
    expect(r.ok).toBe(false);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it.each([
    ["alternância sobreposta", "^(a|a)*$"],
    ["quantificador aninhado clássico", "^(a+)+$"],
    ["repetição que se sobrepõe", "(x+x+)+y"],
    ["grupo opcional que repete o delimitador", "^(\\s*\\w+\\s*)*$"],
  ])("reprova %s", (_what, source) => {
    const r = probePattern(source, { maxSize: 512 });
    expect(r.ok).toBe(false);
  });

  it.each([
    ["literal", "\\bgit\\s+push\\b"],
    ["quadrático, mas limitado (.* depois de \\s+)", "vercel\\s+.*--prod\\b"],
    ["o ssh novo, sem ambiguidade", "\\bssh\\b(?:\\s+-\\w+(?:\\s+(?!-\\w+(?=\\s|$))\\S+)?)*\\s+\\S+\\s+[\"']?[~./]\\S*\\.(?:sh|bash)\\b"],
    ["laço sem ambiguidade (cada volta começa em um delimitador)", "(?:\\s+\\S+)*\\s+deploy\\b"],
  ])("aprova %s", (_what, source) => {
    const r = probePattern(source, { maxSize: 1024 });
    expect(r).toMatchObject({ ok: true });
    expect("skipped" in r).toBe(false);
  });

  it("o padrão que não compila não é medido: quem o nomeia é o checkTierRules", () => {
    const r = probePattern("(unclosed");
    expect(r).toMatchObject({ ok: true });
    expect("skipped" in r && r.skipped).toMatch(/não compila/);
  });

  it("respeita o orçamento: um limite de 0 ms reprova qualquer padrão que gaste tempo", () => {
    const r = probePattern("vercel\\s+.*--prod\\b", { budgetMs: 0 });
    expect(r).toMatchObject({ ok: false, reason: "budget" });
  });
});

// Onda 2, item 4 (A4). A sondagem só repetia UMA palavra do padrão ("ssh ssh ssh"), e o expoente
// de corte era 5: o padrão cúbico de ssh+shell passou por ela (levava 0,6 s a 4 KB com "ssh sh "
// repetido, que mistura DUAS palavras do padrão), e um pico de GC numa medição podia reprovar um
// padrão bom por orçamento.
const OLD_CUBIC: string = JSON.parse(readFileSync(path.join(HERE, "__fixtures__", "legacy-tier-patterns.json"), "utf8")).sshShellScriptCubic;

describe("sondagem — famílias de duas palavras", () => {
  it("o padrão de ssh+shell tem a família `ssh sh ` e a de quatro tokens `ssh h sh a `", () => {
    const labels = adversarialFamilies(OLD_CUBIC).map((f) => f.label);
    expect(labels).toContain('"" + "ssh sh " repetida');
    expect(labels).toContain('"" + "ssh sh " repetida + "!"');
    expect(labels).toContain('"" + "ssh h sh a " repetida + "!"');
  });

  it("a família repete as duas palavras no tamanho pedido", () => {
    const f = adversarialFamilies(OLD_CUBIC).find((x) => x.label === '"" + "ssh sh " repetida + "!"')!;
    const text = f.build(30);
    expect(text.startsWith("ssh sh ssh sh ssh sh")).toBe(true);
    expect(text.endsWith("!")).toBe(true);
  });

  it("o custo das famílias é limitado: um padrão com muitas palavras não explode o número delas", () => {
    const many = adversarialFamilies("\\b(aa|bb|cc|dd|ee|ff|gg|hh|ii|jj|kk|ll)\\b");
    expect(many.length).toBeLessThan(1_500);
  });

  it("um padrão sem palavras não ganha famílias de palavras", () => {
    const labels = adversarialFamilies("\\s+\\d*").map((f) => f.label);
    expect(labels.some((l) => /"[a-z]{2,} [a-z]+ /.test(l))).toBe(false);
    // O controle: com palavras, a mesma checagem enxerga a família de duas palavras.
    expect(adversarialFamilies("\\b(ssh|bash)\\b").map((f) => f.label).some((l) => /"[a-z]{2,} [a-z]+ /.test(l))).toBe(true);
  });
});

describe("sondagem — o expoente de corte é 3", () => {
  it("o padrão da sondagem: maxDegree 3", () => {
    expect(PROBE_DEFAULTS.maxDegree).toBe(3);
  });

  it("reprova o padrão cúbico de ssh+shell com as opções do doctor, sem pendurar", () => {
    const started = Date.now();
    const r = probePattern(OLD_CUBIC, { maxSize: 4096, budgetMs: 150 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(["growth", "budget"]).toContain(r.reason);
      expect(r.size).toBeLessThanOrEqual(4100);
    }
    // O corte vale para a escada: a sondagem de um cúbico custa uns segundos, não minutos.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("e reprova também com as opções padrão (o teste do template, 4 KB e 250 ms)", () => {
    expect(probePattern(OLD_CUBIC).ok).toBe(false);
  });

  it("um cúbico sintético (três blocos que disputam o mesmo texto) reprova", () => {
    expect(probePattern("a+a+a+b", { maxSize: 4096, budgetMs: 150 }).ok).toBe(false);
  });

  it("o quadrático segue passando: o corte em 3 não o confunde com crescimento ruim", () => {
    expect(probePattern("\\bssh\\b.*\\b(docker|systemctl|service|kubectl)\\b", { maxSize: 4096, budgetMs: 150 })).toMatchObject({ ok: true });
    expect(probePattern("vercel\\s+.*--prod\\b", { maxSize: 4096, budgetMs: 150 })).toMatchObject({ ok: true });
  });
});

// A4: um tropeço (GC, escalonador, máquina carregada) numa medição acima do orçamento reprovava
// um padrão bom. A medição é refeita UMA vez antes de reportar `budget`.
describe("sondagem — o orçamento confirma a medição antes de reprovar (A4)", () => {
  it("uma medição acima do orçamento que a repetição desmente não reprova", () => {
    let calls = 0;
    // A primeira medição de todas é um pico; as outras custam quase nada.
    const timeOnce = (): number => (++calls === 1 ? 1_000 : 0.01);
    const r = probePattern("\\bgit\\s+push\\b", { budgetMs: 250, timeOnce });
    expect(r).toMatchObject({ ok: true });
    expect(calls).toBeGreaterThan(2);
  });

  it("uma medição que a repetição confirma reprova por orçamento, citando a repetição", () => {
    let calls = 0;
    const timeOnce = (): number => (++calls <= 2 ? 1_000 : 0.01);
    const r = probePattern("\\bgit\\s+push\\b", { budgetMs: 250, timeOnce });
    expect(r).toMatchObject({ ok: false, reason: "budget" });
    // A confirmação mede de novo antes de reportar: foi mais de uma medição.
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("o padrão de verdade que estoura o orçamento continua reprovando", () => {
    expect(probePattern("vercel\\s+.*--prod\\b", { budgetMs: 0 })).toMatchObject({ ok: false, reason: "budget" });
  });
});

// Com as famílias de duas palavras a sondagem tem centenas de famílias a mais, e os degraus de 2 a
// 4 KB de um quadrático custam ~10 ms cada medição: 9 s para o mapa canônico, perto do teto de 10 s
// do filho do doctor. Uma família que não tem como estourar o orçamento em maxSize, nem crescendo no
// expoente de corte, deixa de subir a partir de 1 KB.
describe("sondagem — a escada para quando a família não tem como estourar", () => {
  it("uma família barata não sobe até maxSize", () => {
    const sizes: number[] = [];
    const timeOnce = (_re: RegExp, text: string): number => {
      sizes.push(text.length);
      return 0.02;
    };
    expect(probePattern("\\bgit\\s+push\\b", { maxSize: 4096, budgetMs: 150, timeOnce })).toMatchObject({ ok: true });
    expect(Math.max(...sizes)).toBeGreaterThanOrEqual(1024);
    expect(Math.max(...sizes)).toBeLessThan(2200);
  });

  it("abaixo de 1 KB nada é cortado: a escada fina até 192 e os degraus seguintes são medidos", () => {
    const sizes = new Set<number>();
    const timeOnce = (_re: RegExp, text: string): number => {
      sizes.add(text.length);
      return 0;
    };
    probePattern("\\bgit\\s+push\\b", { maxSize: 4096, budgetMs: 150, timeOnce });
    expect([...sizes].filter((s) => s < 1024).length).toBeGreaterThan(20);
  });

  it("uma família que cresce no expoente de corte sobe até onde estoura e reprova", () => {
    // 20 ms a 1 KB e cúbico: projetado em 4 KB passa muito do orçamento, então não é cortada.
    const timeOnce = (_re: RegExp, text: string): number => 20 * (text.length / 1024) ** 3;
    const r = probePattern("x", { maxSize: 4096, budgetMs: 150, timeOnce });
    expect(r).toMatchObject({ ok: false, reason: "budget" });
    if (!r.ok) expect(r.size).toBeGreaterThan(1024);
  });

  it("maxSize abaixo de 1 KB (a escada curta do doctor antigo) não corta nada", () => {
    const sizes: number[] = [];
    const timeOnce = (_re: RegExp, text: string): number => {
      sizes.push(text.length);
      return 0;
    };
    probePattern("\\bgit\\s+push\\b", { maxSize: 512, timeOnce });
    expect(Math.max(...sizes)).toBeGreaterThanOrEqual(512);
  });
});
