// Baixa o CNEFE do Censo 2022 (IBGE), UF por UF, e guarda só o que interessa aos postos da ANP.
// Uso: node dados/baixar-cnefe.mjs [--refazer] [UF ...]      (ex.: node dados/baixar-cnefe.mjs AC RR)
// Cache em ~/.cache/posto-legal/cnefe (FORA do projeto: o Drive não sincroniza GBs). Por UF: baixa o zip,
// lê em fluxo (unzip -p, sem extrair o CSV), grava <UF>.tsv.gz com as linhas úteis e apaga o zip.
// Idempotente: UF que já tem extrato é pulada. Linhas guardadas (NV_GEO_COORD <= 4):
//   C = CEP específico (não termina em 000) de algum posto da UF; R = rua com o mesmo nome de rua de algum posto da UF;
//   P = COD_ESPECIE 6 com nome de posto de combustível.
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { createGzip } from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { CACHE, DIR, UFS, digitos, lerAnpBruto, parseCsv, ruaChave, parecePosto } from "./cnefe-comum.mjs";
import { readFileSync } from "node:fs";

const BASE = "https://ftp.ibge.gov.br/Cadastro_Nacional_de_Enderecos_para_Fins_Estatisticos/Censo_Demografico_2022/Arquivos_CNEFE/CSV/UF/";
const UA = "PostoLegal/0.1 (fabioportelacarvalho@gmail.com)";
const args = process.argv.slice(2), REFAZER = args.includes("--refazer");
const so = args.filter((a) => /^[A-Za-z]{2}$/.test(a)).map((a) => a.toUpperCase());
mkdirSync(CACHE, { recursive: true });

// alvos por UF: CEPs específicos e chaves de rua dos postos da ANP
const alvo = {};
const bruto = lerAnpBruto();
{
  const geo = parseCsv(readFileSync(join(DIR, "postos-anp-geo.csv"), "utf8")), C = Object.fromEntries(geo[0].map((n, i) => [n, i]));
  for (const r of geo.slice(1)) {
    const b = bruto.get(r[C.cnpj] + "|" + r[C.endereco]); if (!b) continue;
    const a = (alvo[r[C.uf]] ||= { ceps: new Set(), ruas: new Set() });
    const cep = digitos(r[C.cep]); if (cep.length === 8 && !cep.endsWith("000")) a.ceps.add(cep);
    const k = ruaChave(b.rua); if (k) a.ruas.add(k);
  }
}

function baixa(url, dest) {
  for (let t = 1; t <= 8; t++) {
    const r = spawnSync("curl", ["-sS", "-L", "--fail", "-C", "-", "-A", UA, "-o", dest, url], { stdio: ["ignore", "inherit", "inherit"] });
    if (r.status === 0) return;
    console.warn(`  curl falhou (${r.status}), tentativa ${t}/8, espera 20 s`);
    spawnSync(process.platform === "win32" ? "timeout" : "sleep", process.platform === "win32" ? ["/t", "20", "/nobreak"] : ["20"], { stdio: "ignore", shell: true });
  }
  throw new Error("download falhou: " + url);
}

async function extrai(uf, zip, saida) {
  const { ceps, ruas } = alvo[uf] || { ceps: new Set(), ruas: new Set() };
  let proc = spawn("unzip", ["-p", zip], { stdio: ["ignore", "pipe", "inherit"] });
  proc.on("error", () => {});
  const gz = createGzip({ level: 6 }), fs = createWriteStream(saida + ".tmp");
  gz.pipe(fs);
  const cacheRua = new Map();
  let resto = "", total = 0, guardadas = 0, cab = true;
  const buf = [];
  const flush = async () => { if (buf.length) { if (!gz.write(buf.join(""))) await once(gz, "drain"); buf.length = 0; } };
  const linha = (l) => {
    if (cab) { cab = false; return; }
    total++;
    const f = l.split(";");
    const nv = f[27]; if (nv === "" || nv > "4") return;
    let flag = "";
    if (f[28] === "6" && parecePosto(f[29])) flag += "P";
    if (ceps.has(f[8])) flag += "C";
    const chaveTxt = f[10] + " " + f[11] + " " + f[12];
    let k = cacheRua.get(chaveTxt); if (k === undefined) { k = ruaChave(chaveTxt); cacheRua.set(chaveTxt, k); }
    if (k && ruas.has(k)) flag += "R";
    if (!flag) return;
    guardadas++;
    // cep cod_mun localidade tipo titulo nome num modificador lat lon nv especie estab flag
    buf.push([f[8], f[2], f[9], f[10], f[11], f[12], f[13], f[14], f[25], f[26], nv, f[28], f[29], flag].join("\t") + "\n");
  };
  for await (const chunk of proc.stdout) {
    const txt = resto + chunk.toString("latin1");
    const ls = txt.split("\n"); resto = ls.pop();
    for (const l of ls) linha(l.endsWith("\r") ? l.slice(0, -1) : l);
    if (buf.length > 5000) await flush();
  }
  if (resto) linha(resto.replace(/\r$/, ""));
  const [code] = await once(proc, "close").catch(() => [0]);
  await flush(); gz.end(); await once(fs, "close");
  if (code) { rmSync(saida + ".tmp", { force: true }); throw new Error(`unzip saiu com ${code} (UF ${uf})`); }
  renameSync(saida + ".tmp", saida);
  return { total, guardadas };
}

for (const cod of Object.keys(UFS).sort((a, b) => a - b)) {
  const uf = UFS[cod], nome = `${cod}_${uf}`;
  if (so.length && !so.includes(uf)) continue;
  const saida = join(CACHE, `${uf}.tsv.gz`);
  if (existsSync(saida) && !REFAZER) { console.log(`${uf}: extrato já existe (${(statSync(saida).size / 1e6).toFixed(1)} MB), pulando`); continue; }
  const zip = join(CACHE, `${nome}.zip`), t0 = Date.now();
  console.log(`${uf}: baixando ${nome}.zip ...`);
  baixa(BASE + nome + ".zip", zip);
  console.log(`${uf}: ${(statSync(zip).size / 1e6).toFixed(0)} MB baixados em ${((Date.now() - t0) / 1000).toFixed(0)} s, filtrando...`);
  const r = await extrai(uf, zip, saida);
  rmSync(zip, { force: true });
  console.log(`${uf}: ${r.guardadas} de ${r.total} linhas guardadas -> ${uf}.tsv.gz (${(statSync(saida).size / 1e6).toFixed(1)} MB), ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
