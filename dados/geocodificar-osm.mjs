// Dá lat/lng aos postos da ANP cruzando com os postos (amenity=fuel) do OpenStreetMap.
// Uso: node dados/geocodificar-osm.mjs [--validar]
// Entradas (em dados/): postos-anp.csv, osm-fuel-br.json (Overpass: nwr[amenity=fuel] em BR, out center tags)
// e osm-municipios-br.json (baixado do Overpass se não existir). Saída: postos-anp-geo.csv.
// Sem serviço pago e sem geocodificação em massa: o casamento ANP<->OSM é local, por pontuação
// (município, rua, número, CEP, bairro, bandeira, nome) e atribuição um-para-um.
// A pontuação é uma razão de verossimilhança (em nats); geo_score = 0-100 ~ probabilidade do par.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = dirname(fileURLToPath(import.meta.url));
const ARQ = (n) => join(DIR, n);
const LIMIAR = 80; // geo_score mínimo para preencher lat/lng (precisão ~98% no teste cego, ver --validar)
const VALIDAR = process.argv.includes("--validar");

// ---------- texto ----------
const norm = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const UFS = { 11: "RO", 12: "AC", 13: "AM", 14: "RR", 15: "PA", 16: "AP", 17: "TO", 21: "MA", 22: "PI", 23: "CE", 24: "RN", 25: "PB", 26: "PE", 27: "AL", 28: "SE", 29: "BA", 31: "MG", 32: "ES", 33: "RJ", 35: "SP", 41: "PR", 42: "SC", 43: "RS", 50: "MS", 51: "MT", 52: "GO", 53: "DF" };
const SIGLAS = new Set(Object.values(UFS));
const lev = (a, b, max = 2) => { // distância de edição com corte
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let p = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const c = [i]; let min = i;
    for (let j = 1; j <= b.length; j++) { c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); if (c[j] < min) min = c[j]; }
    if (min > max) return max + 1;
    p = c;
  }
  return p[b.length];
};
const parseCsv = (txt) => txt.replace(/^﻿/, "").split(/\r?\n/).filter(Boolean).map((l) => {
  const r = []; let c = "", q = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (q) { if (ch === '"') { if (l[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; }
    else if (ch === '"') q = true; else if (ch === ";") { r.push(c); c = ""; } else c += ch;
  }
  r.push(c); return r;
});
const campo = (t) => (/[;"\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);

// ---------- rua / endereço ----------
const ABREV = { AV: "AVENIDA", R: "RUA", ROD: "RODOVIA", EST: "ESTRADA", ESTR: "ESTRADA", TRAV: "TRAVESSA", TV: "TRAVESSA", PC: "PRACA", PCA: "PRACA", AL: "ALAMEDA", DR: "DOUTOR", DRA: "DOUTORA", PROF: "PROFESSOR", PROFA: "PROFESSORA", CEL: "CORONEL", GEN: "GENERAL", PRES: "PRESIDENTE", ENG: "ENGENHEIRO", STA: "SANTA", STO: "SANTO", DEP: "DEPUTADO", VER: "VEREADOR", GOV: "GOVERNADOR", MAL: "MARECHAL", CAP: "CAPITAO", TEN: "TENENTE", SEN: "SENADOR", PE: "PADRE", SGT: "SARGENTO", BEL: "BACHAREL", ALM: "ALMIRANTE", COM: "COMENDADOR", CMTE: "COMANDANTE", DOM: "DOM", MONS: "MONSENHOR", VIA: "VIA" };
const TIPOS = new Set(["RUA", "AVENIDA", "RODOVIA", "ESTRADA", "TRAVESSA", "PRACA", "ALAMEDA", "LARGO", "VIA", "BECO", "VILA", "LOTEAMENTO", "LOTE", "QUADRA", "SETOR", "BAIRRO", "CENTRO", "ACESSO", "MARGINAL", "LADO", "SENTIDO", "KM", "SN", "S", "N"]);
const TITULOS = new Set(["DOUTOR", "DOUTORA", "PROFESSOR", "PROFESSORA", "CORONEL", "GENERAL", "PRESIDENTE", "ENGENHEIRO", "SANTA", "SANTO", "SAO", "DEPUTADO", "VEREADOR", "GOVERNADOR", "MARECHAL", "CAPITAO", "TENENTE", "SENADOR", "PADRE", "SARGENTO", "ALMIRANTE", "COMENDADOR", "COMANDANTE", "DOM", "MONSENHOR", "BACHAREL"]);
const PARTIC = new Set(["DE", "DA", "DO", "DAS", "DOS", "E", "A", "O"]);
const rota = (t) => { // "BR 116", "BR-116", "RODOVIA SP 270" -> "BR116" / "SP270"
  const m = norm(t).match(/\b(BR|[A-Z]{2,3})\s?(\d{2,3})\b/);
  return m && (m[1] === "BR" || SIGLAS.has(m[1]) || /^[A-Z]{3}$/.test(m[1]) && /^(AMG|LMG|CMG|MGC|SPA|SPI|SPM)$/.test(m[1])) ? m[1] + m[2] : null;
};
const ruaTokens = (t) => {
  const tk = norm(t).split(" ").filter(Boolean).map((x) => ABREV[x] || x);
  const util = tk.filter((x) => !TIPOS.has(x) && !PARTIC.has(x) && !/^\d+$/.test(x));
  const semTit = util.filter((x) => !TITULOS.has(x));
  return semTit.length ? semTit : util;
};
const digitos = (t) => String(t ?? "").replace(/\D/g, "");

// Decompõe "RUA X 500, 500, COMPL - BAIRRO, CIDADE - UF, 00000-000" (montado por extrair-postos-anp.mjs).
function parseEnderecoAnp(p) {
  const esc = p.municipio.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = p.endereco.match(new RegExp("^(.*) - (?:([^,]*), )?" + esc + " - " + p.uf + "(?:, \\d{5}-\\d{3})?$"));
  const head = m ? m[1] : p.endereco, bairro = m && m[2] ? norm(m[2]) : "";
  const segs = head.split(",").map((s) => s.trim()).filter(Boolean);
  const rua = (segs[0] || "").replace(/\s+\d+\s*$/, ""); // tira o número colado ao nome ("RUA X 1635")
  const nums = new Set();
  const sem = head.replace(/\bKM\s*\d+([.,]\d+)?/gi, " ");
  for (const s of sem.split(",").slice(1)) for (const d of s.match(/\d+/g) || []) nums.add(String(+d));
  const colado = segs[0] && segs[0].match(/\s(\d+)\s*$/); if (colado) nums.add(String(+colado[1]));
  nums.delete("0");
  return { ruaTk: ruaTokens(rua), rota: rota(head), nums, bairro, bairroTk: bairro.split(" ").filter((x) => x.length > 2 && !PARTIC.has(x)) };
}

// ---------- nome / bandeira ----------
const STOP_NOME = new Set(("LTDA ME EPP EIRELI SA S A COMERCIO COMERCIAL COMBUSTIVEIS COMBUSTIVEL DERIVADOS PETROLEO LUBRIFICANTES AUTO POSTO POSTOS SERVICO SERVICOS " +
  "DE DA DO DAS DOS E EM CIA CIA. IND INDUSTRIA TRANSPORTES TRANSPORTE DISTRIBUIDORA DISTRIBUIDOR REDE GRUPO EMPRESA PNEUS LAVA JATO GNV GAS GASOLINA ETANOL DIESEL " +
  "CONVENIENCIA LOJA CENTER CENTRO MINI MERCADO RESTAURANTE HOTEL PARADA TRUCK ACUCAR ALCOOL GERAL REPRESENTACOES PARTICIPACOES NEGOCIOS ADMINISTRACAO ENERGIA " +
  "PETROBRAS PETROBRAS PETROBAS VIBRA SHELL RAIZEN IPIRANGA YPIRANGA TEXACO ESSO BR ALE ALESAT BRANCA BANDEIRA INDEPENDENT INDEPENDENTE SA ").split(" "));
const fraseNome = (t) => norm(t).split(" ").filter((x) => x.length > 1 && !STOP_NOME.has(x) && !/^\d$/.test(x));
const ALIAS_NUM = { UM: "1", DOIS: "2", TRES: "3", QUATRO: "4", CINCO: "5" };
const tokNome = (t) => fraseNome(t).map((x) => ALIAS_NUM[x] || x);
const MAJOR_OSM = [["VIBRA", /\b(PETROBRAS|PETROBAS|VIBRA|BR MANIA)\b|\bBR\b(?! \d)/], ["RAIZEN", /\b(SHELL|RAIZEN|ESSO)\b/], ["IPIRANGA", /\b(IPIRANGA|YPIRANGA|TEXACO|AMPM)\b/], ["ALE", /\b(ALE|ALESAT)\b/]];
const BRANCA_OSM = /\b(BANDEIRA BRANCA|BRANCA|INDEPENDENT|INDEPENDENTE|SEM BANDEIRA)\b/;
const majorAnp = (b) => { const n = norm(b); return /^RAIZEN/.test(n) ? "RAIZEN" : n === "VIBRA" ? "VIBRA" : n === "IPIRANGA" ? "IPIRANGA" : /^ALE/.test(n) ? "ALE" : null; };
const chaveBandeira = (b) => { const n = norm(b).replace(/ S$/, ""); return n.split(" ").filter((x) => !["DISTRIBUIDORA", "COMBUSTIVEIS", "PETROLEO"].includes(x))[0] || ""; };

// ---------- OSM e municípios ----------
async function baixaMunicipios(arq) {
  const q = `[out:json][timeout:600];area["ISO3166-1"="BR"][admin_level=2]->.br;rel(area.br)["boundary"="administrative"]["admin_level"="8"];out center bb tags;`;
  for (let t = 1; t <= 4; t++) {
    const r = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", headers: { "User-Agent": "PostoLegal/0.1 (fabioportelacarvalho@gmail.com)", "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(q) });
    if (r.ok) { writeFileSync(arq, await r.text()); return; }
    console.warn(`Overpass ${r.status}, nova tentativa em 30 s`); await new Promise((ok) => setTimeout(ok, 30000));
  }
  throw new Error("Overpass indisponível");
}
if (!existsSync(ARQ("osm-municipios-br.json"))) { console.log("baixando municípios do Overpass..."); await baixaMunicipios(ARQ("osm-municipios-br.json")); }

const municipios = JSON.parse(readFileSync(ARQ("osm-municipios-br.json"), "utf8")).elements.filter((e) => e.tags?.["IBGE:GEOCODIGO"] && e.bounds && !e.tags["IBGE:GEOCODIGO"].startsWith("53")).map((e) => {
  const b = e.bounds, nome = norm(e.tags.name), uf = UFS[e.tags["IBGE:GEOCODIGO"].slice(0, 2)];
  return { key: nome + "|" + uf, nome, uf, b, lat: (b.minlat + b.maxlat) / 2, lon: (b.minlon + b.maxlon) / 2, hh: (b.maxlat - b.minlat) / 2 || 1e-3, hw: (b.maxlon - b.minlon) / 2 || 1e-3 };
});
{ // o OSM só tem as regiões administrativas do DF (admin_level 8): vira um município único
  const b = { minlat: -16.05, maxlat: -15.5, minlon: -48.3, maxlon: -47.3 };
  municipios.push({ key: "BRASILIA|DF", nome: "BRASILIA", uf: "DF", b, lat: -15.78, lon: -47.8, hh: 0.275, hw: 0.5 });
}
const porNome = new Map(); // nome normalizado -> [municípios]
const porChave = new Map();
const grade = new Map();
for (const m of municipios) {
  (porNome.get(m.nome) || porNome.set(m.nome, []).get(m.nome)).push(m);
  (porChave.get(m.key) || porChave.set(m.key, []).get(m.key)).push(m);
  for (let a = Math.floor(m.b.minlat); a <= Math.floor(m.b.maxlat); a++) for (let o = Math.floor(m.b.minlon); o <= Math.floor(m.b.maxlon); o++) {
    const k = a + "," + o; (grade.get(k) || grade.set(k, []).get(k)).push(m);
  }
}
// municípios que contêm o ponto no bbox, do mais "central" (relativo ao tamanho) ao menos
function municipiosDe(lat, lon) {
  const out = new Map();
  for (const m of grade.get(Math.floor(lat) + "," + Math.floor(lon)) || []) {
    const d = Math.max(Math.abs(lat - m.lat) / m.hh, Math.abs(lon - m.lon) / m.hw);
    if (d <= 1 && (!out.has(m.key) || out.get(m.key) > d)) out.set(m.key, d);
  }
  if (!out.size) for (let a = -1; a <= 1; a++) for (let o = -1; o <= 1; o++) for (const m of grade.get((Math.floor(lat) + a) + "," + (Math.floor(lon) + o)) || []) { // fora de todo bbox (costa)
    const d = Math.max(Math.abs(lat - m.lat) / m.hh, Math.abs(lon - m.lon) / m.hw); if (d <= 1.5 && (!out.has(m.key) || out.get(m.key) > d)) out.set(m.key, d);
  }
  return [...out].sort((x, y) => x[1] - y[1]).slice(0, 3).map(([key]) => key);
}
// município da ANP -> chave do OSM (nome igual; senão, parecido dentro da mesma UF)
const chaveAnp = (() => {
  const cache = new Map();
  return (mun, uf) => {
    const k0 = norm(mun) + "|" + uf;
    if (cache.has(k0)) return cache.get(k0);
    let r = porChave.has(k0) ? k0 : null;
    if (!r) {
      const n = norm(mun), cand = municipios.filter((m) => m.uf === uf);
      r = (cand.map((m) => [m, lev(n, m.nome, 3)]).filter(([, d]) => d <= 3).sort((a, b) => a[1] - b[1])[0]?.[0] || cand.find((m) => m.nome.startsWith(n) || n.startsWith(m.nome))
        || null)?.key ?? null;
    }
    cache.set(k0, r); return r;
  };
})();

// ---------- carga ----------
const linhas = parseCsv(readFileSync(ARQ("postos-anp.csv"), "utf8"));
const COLS = linhas[0];
const anp = linhas.slice(1).map((r, i) => ({ i, row: r, nome: r[0], endereco: r[1], cnpj: r[2], bandeira: r[3], municipio: r[4], uf: r[5], cep: r[6] }));
const osmBruto = JSON.parse(readFileSync(ARQ("osm-fuel-br.json"), "utf8")).elements.map((e) => ({ id: `${e.type}/${e.id}`, no: e.type === "node", lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon, t: e.tags || {} })).filter((e) => e.lat != null);

// IDF dos tokens de razão social
const df = new Map();
for (const p of anp) { p.tk = [...new Set(tokNome(p.nome))]; for (const t of p.tk) df.set(t, (df.get(t) || 0) + 1); }
const idf = (t) => Math.log(anp.length / (df.get(t) || 1));

for (const p of anp) {
  Object.assign(p, parseEnderecoAnp(p));
  p.mkey = chaveAnp(p.municipio, p.uf);
  p.major = majorAnp(p.bandeira);
  p.branca = /BRANCA/.test(norm(p.bandeira));
  p.bkey = p.major || p.branca ? "" : chaveBandeira(p.bandeira);
  p.cepd = digitos(p.cep);
  p.munTk = new Set(norm(p.municipio).split(" "));
}
const chavesBand = new Set(anp.map((p) => p.bkey).filter((k) => k.length >= 3));

// ---------- preparo dos postos OSM ----------
function prepara(o, semEndereco) {
  const t = o.t;
  const textoBr = norm([t.brand, t.operator, t.name].filter(Boolean).join(" "));
  o.major = null;
  const brandTxt = norm([t.brand, t.operator].filter(Boolean).join(" ")), nomeTxt = norm(t.name);
  for (const txt of [brandTxt, nomeTxt]) { for (const [k, re] of MAJOR_OSM) if (!o.major && re.test(txt)) o.major = k; if (o.major) break; }
  o.branca = !o.major && BRANCA_OSM.test(textoBr);
  o.outras = new Set(); for (const w of textoBr.split(" ")) if (chavesBand.has(w)) o.outras.add(w);
  const desc = norm(t.description), rs = desc.indexOf("RAZAO SOCIAL");
  o.nomeTk = [...new Set(["name", "alt_name", "old_name", "short_name", "official_name", "loc_name", "operator", "brand"].flatMap((k) => tokNome(t[k])).concat(rs >= 0 ? tokNome(desc.slice(rs + 12)) : []))];
  o.nomeTk = o.nomeTk.filter((x) => x.length > 1);
  o.nomeDist = new Set(["name", "alt_name", "old_name", "short_name", "official_name"].flatMap((k) => tokNome(t[k])));
  o.operLegal = /\b(LTDA|EIRELI|ME|EPP|S A|SA)\b/.test(norm(t.operator)) ? new Set(tokNome(t.operator)) : null;
  const end = semEndereco;
  o.cidade = end ? "" : norm(t["addr:city"]);
  o.ruaTk = end || !t["addr:street"] ? null : ruaTokens(t["addr:street"]);
  o.rota = end || !t["addr:street"] ? null : rota(t["addr:street"]);
  o.num = end ? "" : (digitos((t["addr:housenumber"] || "").split(/[;,\/ -]/)[0]).replace(/^0+/, ""));
  o.cepd = end ? "" : digitos(t["addr:postcode"]);
  o.bairroTk = end || !t["addr:suburb"] ? [] : norm(t["addr:suburb"]).split(" ").filter((x) => x.length > 2 && !PARTIC.has(x));
  o.bairro = end ? "" : norm(t["addr:suburb"]);
  o.mkeys = municipiosDe(o.lat, o.lon);
  return o;
}

// funde duplicatas (nó + prédio do mesmo posto): <= 50 m, bandeira compatível, nomes compatíveis
function deduplica(lista) {
  const ordem = [...lista].sort((a, b) => (b.no - a.no) || (Object.keys(b.t).length - Object.keys(a.t).length) || a.id.localeCompare(b.id));
  const g = new Map(), reps = [], KM = 111.32;
  for (const o of ordem) {
    const cx = Math.floor(o.lat * 200), cy = Math.floor(o.lon * 200);
    let alvo = null;
    for (let a = -1; a <= 1 && !alvo; a++) for (let b = -1; b <= 1 && !alvo; b++) for (const r of g.get((cx + a) + "," + (cy + b)) || []) {
      const dy = (o.lat - r.lat) * KM * 1000, dx = (o.lon - r.lon) * KM * 1000 * Math.cos(o.lat * Math.PI / 180);
      if (dx * dx + dy * dy > 2500) continue;
      if (r.major && o.major && r.major !== o.major) continue;
      const n1 = norm(r.t.name), n2 = norm(o.t.name); if (n1 && n2 && n1 !== n2) continue;
      alvo = r; break;
    }
    if (alvo) { alvo.fundidos.push(o.id); for (const k in o.t) if (!(k in alvo.t)) alvo.t[k] = o.t[k]; if (o.t["ref:vatin"] || o.t.cnpj) alvo.gab = (alvo.gab || []).concat(o.t["ref:vatin"] || o.t.cnpj); }
    else { const r = { ...o, t: { ...o.t }, fundidos: [o.id] }; const v = o.t["ref:vatin"] || o.t.cnpj; if (v) r.gab = [v]; reps.push(r); const k = cx + "," + cy; (g.get(k) || g.set(k, []).get(k)).push(r); }
  }
  return reps;
}

// ---------- pontuação do par ----------
const compat = (a, o) => { // bandeira ANP x OSM (em nats)
  if (a.major) {
    if (o.major) return o.major === a.major ? 2.2 : -4;
    if (o.outras.size) return -3;
    return o.branca ? -2 : -0.2;
  }
  if (a.branca) return o.major ? -3 : o.outras.size ? -1 : o.branca ? 0.8 : 0;
  if (a.bkey) return o.outras.has(a.bkey) ? 3 : o.major ? -3 : o.branca ? -1 : -0.2;
  return 0;
};
function nomeScore(a, o) {
  if (!a.tk.length || !o.nomeTk.length) return { s: 0, casou: 0 };
  let w = 0, casou = 0;
  for (const t of a.tk) {
    let ok = o.nomeTk.includes(t);
    if (!ok && t.length >= 5) ok = o.nomeTk.some((x) => x.length >= 5 && (x[0] === t[0]) && (lev(t, x, 1) <= 1 || (t.length >= 6 && x.length >= 6 && (t.startsWith(x) || x.startsWith(t)))));
    if (ok) { w += Math.min(idf(t), 9) * (a.munTk.has(t) ? 0.3 : 1); casou++; } // nome da cidade no nome do posto vale pouco
  }
  let s = Math.min(0.62 * w, 8);
  // nome fantasia que cita o bairro ou a rua do posto ("Posto Redinha", "Posto Universitário")
  if (o.nomeDist.size && a.bairroTk.length) {
    const loc = a.bairroTk.concat(a.ruaTk);
    const q = [...o.nomeDist].filter((x) => !a.tk.includes(x) && x.length > 3 && loc.includes(x)).length;
    s += Math.min(1.4 * q, 2.8);
  }
  if (!casou) {
    if (o.operLegal && o.operLegal.size) s -= 9; // operator legal diferente da razão social: outra empresa
    else if (o.nomeDist.size) s -= 0.6;
  } else if (o.operLegal && o.operLegal.size) {
    const cob = [...o.operLegal].filter((x) => a.tk.includes(x)).length / o.operLegal.size;
    if (cob >= 0.7) s += 3;
  }
  return { s, casou };
}
function pontua(a, o, rank, det) {
  const c = {};
  // município
  const cid = o.cidade;
  if (cid) {
    if (porNome.has(cid) && a.mkey && cid === a.mkey.split("|")[0]) c.mun = 2.5;
    else if (porNome.has(cid) && o.mkeys.some((k) => k.split("|")[0] === cid)) c.mun = -4; // o OSM diz outra cidade
    else c.mun = -0.4 - 1.2 * rank;
  } else c.mun = -1.5 * rank;
  // rua / número
  let ruaS = 0;
  if (a.rota && o.rota) ruaS = a.rota === o.rota ? 3.5 : -2.5;
  else if (a.ruaTk.length && o.ruaTk && o.ruaTk.length) {
    const inter = a.ruaTk.filter((x) => o.ruaTk.includes(x) || o.ruaTk.some((y) => x.length >= 5 && y.length >= 5 && lev(x, y, 1) <= 1)).length;
    const f = inter / Math.max(a.ruaTk.length, o.ruaTk.length);
    ruaS = f >= 0.99 ? 5 : f >= 0.6 ? 3.5 * f : inter ? 0.5 : -2.5;
  } else if (a.rota !== o.rota && (a.rota || o.rota) && (o.ruaTk || o.rota)) ruaS = -0.8;
  c.rua = ruaS;
  if (o.num && a.nums.size) c.num = a.nums.has(o.num) ? (ruaS > 0 ? 3.5 : 1) : (ruaS > 2 ? -1.2 : -0.3);
  if (o.cepd.length === 8 && a.cepd.length === 8) c.cep = o.cepd === a.cepd ? (a.cepd.endsWith("000") ? 0.3 : 2.5) : o.cepd.slice(0, 5) === a.cepd.slice(0, 5) ? -0.2 : -1.5;
  if (o.bairroTk.length && a.bairroTk.length) { const i = a.bairroTk.filter((x) => o.bairroTk.includes(x)).length; c.bairro = i ? 1.5 * i / Math.max(a.bairroTk.length, o.bairroTk.length) : (a.bairro && o.bairro ? -0.5 : 0); }
  c.band = compat(a, o);
  const n = nomeScore(a, o); c.nome = n.s;
  let s = 0; for (const k in c) s += c[k];
  return det ? { s, c } : s;
}

// ---------- casamento ----------
const T0 = 3.2; // massa "o posto não está na outra base" (e^T0) no cálculo da probabilidade do par
const classeA = (a) => (a.major ? "M" + a.major : a.branca ? "B" : a.bkey ? "K" + a.bkey : "N");
const classeO = (o) => `${o.major || ""}|${o.branca ? 1 : 0}|${[...o.outras].sort().join(",")}`;
function casar(osm, det = false) {
  const porMun = new Map();
  for (const a of anp) if (a.mkey) (porMun.get(a.mkey) || porMun.set(a.mkey, []).get(a.mkey)).push(a);
  // 1) pontuação base de cada par (sem o bônus de exclusividade); só guarda os com alguma evidência
  const PA = [], PO = [], PS = [];
  osm.forEach((o, oi) => {
    o.cls = classeO(o);
    o.mkeys.forEach((k, rank) => {
      for (const a of porMun.get(k) || []) { const s = pontua(a, o, rank); if (s >= 0.4) { PA.push(a.i); PO.push(oi); PS.push(s); } }
    });
  });
  const res = new Map(), fixoA = new Uint8Array(anp.length), fixoO = new Uint8Array(osm.length);
  for (let rodada = 1; rodada <= 6; rodada++) {
    // 2) contagem dos ainda livres, por município e classe de bandeira: poucos candidatos compatíveis = evidência
    const cA = new Map(), cO = new Map(), repA = new Map(), repO = new Map();
    for (const a of anp) if (a.mkey && !fixoA[a.i]) { const m = cA.get(a.mkey) || cA.set(a.mkey, new Map()).get(a.mkey); const c = classeA(a); m.set(c, (m.get(c) || 0) + 1); repA.set(c, a); }
    osm.forEach((o, oi) => { if (fixoO[oi]) return; o.mkeys.slice(0, 2).forEach((k) => { const m = cO.get(k) || cO.set(k, new Map()).get(k); m.set(o.cls, (m.get(o.cls) || 0) + 1); repO.set(o.cls, o); }); });
    const nA = (k, o) => { let n = 0; for (const [c, q] of cA.get(k) || []) if (compat(repA.get(c), o) >= -0.5) n += q; return n; };
    const nO = (k, a) => { let n = 0; for (const [c, q] of cO.get(k) || []) if (compat(a, repO.get(c)) >= -0.5) n += q; return n; };
    const vivos = [], somaA = new Map(), somaO = new Map();
    for (let j = 0; j < PS.length; j++) {
      if (fixoA[PA[j]] || fixoO[PO[j]]) continue;
      const a = anp[PA[j]], o = osm[PO[j]];
      const prod = nA(a.mkey, o) * nO(a.mkey, a);
      const s = PS[j] + (prod <= 1 ? 3 : prod <= 2 ? 1.8 : prod <= 4 ? 0.8 : 0);
      if (s <= 0.5) continue;
      const e = Math.exp(s);
      somaA.set(a.i, (somaA.get(a.i) || 0) + e); somaO.set(PO[j], (somaO.get(PO[j]) || 0) + e);
      vivos.push({ s, p: 0, ai: a.i, oi: PO[j] });
    }
    for (const v of vivos) { const e = Math.exp(v.s); v.p = Math.min(e / (Math.exp(T0) + somaA.get(v.ai)), e / (Math.exp(T0) + somaO.get(v.oi))); }
    vivos.sort((x, y) => y.p - x.p || y.s - x.s || x.ai - y.ai || x.oi - y.oi);
    const ultima = rodada === 6;
    let novos = 0;
    for (const v of vivos) {
      if (!ultima && v.p < 0.85) break;
      if (fixoA[v.ai] || fixoO[v.oi]) continue;
      fixoA[v.ai] = 1; fixoO[v.oi] = 1; novos++;
      res.set(v.ai, { a: anp[v.ai], o: osm[v.oi], s: v.s, score: Math.round(100 * v.p), rodada });
    }
    if (!novos) { // nada passou do corte: fecha atribuindo o restante pela probabilidade
      for (const v of vivos) { if (fixoA[v.ai] || fixoO[v.oi]) continue; fixoA[v.ai] = 1; fixoO[v.oi] = 1; res.set(v.ai, { a: anp[v.ai], o: osm[v.oi], s: v.s, score: Math.round(100 * v.p), rodada }); }
      break;
    }
  }
  if (det) for (const r of res.values()) r.c = pontua(r.a, r.o, Math.max(0, r.o.mkeys.indexOf(r.a.mkey)), true).c;
  return res;
}

// ---------- execução ----------
const t0 = Date.now();
const osmBase = deduplica(osmBruto);
console.log(`OSM: ${osmBruto.length} elementos -> ${osmBase.length} postos após fundir duplicatas`);
const osm = osmBase.map((o) => prepara(o, false));
const res = casar(osm, VALIDAR);

const cabecalho = [...COLS, "lat", "lng", "geo_fonte", "geo_score", "osm_id", "nome_osm"];
const saida = [cabecalho.join(";")];
let casados = 0;
for (const p of anp) {
  const r = res.get(p.i);
  const ok = r && r.score >= LIMIAR;
  if (ok) casados++;
  const extra = ok ? [r.o.lat.toFixed(6), r.o.lon.toFixed(6), "osm", String(r.score), r.o.id, r.o.t.name || ""] : ["", "", "", "", "", ""];
  saida.push([...p.row, ...extra].map(campo).join(";"));
}
writeFileSync(ARQ("postos-anp-geo.csv"), "﻿" + saida.join("\r\n") + "\r\n", "utf8");
console.log(`${casados} de ${anp.length} postos com coordenada (${(100 * casados / anp.length).toFixed(1)}%), limiar ${LIMIAR} -> postos-anp-geo.csv (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

// ---------- validação (gabarito ref:vatin / cnpj e teste cego) ----------
if (VALIDAR) {
  const faixas = [[95, 101], [90, 95], [80, 90], [70, 80], [60, 70], [50, 60], [30, 50], [0, 30]];
  console.log("\nDistribuição por faixa de geo_score (todas as atribuições um-para-um):");
  for (const [lo, hi] of faixas) console.log(`  ${lo}-${hi - 1}: ${[...res.values()].filter((r) => r.score >= lo && r.score < hi).length}`);
  const cnpjDe = (v) => { const d = digitos(v).replace(/^55(?=\d{14}$)/, ""); return d.length === 14 ? d : d.length > 14 ? d.slice(-14) : ""; };
  const porOsm = new Map([...res.values()].map((r) => [r.o.id, r]));
  const gab = osm.filter((o) => o.gab?.length);
  const anpCnpj = new Set(anp.map((p) => p.cnpj));
  const dentro = gab.filter((o) => o.gab.some((v) => anpCnpj.has(cnpjDe(v))));
  console.log(`\nGabarito (ref:vatin/cnpj): ${gab.length} postos OSM, ${dentro.length} com CNPJ presente na base ANP`);
  const rel = (titulo, lista, getR) => {
    console.log(titulo);
    for (const lim of [50, 60, 70, 80, 90]) {
      let tot = 0, cert = 0, err = 0;
      for (const o of lista) { const r = getR(o); if (r && r.score >= lim) { tot++; (o.gab.some((v) => cnpjDe(v) === r.a.cnpj) ? cert++ : err++); } }
      console.log(`  limiar ${lim}: casados ${tot}/${lista.length} (cobertura ${(100 * tot / lista.length).toFixed(0)}%), certos ${cert}, errados ${err}, precisão ${(100 * cert / (tot || 1)).toFixed(1)}%`);
    }
  };
  rel("Gabarito, endereço do OSM usado:", dentro, (o) => porOsm.get(o.id));
  for (const o of dentro) { const r = porOsm.get(o.id); const certo = anp.find((p) => o.gab.some((v) => cnpjDe(v) === p.cnpj)); console.log(`    ${o.t.name} (${o.mkeys[0]}) -> ${r ? (r.a.cnpj === certo.cnpj ? "OK" : "ERRADO:" + r.a.nome) + " score " + r.score + " s=" + r.s.toFixed(1) + " " + JSON.stringify(Object.fromEntries(Object.entries(r.c).map(([k, v]) => [k, +v.toFixed(1)]))) : "sem par"} | esperado ANP: ${certo.nome} ${certo.endereco}`); }
  // mesmo gabarito sem os campos addr:* (pior caso: posto OSM sem endereço)
  const cego = osmBase.map((o) => prepara({ ...o }, true));
  const resC = casar(cego);
  const porOsmC = new Map([...resC.values()].map((r) => [r.o.id, r]));
  rel("Gabarito, SEM usar addr:* (pior caso):", dentro, (o) => porOsmC.get(o.id));
  // teste cego ampliado: pares fortes por endereço (rua e número iguais) viram gabarito; refaz sem addr:*
  const fortes = [...res.values()].filter((r) => r.c.rua >= 3.5 && r.c.num >= 3 && r.s >= 9);
  const forteMap = new Map(fortes.map((r) => [r.o.id, r.a.i]));
  console.log(`\nTeste cego: ${fortes.length} pares fortes por endereço (rua+número) viram gabarito; reexecutado sem addr:*`);
  for (const lim of [50, 60, 70, 80, 90]) {
    let tot = 0, cert = 0;
    for (const [id, ai] of forteMap) { const r = porOsmC.get(id); if (r && r.score >= lim) { tot++; if (r.a.i === ai) cert++; } }
    console.log(`  limiar ${lim}: casados ${tot}/${fortes.length} (cobertura ${(100 * tot / fortes.length).toFixed(0)}%), concordam ${cert}, precisão ${(100 * cert / (tot || 1)).toFixed(1)}%`);
  }
  // amostra para inspeção manual
  const acima = [...res.values()].filter((r) => r.score >= LIMIAR && r.score < LIMIAR + 10);
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  console.log(`\nAmostra de 20 casamentos com score ${LIMIAR}-${LIMIAR + 9} (${acima.length} no total):`);
  for (let i = 0; i < 20 && acima.length; i++) {
    const r = acima.splice(Math.floor(rnd() * acima.length), 1)[0];
    console.log(`  [${r.score}] ANP: ${r.a.nome} | ${r.a.bandeira} | ${r.a.endereco}\n        OSM ${r.o.id}: ${r.o.t.name || "-"} | ${r.o.t.brand || r.o.t.operator || "-"} | ${[r.o.t["addr:street"], r.o["addr:housenumber"], r.o.t["addr:suburb"], r.o.t["addr:city"]].filter(Boolean).join(", ") || "sem addr"} | ${r.o.lat.toFixed(5)},${r.o.lon.toFixed(5)}`);
  }
  const uf = {}; for (const p of anp) { const u = (uf[p.uf] ||= [0, 0]); u[1]++; const r = res.get(p.i); if (r && r.score >= LIMIAR) u[0]++; }
  console.log("\nCobertura por UF:\n" + Object.entries(uf).sort((x, y) => y[1][0] / y[1][1] - x[1][0] / x[1][1]).map(([u, [c, t]]) => `${u} ${c}/${t} ${(100 * c / t).toFixed(0)}%`).join(" | "));
}
