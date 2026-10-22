import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

// O módulo é um script clássico (o protótipo abre direto do disco, onde ES modules não carregam): o teste o lê
// pelo require, como fará o app Expo.
const R = createRequire(import.meta.url)("../prototipo/regras.js");

describe("média pelo tanque cheio", () => {
  const anterior = { km: 10000, cheio: true };
  it("km rodados ÷ litros quando os dois abastecimentos completaram o tanque", () => {
    expect(R.mediaKmL({ km: 10500, litros: 40, cheio: true }, anterior)).toBe(12.5);
  });
  it("sem média se um dos dois não completou o tanque", () => {
    expect(R.mediaKmL({ km: 10500, litros: 40, cheio: false }, anterior)).toBeNull();
    expect(R.mediaKmL({ km: 10500, litros: 40, cheio: true }, { km: 10000, cheio: false })).toBeNull();
  });
  it("sem média sem abastecimento anterior, sem litros ou com km que não avançou", () => {
    expect(R.mediaKmL({ km: 10500, litros: 40, cheio: true }, null)).toBeNull();
    expect(R.mediaKmL({ km: 10500, litros: null, cheio: true }, anterior)).toBeNull();
    expect(R.mediaKmL({ km: 10000, litros: 40, cheio: true }, anterior)).toBeNull();
    expect(R.mediaKmL({ km: NaN, litros: 40, cheio: true }, anterior)).toBeNull();
  });
});

describe("avaliação no abastecimento seguinte", () => {
  const abastecimentos = [
    { id: "a1", veiculoId: "v1", km: 1000 },
    { id: "a2", veiculoId: "v1", km: 1500 },
    { id: "b1", veiculoId: "v2", km: 9000 },
  ];
  it("o último abastecimento do veículo (maior km) é o que espera a nota", () => {
    expect(R.ultimoAbastecimento(abastecimentos, "v1").id).toBe("a2");
    expect(R.ultimoAbastecimento(abastecimentos, "v3")).toBeNull();
  });
  it("o primeiro abastecimento não tem avaliação; a partir do segundo a nota é obrigatória", () => {
    expect(R.precisaAvaliar(null)).toBe(false);
    expect(R.precisaAvaliar(abastecimentos[1])).toBe(true);
  });
  it("nota de 1 a 5 em meias estrelas", () => {
    for (const n of [1, 1.5, 3.5, 5]) expect(R.notaValida(n)).toBe(true);
    for (const n of [0, 0.5, 4.3, 5.5, NaN, "4", undefined]) expect(R.notaValida(n)).toBe(false);
  });
});

describe("cadastro e login", () => {
  it("CPF pelos dígitos verificadores", () => {
    expect(R.cpfValido("529.982.247-25")).toBe(true);
    expect(R.cpfValido("52998224725")).toBe(true);
    expect(R.cpfValido("529.982.247-24")).toBe(false);
    expect(R.cpfValido("111.111.111-11")).toBe(false);
    expect(R.cpfValido("123")).toBe(false);
  });
  it("WhatsApp = DDD + celular: 11 dígitos, com o 9 depois do DDD", () => {
    expect(R.whatsValido("(11) 98765-4321")).toBe(true);
    expect(R.whatsValido("(11) 3876-5432")).toBe(false);
    expect(R.whatsValido("11 88765-4321")).toBe(false);
  });
  it("senha com pelo menos 8 caracteres, letras e números, e a confirmação igual", () => {
    expect(R.senhaErro("abc12345", "abc12345")).toBe("");
    expect(R.senhaErro("abc1234", "abc1234")).toMatch(/8 caracteres/);
    expect(R.senhaErro("abcdefgh", "abcdefgh")).toMatch(/letras e números/);
    expect(R.senhaErro("12345678", "12345678")).toMatch(/letras e números/);
    expect(R.senhaErro("abc12345", "abc12346")).toBe("As senhas não conferem.");
  });
});

describe("reputação do posto", () => {
  const itens = [
    { id: "1", postoId: "p1", estrelas: 5, kmL: 12, comb: "Etanol", preco: 4.29, data: "2026-10-01T10:00:00Z" },
    { id: "2", postoId: "p2", estrelas: 1, data: "2026-10-02T10:00:00Z" },
    { id: "3", postoId: "p1", estrelas: 4, comb: "Etanol", preco: 4.19, data: "2026-10-05T10:00:00Z" },
    { id: "4", postoId: "p1", comb: "Gasolina comum", preco: 6.1, data: "2026-09-01T10:00:00Z" },
  ];
  it("agrupa as avaliações por posto mantendo a ordem", () => {
    const g = R.agruparPorPosto(itens);
    expect(g.get("p1").map(i => i.id)).toEqual(["1", "3", "4"]);
    expect(g.get("p2").map(i => i.id)).toEqual(["2"]);
  });
  it("média só das avaliações com nota, último preço por combustível e km/l relatados", () => {
    const st = R.statsDoPosto(R.agruparPorPosto(itens).get("p1"));
    expect(st.n).toBe(2);
    expect(st.media).toBe(4.5);
    expect(st.kml).toHaveLength(1);
    expect(st.precos).toEqual({
      Etanol: { preco: 4.19, data: "2026-10-05T10:00:00Z" },
      "Gasolina comum": { preco: 6.1, data: "2026-09-01T10:00:00Z" },
    });
  });
  it("cor do marcador pelos limites dos alertas da Garagem", () => {
    const cfg = { baixo: 2.5, alto: 4.2, min: 2 };
    expect(R.reputacao({ n: 0, media: null }, cfg)).toEqual({ cls: "none", motivo: "sem-nota" });
    expect(R.reputacao({ n: 1, media: 5 }, cfg)).toEqual({ cls: "mid", motivo: "poucas" });
    expect(R.reputacao({ n: 3, media: 2.5 }, cfg)).toEqual({ cls: "bad", motivo: "ruim" });
    expect(R.reputacao({ n: 3, media: 4.2 }, cfg)).toEqual({ cls: "good", motivo: "boa" });
    expect(R.reputacao({ n: 3, media: 3.5 }, cfg)).toEqual({ cls: "mid", motivo: "regular" });
  });
});

