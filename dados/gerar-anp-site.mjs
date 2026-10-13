// Gera prototipo/anp/: um JSON por UF com os postos da ANP (com ou sem coordenada) e um
// índice com a área de cada UF. O app baixa só as UFs que precisa (mapa, GPS, busca).
// Uso: node dados/gerar-anp-site.mjs [entrada.csv] [pasta-saida]
// Entrada: dados/postos-anp-geo.csv (extrair-postos-anp → geocodificar-osm → geocodificar-cnefe).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const entrada = process.argv[2] || "dados/postos-anp-geo.csv";
const saida = process.argv[3] || "prototipo/anp";

// CSV com ";" e aspas no padrão RFC ("" dentro de campo entre aspas)
function linhasCsv(texto) {
  const out = [];
  for (const l of texto.replace(/^﻿/, "").split(/\r?\n/)) {
    if (!l) continue;
    const c = []; let cur = "", q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++ } else if (ch === '"') q = false; else cur += ch }
      else if (ch === '"') q = true; else if (ch === ";") { c.push(cur); cur = "" } else cur += ch;
    }
    c.push(cur); out.push(c);
  }
  return out;
}

// Bandeira da ANP → nome usado no app (mesma lista do cadastro de posto)
const BAND = { "VIBRA": "Petrobras / BR", "RAIZEN": "Shell", "IPIRANGA": "Ipiranga", "ALESAT": "Ale", "BANDEIRA BRANCA": "Bandeira branca", "PETRONAS": "Petronas" };
const titulo = (t) => t.toLowerCase().replace(/(^|[\s/'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

const [cab, ...rows] = linhasCsv(readFileSync(entrada, "utf8"));
const col = Object.fromEntries(cab.map((n, i) => [n, i]));
for (const n of ["nome", "endereco", "cnpj", "bandeira", "municipio", "uf", "lat", "lng", "nome_osm", "geo_precisao"]) if (!(n in col)) throw new Error(`coluna ${n} não encontrada`);

const porUF = {};
for (const r of rows) {
  const v = (n) => (r[col[n]] || "").trim();
  const uf = v("uf"), mun = v("municipio"), lat = v("lat") ? +(+v("lat")).toFixed(5) : null, lng = v("lng") ? +(+v("lng")).toFixed(5) : null;
  // endereço sem a parte ", MUNICIPIO - UF" (o app mostra cidade/UF à parte)
  const end = v("endereco").replace(`, ${mun} - ${uf}`, "");
  const b = v("bandeira");
  (porUF[uf] = porUF[uf] || []).push([v("cnpj"), v("nome"), BAND[b] || titulo(b), titulo(mun), end, lat, lng, v("nome_osm"), v("geo_precisao") === "rua" ? 1 : 0]);
}

mkdirSync(saida, { recursive: true });
for (const f of readdirSync(saida)) if (f.endsWith(".json")) unlinkSync(join(saida, f));
const indice = { gerado: new Date().toISOString().slice(0, 10), fonte: "ANP (revendedores varejistas) + OpenStreetMap + IBGE/CNEFE 2022",
  campos: ["cnpj", "nome", "bandeira", "cidade", "endereco", "lat", "lng", "nome_osm", "aprox"], ufs: {} };
let total = 0, comGeo = 0;
for (const uf of Object.keys(porUF).sort()) {
  const l = porUF[uf].sort((a, b) => a[3].localeCompare(b[3], "pt") || a[1].localeCompare(b[1], "pt"));
  const g = l.filter((p) => p[5] != null);
  const bbox = g.length ? [Math.min(...g.map((p) => p[5])), Math.min(...g.map((p) => p[6])), Math.max(...g.map((p) => p[5])), Math.max(...g.map((p) => p[6]))] : null;
  writeFileSync(join(saida, `${uf}.json`), JSON.stringify(l));
  indice.ufs[uf] = { n: l.length, geo: g.length, bbox };
  total += l.length; comGeo += g.length;
}
writeFileSync(join(saida, "index.json"), JSON.stringify(indice));
console.log(`${total} postos em ${Object.keys(porUF).length} UFs (${comGeo} com coordenada) → ${saida}/`);
