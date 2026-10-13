// Dá lat/lng aos postos da ANP que o OpenStreetMap não cobriu, usando os endereços do CNEFE (Censo 2022, IBGE).
// Uso: node dados/geocodificar-cnefe.mjs [--validar]  (leva ~2 min; lê os 27 extratos do cache)
// Entradas: dados/postos-anp-geo.csv (saída de geocodificar-osm.mjs), cadastro bruto da ANP (rua/número separados)
// e os extratos por UF de baixar-cnefe.mjs (~/.cache/posto-legal/cnefe/<UF>.tsv.gz). Saída: o próprio postos-anp-geo.csv
// com lat/lng/geo_fonte/geo_score preenchidos e a coluna geo_precisao ("ponto" ou "rua").
// Linhas do OSM ficam intactas. Métodos (cada um com admissão mínima; ver decide()):
//   cnefe_endereco  mesma rua + número no CEP/município (ou CEP+número com rua parecida)            -> ponto
//   cnefe_estab     ponto de posto do CNEFE com rua/número/nome/bairro compatíveis, ou o único do município -> ponto
//   cnefe_interp    número ausente: interpola entre os vizinhos da mesma rua (mesma paridade)       -> ponto
//   cnefe_cep       centroide dos endereços do CEP da rua (todos a <= 300 m)                         -> rua
// Para entrar, o ponto precisa ser "confirmado" (posto do CNEFE a < 70 m) ou ter outro método a <= 100 m;
// métodos que discordam (> 150 m) anulam o posto. geo_score = % aproximado de acertos (<150 m) medido na validação.
// Ordem do pipeline: extrair-postos-anp -> geocodificar-osm -> baixar-cnefe -> geocodificar-cnefe (reexecutável).
// --validar: refaz o casamento às cegas nos postos que já têm coordenada do OSM e mede a distância OSM x CNEFE
// (+ --features, --piores, --diagnostico: detalhes por tipo de casamento, piores casos, motivos dos sem coordenada).
import { createReadStream, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { CACHE, DIR, UFS, campo, digitos, lerAnpBruto, norm, parseCsv, ruaChave } from "./cnefe-comum.mjs";

const VALIDAR = process.argv.includes("--validar"), DIAG = process.argv.includes("--diagnostico");
const CEP_RAIO = 300; // m: todos os endereços do CEP têm de ficar a menos disso do centroide

// ---------- geografia ----------
const dist = (a, b) => { const dy = (a[0] - b[0]) * 111320, dx = (a[1] - b[1]) * 111320 * Math.cos(a[0] * Math.PI / 180); return Math.hypot(dx, dy); };
const mediana = (v) => { const s = [...v].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const centro = (pts) => [mediana(pts.map((p) => p[0])), mediana(pts.map((p) => p[1]))];

// ---------- nome ----------
const STOP = new Set(("LTDA ME EPP EIRELI SA S A COMERCIO COMERCIAL COMBUSTIVEIS COMBUSTIVEL DERIVADOS PETROLEO LUBRIFICANTES AUTO POSTO POSTOS SERVICO SERVICOS " +
  "DE DA DO DAS DOS E EM CIA IND INDUSTRIA TRANSPORTES TRANSPORTE DISTRIBUIDORA REDE GRUPO EMPRESA PNEUS LAVA JATO GNV GAS GASOLINA ETANOL DIESEL " +
  "CONVENIENCIA LOJA CENTER MINI MERCADO RESTAURANTE HOTEL PARADA TRUCK ACUCAR ALCOOL GERAL REPRESENTACOES PARTICIPACOES NEGOCIOS ADMINISTRACAO ENERGIA " +
  "PETROBRAS VIBRA SHELL RAIZEN IPIRANGA TEXACO ESSO BR ALE ALESAT BRANCA BANDEIRA").split(" "));
const tokNome = (t) => [...new Set(norm(t).split(" ").filter((x) => x.length > 1 && !STOP.has(x) && !/^\d+$/.test(x)))];
const lev1 = (a, b) => { // distância de edição <= 1
  if (a === b) return true; if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; while (i < a.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
};

// ---------- carga dos postos ----------
const bruto = lerAnpBruto();
const tab = parseCsv(readFileSync(join(DIR, "postos-anp-geo.csv"), "utf8"));
const COLS = tab[0].filter((c) => c !== "geo_precisao");
const C = Object.fromEntries(COLS.map((n) => [n, tab[0].indexOf(n)]));
const postos = tab.slice(1).map((r, i) => {
  const row = COLS.map((n) => r[C[n]] ?? "");
  const b = bruto.get(row[C.cnpj] + "|" + row[C.endereco]) || { rua: "", num: null, bairro: "", cepd: "" };
  const fonte = row[C.geo_fonte];
  if (fonte.startsWith("cnefe")) for (const n of ["lat", "lng", "geo_fonte", "geo_score"]) row[C[n]] = ""; // refaz tudo que foi do CNEFE
  const p = { i, row, uf: row[C.uf], mun: norm(row[C.municipio]), cepd: digitos(row[C.cep]), rua: b.rua, key: ruaChave(b.rua), num: b.num, bairro: b.bairro, tk: tokNome(row[C.nome]) };
  p.osm = row[C.geo_fonte] === "osm" ? [+row[C.lat], +row[C.lng]] : null;
  p.cepEsp = p.cepd.length === 8 && !p.cepd.endsWith("000");
  return p;
});
const df = new Map();
for (const p of postos) for (const t of p.tk) df.set(t, (df.get(t) || 0) + 1);
const idf = (t) => Math.log(postos.length / (df.get(t) || 1));

// código IBGE do município por nome (só para quando nenhum CEP do município aparece no extrato)
const codPorNome = new Map();
if (existsSync(join(DIR, "osm-municipios-br.json"))) {
  for (const e of JSON.parse(readFileSync(join(DIR, "osm-municipios-br.json"), "utf8")).elements) {
    const g = e.tags?.["IBGE:GEOCODIGO"]; if (g && e.tags.name) codPorNome.set(norm(e.tags.name) + "|" + UFS[g.slice(0, 2)], g);
  }
}

const cel = (pt) => Math.floor(pt[0] * 500) + "," + Math.floor(pt[1] * 500); // células de ~220 m
// ---------- extrato de uma UF ----------
async function carrega(uf) {
  const arq = join(CACHE, uf + ".tsv.gz");
  if (!existsSync(arq)) return null;
  const rows = [], keyCache = new Map();
  const rl = createInterface({ input: createReadStream(arq).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const l of rl) {
    const f = l.split("\t");
    const txt = f[3] + " " + f[4] + " " + f[5];
    let key = keyCache.get(txt); if (key === undefined) { key = ruaChave(txt); keyCache.set(txt, key); }
    const num = /^\d+$/.test(f[6]) && +f[6] > 0 ? String(+f[6]) : null;
    rows.push({ cep: f[0], mun: f[1], loc: f[2] ? norm(f[2]) : "", key, num, pt: [+f[8], +f[9]], nv: +f[10], esp: f[11], estab: f[12], flag: f[13], rodovia: key?.startsWith("#") });
  }
  const byKey = new Map(), byCep = new Map(), postoRows = [], postoMun = new Map(), grade = new Map();
  for (const r of rows) {
    if (r.key) (byKey.get(r.key) || byKey.set(r.key, []).get(r.key)).push(r);
    if (r.flag.includes("C")) (byCep.get(r.cep) || byCep.set(r.cep, []).get(r.cep)).push(r);
    if (r.flag.includes("P")) { r.tk = tokNome(r.estab); postoRows.push(r); (postoMun.get(r.mun) || postoMun.set(r.mun, []).get(r.mun)).push(r); const g = cel(r.pt); (grade.get(g) || grade.set(g, []).get(g)).push(r); }
  }
  return { rows, byKey, byCep, postoRows, postoMun, grade };
}

// município da ANP -> código IBGE: voto dos CEPs específicos dos postos; senão, nome no OSM
function codigosMun(lista, X) {
  const votos = new Map();
  for (const p of lista) {
    if (!p.cepEsp) continue;
    const rs = X.byCep.get(p.cepd); if (!rs) continue;
    const c = new Map(); for (const r of rs) c.set(r.mun, (c.get(r.mun) || 0) + 1);
    const top = [...c].sort((a, b) => b[1] - a[1])[0][0];
    const v = votos.get(p.mun) || votos.set(p.mun, new Map()).get(p.mun); v.set(top, (v.get(top) || 0) + 1);
  }
  const cod = new Map();
  for (const [m, v] of votos) cod.set(m, [...v].sort((a, b) => b[1] - a[1])[0][0]);
  return (p) => cod.get(p.mun) || codPorNome.get(p.mun + "|" + p.uf) || null;
}

// ---------- casamentos ----------
function agrupa(pts, lim) { // pontos de um mesmo endereço: devolve o ponto se estão juntos (<= lim m do centro)
  const c = centro(pts);
  return pts.every((q) => dist(q, c) <= lim) ? { pt: c, n: pts.length } : null;
}
const tkRua = (k) => (k || "").split(" ").filter((x) => x.length > 1);
const ruaParecida = (a, b) => { // parte dos tokens da rua da ANP aparece na rua do CNEFE (tolera erro de grafia)
  const ta = tkRua(a), tb = tkRua(b); if (!ta.length || !tb.length) return 0;
  const n = ta.filter((x) => tb.some((y) => x === y || (x.length >= 6 && y.length >= 6 && lev1(x, y)))).length;
  return n / Math.max(ta.length, tb.length);
};
function escolhe(cs, p) { // linhas do mesmo número -> um ponto (ou nada, se espalhadas)
  const cepOk = cs.filter((r) => r.cep === p.cepd);
  let nivel = "mun";
  if (cepOk.length) { cs = cepOk; nivel = "cep"; }
  else if (p.bairro) { const bo = cs.filter((r) => r.loc === p.bairro); if (bo.length) { cs = bo; nivel = "bairro"; } }
  const melhor = Math.min(...cs.map((r) => r.nv));
  const top = cs.filter((r) => r.nv === melhor);
  const g = agrupa(top.map((r) => r.pt), 60);
  return g && { pt: g.pt, nv: melhor, nivel, n: g.n, rodovia: top[0].rodovia };
}
// há um posto do CNEFE (e com nome parecido) a menos de 70 m do ponto?
function confirma(m, p, X) {
  const [a, b] = cel(m.pt).split(",").map(Number); let perto = 0, nome = 0;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const r of X.grade.get((a + i) + "," + (b + j)) || []) {
    if (dist(r.pt, m.pt) > 70) continue; perto++;
    if (p.tk.some((t) => r.tk.some((x) => x === t || (t.length >= 6 && x.length >= 6 && lev1(x, t))))) nome++;
  }
  return nome ? "nome" : perto ? "posto" : "";
}
function porEndereco(p, X, cod) {
  if (!p.key) { p.motivo = "sem rua"; return null; }
  if (!p.num) { p.motivo = "sem número (S/N)"; return null; }
  const todos = X.byKey.get(p.key) || [];
  const naMun = todos.filter((r) => (cod ? r.mun === cod : p.cepEsp && r.cep === p.cepd));
  if (!todos.length) p.motivo = "rua não existe no CNEFE";
  else if (!naMun.length) p.motivo = "rua existe só em outro município";
  else if (!naMun.some((r) => r.num === p.num)) p.motivo = "rua existe no município, número não";
  else {
    const e = escolhe(naMun.filter((r) => r.num === p.num), p);
    if (e) return { fonte: "cnefe_endereco", pt: e.pt, sub: `${e.rodovia ? "rodovia" : "rua"}/nv${e.nv}/${e.nivel}/${e.n > 1 ? "multi" : "unico"}` };
    p.motivo = "endereço ambíguo (pontos espalhados)";
  }
  // sem a rua exata: mesmo CEP específico + mesmo número, rua de grafia parecida
  if (p.cepEsp) {
    const cs = (X.byCep.get(p.cepd) || []).filter((r) => r.num === p.num && (!cod || r.mun === cod));
    if (cs.length) {
      const sim = Math.max(...cs.map((r) => ruaParecida(p.key, r.key)));
      const ok = cs.filter((r) => ruaParecida(p.key, r.key) === sim);
      const e = escolhe(ok, p);
      if (e) return { fonte: "cnefe_endereco", pt: e.pt, sub: `cepnum/${sim >= 0.5 ? "rua-parecida" : sim > 0 ? "rua-pouco" : "sem-rua"}/nv${e.nv}` };
    }
  }
  return null;
}
// número ausente no CNEFE: interpola entre os vizinhos mais próximos da mesma rua (mesma paridade)
function porInterp(p, X, cod) {
  if (!p.key || !p.num || p.key[0] === "#" || !cod) return null;
  const n0 = +p.num;
  const rs = (X.byKey.get(p.key) || []).filter((r) => r.mun === cod && r.num && r.num !== p.num && +r.num % 2 === n0 % 2);
  if (!rs.length) return null;
  const cepOk = rs.filter((r) => r.cep === p.cepd), base = cepOk.length ? cepOk : rs;
  const por = new Map(); // número -> pontos
  for (const r of base) (por.get(+r.num) || por.set(+r.num, []).get(+r.num)).push(r);
  let lo = null, hi = null;
  for (const n of por.keys()) { if (n < n0 && (lo === null || n > lo)) lo = n; if (n > n0 && (hi === null || n < hi)) hi = n; }
  if (lo === null || hi === null) return null;
  const A = centro(por.get(lo).map((r) => r.pt)), B = centro(por.get(hi).map((r) => r.pt)), d = dist(A, B);
  if (d > 250) return null;
  const t = (n0 - lo) / (hi - lo);
  return { fonte: "cnefe_interp", pt: [A[0] + t * (B[0] - A[0]), A[1] + t * (B[1] - A[1])], sub: `${cepOk.length ? "cep" : "mun"}/gap${hi - lo <= 20 ? "<=20" : hi - lo <= 60 ? "<=60" : ">60"}/d${d <= 60 ? "<=60" : d <= 120 ? "<=120" : "<=250"}` };
}
function porEstab(p, X, cod) {
  if (!cod && !p.cepEsp) return null;
  const cs = cod ? X.postoMun.get(cod) || [] : X.postoRows.filter((r) => r.cep === p.cepd);
  if (!cs.length) return null;
  const pts = cs.map((r) => {
    let s = 0, det = {};
    if (p.key && r.key === p.key) { s += 3; det.rua = 1; if (p.num && r.num === p.num) { s += 3; det.num = 1; } }
    if (p.cepEsp && r.cep === p.cepd) { s += 1.5; det.cep = 1; }
    if (p.bairro && r.loc === p.bairro) { s += 1; det.bairro = 1; }
    let w = 0; for (const t of p.tk) if (r.tk.some((x) => x === t || (t.length >= 6 && x.length >= 6 && lev1(x, t)))) w += Math.min(idf(t), 9);
    if (w > 0) { s += Math.min(0.6 * w, 4); det.nome = 1; }
    return { r, s, det };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.r.pt[0] - b.r.pt[0]);
  if (!pts.length) return null;
  const b = pts[0];
  // exige rua (e número ou nome), ou nome forte (+ CEP/bairro ou sozinho no município)
  const ok = (b.det.rua && (b.det.num || b.det.nome)) || (b.det.nome && (b.det.cep || b.det.bairro) && b.s >= 4.5) || (b.det.nome && b.s >= 3);
  if (!ok) return null;
  const outros = pts.filter((x) => x !== b && dist(x.r.pt, b.r.pt) > 60);
  if (outros.length && outros[0].s > b.s - 1.5) return null; // empate com outro ponto
  return { fonte: "cnefe_estab", pt: b.r.pt, sub: `${b.det.rua ? "rua" : ""}${b.det.num ? "+num" : ""}${b.det.nome ? "+nome" : ""}${b.det.cep ? "+cep" : ""}${b.det.bairro ? "+bairro" : ""}`.replace(/^\+/, "") };
}
// município com um único posto na ANP e um único ponto de posto no CNEFE (nome e rua não precisam casar)
function porUnico(p, X, cod, nA) {
  if (!cod || nA.get(cod) !== 1) return null;
  const rs = X.postoMun.get(cod) || [];
  if (!rs.length) return null;
  const c = centro(rs.map((r) => r.pt));
  if (!rs.every((r) => dist(r.pt, c) <= 100)) return null; // mais de um posto no município
  return { fonte: "cnefe_estab", pt: c, sub: "unico" };
}
function porCep(p, X, cod) {
  if (!p.cepEsp) return null;
  const rs = (X.byCep.get(p.cepd) || []).filter((r) => !cod || r.mun === cod);
  if (rs.length < 3) return null;
  const g = agrupa(rs.map((r) => r.pt), CEP_RAIO);
  return g ? { fonte: "cnefe_cep", pt: g.pt, sub: `n${rs.length >= 10 ? "10+" : rs.length}` } : null;
}

// ---------- decisão: o que entra e com que precisão/score (calibrado com --validar) ----------
// Cada método tem uma admissão mínima; o resultado só vale se o ponto é "confirmado" (há um posto do CNEFE a
// menos de 70 m) ou se outro método independente cai a até 100 m. Métodos que discordam (> 150 m) anulam tudo.
function admite(m) {
  if (!m) return false;
  if (m.fonte === "cnefe_endereco") {
    const [tipo, nv] = m.sub.split("/");
    return tipo !== "rodovia" && !/^cepnum\/(sem-rua|rua-pouco)/.test(m.sub) && nv !== "nv4" && !m.sub.endsWith("nv4");
  }
  return m.fonte !== "cnefe_cep";
}
const FORTE = /(^|\+)(num|bairro)|^unico$/; // estabelecimento casado por número, bairro ou por ser o único do município
function decide(ms) {
  const [E, T0, I, K, U] = ms, T = T0 || U, pts = [E, T, I].filter(admite);
  for (const x of pts) for (const y of pts) if (x !== y && dist(x.pt, y.pt) > 150) return null; // conflito
  const acordo = (m) => pts.some((o) => o !== m && dist(o.pt, m.pt) <= 100);
  if (admite(E) && (E.conf || acordo(E))) return { m: E, precisao: "ponto", score: acordo(E) && E.conf ? 97 : 93 };
  if (admite(T) && (FORTE.test(T.sub) ? true : acordo(T))) return { m: T, precisao: "ponto", score: acordo(T) ? 94 : 90 };
  if (admite(I) && I.conf) return { m: I, precisao: "ponto", score: acordo(I) ? 92 : 88 };
  if (K && K.conf && !pts.some((o) => dist(o.pt, K.pt) > 300)) return { m: K, precisao: "rua", score: 60 };
  return null;
}

// ---------- execução ----------
const t0 = Date.now();
const porUf = new Map(); for (const p of postos) (porUf.get(p.uf) || porUf.set(p.uf, []).get(p.uf)).push(p);
const val = [], final = []; // {fonte, sub, d}
const cobUf = {}; const faltaUf = []; const motivos = {}, amostra = {};
for (const uf of [...porUf.keys()].sort()) {
  const lista = porUf.get(uf), X = await carrega(uf);
  if (!X) { faltaUf.push(uf); continue; }
  const codDe = codigosMun(lista, X);
  const nA = new Map(); for (const p of lista) { const c = codDe(p); if (c) nA.set(c, (nA.get(c) || 0) + 1); } // postos da ANP por município
  const cob = (cobUf[uf] = { total: lista.length, osm: 0, cnefe: 0 });
  for (const p of lista) {
    if (p.osm) cob.osm++;
    if (p.osm && !VALIDAR) continue;
    const cod = codDe(p);
    const ms = [porEndereco(p, X, cod), porEstab(p, X, cod), porInterp(p, X, cod), porCep(p, X, cod), porUnico(p, X, cod, nA)];
    for (const m of ms) if (m) { m.conf = confirma(m, p, X); m.outros = ms.filter((o) => o && o !== m && o.fonte !== "cnefe_cep").map((o) => dist(o.pt, m.pt)); }
    if (p.osm) { const dc = decide(ms); if (dc) final.push({ fonte: dc.m.fonte, precisao: dc.precisao, sub: dc.m.sub, d: dist(dc.m.pt, p.osm), p, pt: dc.m.pt }); for (const m of ms) if (m) val.push({ fonte: m.fonte, sub: m.sub, d: dist(m.pt, p.osm), p, pt: m.pt, conf: m.conf, outros: m.outros }); continue; }
    if (DIAG && !decide(ms)) { const k = (p.motivo || "?") + (ms[1] ? " [estab fraco]" : "") + (p.cepEsp ? "" : " [CEP geral]"); motivos[k] = (motivos[k] || 0) + 1; (amostra[k] ||= []).push(p); }
    const dc = decide(ms); if (!dc) continue;
    const r = p.row;
    r[C.lat] = dc.m.pt[0].toFixed(6); r[C.lng] = dc.m.pt[1].toFixed(6); r[C.geo_fonte] = dc.m.fonte; r[C.geo_score] = String(dc.score);
    p.precisao = dc.precisao; cob.cnefe++;
  }
}

const cabecalho = [...COLS, "geo_precisao"];
const saida = [cabecalho.join(";")];
const cont = {};
for (const p of postos) {
  const f = p.row[C.geo_fonte], prec = !f ? "" : f === "osm" || p.precisao === "ponto" ? "ponto" : "rua";
  if (f) { const k = f + "/" + prec; cont[k] = (cont[k] || 0) + 1; }
  saida.push([...p.row, prec].map(campo).join(";"));
}
writeFileSync(join(DIR, "postos-anp-geo.csv"), "﻿" + saida.join("\r\n") + "\r\n", "utf8");
const comCoord = postos.filter((p) => p.row[C.lat]).length;
console.log(`${comCoord} de ${postos.length} postos com coordenada (${(100 * comCoord / postos.length).toFixed(1)}%) -> postos-anp-geo.csv (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
console.log("por fonte/precisão:", JSON.stringify(cont));
if (faltaUf.length) console.log("UFs sem extrato (rode baixar-cnefe.mjs):", faltaUf.join(" "));

if (DIAG) {
  console.log("\nPostos sem casamento por endereço/estabelecimento, por motivo:", JSON.stringify(motivos));
  for (const [k, ps] of Object.entries(amostra)) { console.log("  " + k); for (const p of ps.filter((_, i) => i % Math.ceil(ps.length / 8) === 0).slice(0, 8)) console.log(`     ${p.row[C.nome]} | ${p.rua} | num ${p.num} | key ${p.key} | ${p.mun}/${p.uf} ${p.cepd}`); }
}
if (VALIDAR) {
  const q = (v, p) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const linha = (nome, ds) => `${nome.padEnd(46)} n=${String(ds.length).padStart(5)}  mediana ${q(ds, 0.5).toFixed(0).padStart(5)} m  p90 ${q(ds, 0.9).toFixed(0).padStart(6)} m  <50m ${(100 * ds.filter((d) => d < 50).length / ds.length).toFixed(0).padStart(3)}%  <100m ${(100 * ds.filter((d) => d < 100).length / ds.length).toFixed(0).padStart(3)}%  <150m ${(100 * ds.filter((d) => d < 150).length / ds.length).toFixed(0).padStart(3)}%  <300m ${(100 * ds.filter((d) => d < 300).length / ds.length).toFixed(0).padStart(3)}%`;
  console.log("\nValidação às cegas (postos com coordenada OSM): distância OSM x CNEFE");
  const fontes = [...new Set(val.map((v) => v.fonte))].sort();
  for (const f of fontes) {
    const vs = val.filter((v) => v.fonte === f);
    console.log(linha(f + " (todos)", vs.map((v) => v.d)));
    for (const s of [...new Set(vs.map((v) => v.sub))].sort()) { const ss = vs.filter((v) => v.sub === s); if (ss.length >= 15) console.log("   " + linha(s, ss.map((v) => v.d))); }
  }
  if (process.argv.includes("--piores")) for (const f of fontes) {
    const ruins = val.filter((v) => v.fonte === f && v.d > 300);
    console.log(`
${f}: ${ruins.length} acima de 300 m; amostra:`);
    for (const v of ruins.filter((_, i) => i % Math.ceil(ruins.length / 14) === 0).slice(0, 14)) console.log(`  ${v.d.toFixed(0)} m [${v.sub}] ${v.p.row[C.nome]} | ${v.p.row[C.endereco]} | cnefe ${v.pt.map((x) => x.toFixed(5))} osm ${v.p.osm.map((x) => x.toFixed(5))} | ${v.p.row[C.nome_osm]} ${v.p.row[C.geo_score]}`);
  }
  if (process.argv.includes("--features")) {
    console.log("\nFeatures (por fonte): confirmação por posto do CNEFE a <70 m; concordância com outro método");
    for (const f of fontes) {
      const vs = val.filter((v) => v.fonte === f);
      const grupos = { "conf=nome": vs.filter((v) => v.conf === "nome"), "conf=posto": vs.filter((v) => v.conf === "posto"), "conf=nenhum": vs.filter((v) => !v.conf),
        "outro<=100m": vs.filter((v) => v.outros.some((d) => d <= 100)), "sem outro": vs.filter((v) => !v.outros.length), "conflito>150m": vs.filter((v) => v.outros.length && v.outros.every((d) => d > 150)) };
      for (const [g, ds] of Object.entries(grupos)) if (ds.length >= 10) console.log("  " + linha(f + " " + g, ds.map((v) => v.d)));
    }
  }
  console.log("\nDECISÃO FINAL (o que entra no CSV), às cegas contra o OSM:");
  console.log(linha("todos os aceitos", final.map((v) => v.d)));
  for (const pr of ["ponto", "rua"]) { const vs = final.filter((v) => v.precisao === pr); if (vs.length) console.log(linha("precisão=" + pr, vs.map((v) => v.d))); }
  for (const f of [...new Set(final.map((v) => v.fonte))].sort()) console.log(linha("fonte=" + f, final.filter((v) => v.fonte === f).map((v) => v.d)));
  console.log(`cobertura da decisão sobre os ${postos.filter((p) => p.osm).length} postos do OSM: ${final.length}`);
  const ufs = Object.entries(cobUf).sort((a, b) => (b[1].osm + b[1].cnefe) / b[1].total - (a[1].osm + a[1].cnefe) / a[1].total);
  console.log("\nCobertura por UF (osm+cnefe)/total:\n" + ufs.map(([u, c]) => `${u} ${(100 * (c.osm + c.cnefe) / c.total).toFixed(0)}% (+${c.cnefe})`).join(" | "));
}
