// Funções comuns a baixar-cnefe.mjs e geocodificar-cnefe.mjs: normalização de texto/rua e leitura
// do cadastro bruto da ANP (rua e número separados). Sem dependências npm.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DIR = dirname(fileURLToPath(import.meta.url));
export const CACHE = join(homedir(), ".cache", "posto-legal", "cnefe"); // fora do Drive: nunca sincroniza
export const UFS = { 11: "RO", 12: "AC", 13: "AM", 14: "RR", 15: "PA", 16: "AP", 17: "TO", 21: "MA", 22: "PI", 23: "CE", 24: "RN", 25: "PB", 26: "PE", 27: "AL", 28: "SE", 29: "BA", 31: "MG", 32: "ES", 33: "RJ", 35: "SP", 41: "PR", 42: "SC", 43: "RS", 50: "MS", 51: "MT", 52: "GO", 53: "DF" };
const SIGLAS = new Set(Object.values(UFS));

export const norm = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
export const digitos = (t) => String(t ?? "").replace(/\D/g, "");
export const campo = (t) => (/[;"\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
export const parseCsv = (txt) => txt.replace(/^﻿/, "").split(/\r?\n/).filter(Boolean).map((l) => {
  const r = []; let c = "", q = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (q) { if (ch === '"') { if (l[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; }
    else if (ch === '"') q = true; else if (ch === ";") { r.push(c); c = ""; } else c += ch;
  }
  r.push(c); return r;
});

// ---------- rua ----------
const ABREV = { AV: "AVENIDA", R: "RUA", ROD: "RODOVIA", EST: "ESTRADA", ESTR: "ESTRADA", TRAV: "TRAVESSA", TV: "TRAVESSA", PC: "PRACA", PCA: "PRACA", AL: "ALAMEDA", DR: "DOUTOR", DRA: "DOUTORA", PROF: "PROFESSOR", PROFA: "PROFESSORA", CEL: "CORONEL", GEN: "GENERAL", PRES: "PRESIDENTE", ENG: "ENGENHEIRO", STA: "SANTA", STO: "SANTO", DEP: "DEPUTADO", VER: "VEREADOR", GOV: "GOVERNADOR", MAL: "MARECHAL", CAP: "CAPITAO", TEN: "TENENTE", SEN: "SENADOR", PE: "PADRE", SGT: "SARGENTO", BEL: "BACHAREL", ALM: "ALMIRANTE", COM: "COMENDADOR", CMTE: "COMANDANTE", MONS: "MONSENHOR", MAJ: "MAJOR", CONS: "CONSELHEIRO", DES: "DESEMBARGADOR", JD: "JARDIM", VL: "VILA", LGO: "LARGO", PQ: "PARQUE", CJ: "CONJUNTO", FAZ: "FAZENDA", SIT: "SITIO", BR: "BR" };
const TIPOS = new Set(["RUA", "AVENIDA", "RODOVIA", "ESTRADA", "TRAVESSA", "PRACA", "ALAMEDA", "LARGO", "VIA", "BECO", "RAMAL", "LINHA", "PASSAGEM", "CAMINHO", "LADEIRA", "VEREDA", "VIELA", "ACESSO", "MARGINAL", "ESTR", "PARQUE", "LOTEAMENTO"]);
const TITULOS = new Set(["DOUTOR", "DOUTORA", "PROFESSOR", "PROFESSORA", "CORONEL", "GENERAL", "PRESIDENTE", "ENGENHEIRO", "SANTA", "SANTO", "SAO", "DEPUTADO", "VEREADOR", "GOVERNADOR", "MARECHAL", "CAPITAO", "TENENTE", "SENADOR", "PADRE", "SARGENTO", "ALMIRANTE", "COMENDADOR", "COMANDANTE", "DOM", "MONSENHOR", "BACHAREL", "MAJOR", "CONSELHEIRO", "DESEMBARGADOR", "NOSSA", "SENHORA", "SENHOR"]);
const PARTIC = new Set(["DE", "DA", "DO", "DAS", "DOS", "E", "A", "O"]);
const TEM_ROD = /\b(RODOVIA|ROD|ESTRADA|EST|ESTR|VIA|RAMAL)\b/;

// "BR 116", "RODOVIA SP 270" -> "BR116" / "SP270" (só com contexto de rodovia, exceto BR)
export const rota = (t) => {
  const n = norm(t), m = n.match(/\b(BR|[A-Z]{2,3})\s?(\d{2,3})\b/);
  if (!m) return null;
  return m[1] === "BR" || (SIGLAS.has(m[1]) && TEM_ROD.test(n)) ? m[1] + m[2] : null;
};
// chave canônica da rua: sem tipo, título nem partículas ("AV DR JOSE X" == "AVENIDA, DOUTOR, JOSE X")
export const ruaChave = (t) => {
  const r = rota(t); if (r) return "#" + r;
  const tk = norm(t).split(" ").filter(Boolean).map((x) => ABREV[x] || x);
  while (tk.length > 1 && TIPOS.has(tk[0])) tk.shift();
  const k = tk.filter((x) => !PARTIC.has(x) && !TITULOS.has(x));
  return (k.length ? k : tk).join(" ") || null;
};
// posto de combustível no DSC_ESTABELECIMENTO do CNEFE (descarta "posto de saúde", "posto policial"…)
const POSTO_SIM = /\b(AUTO ?POSTO|POSTO|COMBUSTIVE[IL]S?|ABASTECIMENTO|GASOLINA|PETROBRAS|IPIRANGA|SHELL|RAIZEN|VIBRA|TEXACO|ESSO|ALESAT|BR MANIA|REDE (AMERICA|DE POSTOS))\b/;
const POSTO_NAO = /\b(SAUDE|POLICIA|POLICIAL|COLETA|FISCAL|FISCALIZACAO|BOMBEIRO|MOLAS|CORREIO|VACINA|UBS|ATENDIMENTO|AVANCADO|TRABALHO|SAMU|PEDAGIO|PESAGEM|GUARDA|MILITAR|TELEFONICO|DE SERVICO|DE APOIO|DE VENDA|MEDICO|ENFERMAGEM)\b/;
export const parecePosto = (estab) => { const n = norm(estab); return POSTO_SIM.test(n) && !POSTO_NAO.test(n); };

// ---------- cadastro bruto da ANP ----------
// Mesmo "endereco" montado por extrair-postos-anp.mjs, para casar com as linhas de postos-anp-geo.csv.
const limpa = (t) => (t || "").replace(/\s+/g, " ").trim();
const cepFmt = (t) => { const d = (t || "").replace(/\D/g, ""); return d ? d.padStart(8, "0").replace(/^(\d{5})(\d{3})$/, "$1-$2") : ""; };
export function lerAnpBruto() {
  const linhas = readFileSync(join(DIR, "dados-cadastrais-revendedores-varejistas-combustiveis-automoveis.csv"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  const cab = linhas[0].split(";"), ix = (n) => cab.indexOf(n);
  const I = Object.fromEntries(["CNPJ", "ENDERECO", "COMPLEMENTO", "BAIRRO", "CEP", "UF", "MUNICIPIO"].map((n) => [n, ix(n)]));
  const out = new Map();
  for (const l of linhas.slice(1)) {
    const r = l.split(";"); if (r.length !== cab.length) continue;
    const v = (n) => limpa(r[I[n]]);
    const rua0 = v("ENDERECO").replace(/\s*,\s*/g, ", ");
    const endereco = `${[rua0, v("COMPLEMENTO")].filter(Boolean).join(", ")} - ${[v("BAIRRO"), `${v("MUNICIPIO")} - ${v("UF")}`, cepFmt(r[I.CEP])].filter(Boolean).join(", ")}`;
    // ENDERECO = "RUA X, 500": o número é o último trecho
    const partes = rua0.split(", "), numTxt = partes.length > 1 ? partes.pop() : "";
    let num = /^\d+$/.test(numTxt.replace(/\D/g, "")) && !/KM/i.test(numTxt) ? String(+numTxt.replace(/\D/g, "")) : null;
    if (num === "0") num = null;
    let rua = partes.join(", ");
    const colado = rua.match(/^(.*\D)\s+(\d+)$/); // "RUA X 1635, 1635": tira o número colado ao nome
    if (colado && (colado[2] === num || String(+colado[2]) === num) && norm(colado[1]).split(" ").length >= 2) rua = colado[1];
    out.set(v("CNPJ").padStart(14, "0") + "|" + endereco, { rua, num, bairro: norm(v("BAIRRO")), cepd: cepFmt(r[I.CEP]).replace("-", "") });
  }
  return out;
}