describe("distância", () => {
  it("1 grau de latitude dá uns 111,2 km", () => {
    expect(R.distM([-23, -46], [-22, -46])).toBeCloseTo(111195, -1);
  });
  it("o mesmo ponto dá 0", () => {
    expect(R.distM([-23.5, -46.6], [-23.5, -46.6])).toBe(0);
  });
});

describe("sincronização com o banco", () => {
  const linha = (id, t) => ({ id, atualizado_em: t });
  it("junta linhas novas ou mais recentes e ignora as que voltam repetidas na janela", () => {
    const m = new Map([["a", linha("a", "2026-10-22T10:00:00+00:00")]]);
    expect(R.mesclarLinhas(m, [linha("a", "2026-10-22T10:00:00+00:00")], [], "postos")).toBe(0);
    expect(R.mesclarLinhas(m, [linha("a", "2026-10-22T10:05:00+00:00"), linha("b", "2026-10-22T10:06:00+00:00")], [], "postos")).toBe(2);
    expect([...m.keys()]).toEqual(["a", "b"]);
  });
  it("tira as apagadas da própria tabela, mas não uma linha regravada depois de apagada", () => {
    const m = new Map([["a", linha("a", "2026-10-22T10:00:00+00:00")], ["b", linha("b", "2026-10-22T10:10:00+00:00")]]);
    const apagados = [
      { tabela: "avaliacoes", registro: "a", apagado_em: "2026-10-22T10:01:00+00:00" },
      { tabela: "avaliacoes", registro: "b", apagado_em: "2026-10-22T10:05:00+00:00" },
      { tabela: "postos", registro: "b", apagado_em: "2026-10-22T10:30:00+00:00" },
    ];
    expect(R.mesclarLinhas(m, [], apagados, "avaliacoes")).toBe(1);
    expect([...m.keys()]).toEqual(["b"]);
  });
  it("a próxima busca começa da maior data de mudança vista", () => {
    expect(R.ultimaMudanca(
      [linha("a", "2026-10-22T10:00:00.5+00:00"), linha("b", "2026-10-22T09:00:00+00:00")],
      [{ apagado_em: "2026-10-22T10:00:00.25+00:00" }], null)).toBe("2026-10-22T10:00:00.5+00:00");
    expect(R.ultimaMudanca([], [], "2026-10-22T08:00:00+00:00")).toBe("2026-10-22T08:00:00+00:00");
    expect(R.ultimaMudanca([{ id: "sem data" }], [], null)).toBeNull();
  });
  it("monta postos, avaliações por usuário (em ordem de data) e suspeitas por posto", () => {
    const r = R.montarRede({
      postos: new Map([["p1", { id: "p1", nome: "Posto", cnpj: null, criado_por: "u1", criado_em: "2026-09-01T10:00:00+00:00" }]]),
      aval: new Map([
        ["a2", { id: "a2", user_id: "u1", nome: "Ana", posto_id: "p1", preco: "4.19", km_l: null, estrelas: "4.5", data: "2026-10-05T10:00:00+00:00" }],
        ["a1", { id: "a1", user_id: "u1", nome: "Ana Maria", posto_id: "p1", preco: null, km_l: "12.5", estrelas: null, data: "2026-10-01T10:00:00+00:00" }],
      ]),
      susp: new Map([["s1", { id: "s1", user_id: "u2", nome: "Beto", posto_id: "p1", abastecimento_id: "ab-1", categoria: "Outro", motivo: "Bomba marcou mais", criado_em: "2026-10-03T10:00:00+00:00" }]]),
    });
    expect(r.postos.p1).toMatchObject({ nome: "Posto", criadoPor: "u1" });
    expect(r.postos.p1.cnpj).toBeUndefined();
    expect(r.pub.u1.map(i => i.id)).toEqual(["a1", "a2"]);
    expect(r.pub.u1[0]).toMatchObject({ kmL: 12.5, preco: null });
    expect(r.pub.u1[0].estrelas).toBeUndefined();
    expect(r.pub.u1[1]).toMatchObject({ preco: 4.19, estrelas: 4.5, kmL: null });
    expect(r.pubNome.u1).toBe("Ana");
    expect(r.susp.p1[0]).toMatchObject({ uid: "u2", abastId: "ab-1", data: "2026-10-03T10:00:00+00:00" });
  });
});
