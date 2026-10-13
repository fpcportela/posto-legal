// Extrai nome e endereço completo dos postos do cadastro de revendedores da ANP.
// Uso: node dados/extrair-postos-anp.mjs [entrada.csv] [saida.csv]
// Entrada: "dados-cadastrais-revendedores-varejistas-combustiveis-automoveis.csv"
// (UTF-8, separador ";"). A base não tem nome fantasia: o nome é a razão social.
import { readFileSync, writeFileSync } from "node:fs";

const entrada = process.argv[2] || "dados/dados-cadastrais-revendedores-varejistas-combustiveis-automoveis.csv";
const saida = process.argv[3] || "dados/postos-anp.csv";

const limpa = (t) => (t || "").replace(/\s+/g, " ").trim();
// A ANP grava o CEP como número: os que começam com 0 (SP, RJ, ES, MG) perdem o zero.
const cep = (t) => { const d = (t || "").replace(/\D/g, ""); return d ? d.padStart(8, "0").replace(/^(\d{5})(\d{3})$/, "$1-$2") : ""; };
const campo = (t) => (/[;"\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);

const linhas = readFileSync(entrada, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
const cab = linhas[0].split(";");
const col = (nome) => { const i = cab.indexOf(nome); if (i < 0) throw new Error(`coluna ${nome} não encontrada`); return i; };
const C = Object.fromEntries(["RAZAOSOCIAL", "CNPJ", "ENDERECO", "COMPLEMENTO", "BAIRRO", "CEP", "UF", "MUNICIPIO", "BANDEIRA"].map((n) => [n, col(n)]));

const postos = [];
for (const l of linhas.slice(1)) {
  const r = l.split(";");
  if (r.length !== cab.length) { console.warn("linha ignorada (campos):", l.slice(0, 80)); continue; }
  const v = (n) => limpa(r[C[n]]);
  // "RUA X, 500" + complemento + bairro + "CIDADE - UF" + CEP
  const rua = [v("ENDERECO").replace(/\s*,\s*/g, ", "), v("COMPLEMENTO")].filter(Boolean).join(", ");
  const local = [v("BAIRRO"), `${v("MUNICIPIO")} - ${v("UF")}`, cep(r[C.CEP])].filter(Boolean).join(", ");
  postos.push({ nome: v("RAZAOSOCIAL"), endereco: `${rua} - ${local}`, cnpj: v("CNPJ").padStart(14, "0"), bandeira: v("BANDEIRA"), municipio: v("MUNICIPIO"), uf: v("UF"), cep: cep(r[C.CEP]) });
}
postos.sort((a, b) => a.uf.localeCompare(b.uf) || a.municipio.localeCompare(b.municipio, "pt") || a.nome.localeCompare(b.nome, "pt"));

const cols = ["nome", "endereco", "cnpj", "bandeira", "municipio", "uf", "cep"];
const csv = [cols.join(";"), ...postos.map((p) => cols.map((c) => campo(p[c])).join(";"))].join("\r\n");
writeFileSync(saida, "﻿" + csv + "\r\n", "utf8"); // BOM: o Excel abre os acentos certo
console.log(`${postos.length} postos → ${saida}`);
