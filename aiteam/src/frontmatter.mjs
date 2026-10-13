// Leitor único do frontmatter YAML do SPEC.md — o bloco entre as duas cercas
// `---` no início do arquivo. Todo leitor do framework passa por aqui:
// allowTier3FromSpec (tier-core.mjs, que serve o tier-guard, o pre-push e as
// tools MCP), readBudget (circuit-breaker.ts) e readPointer/diagnosePointer
// (infra-kb-core.mjs).
//
// Existe porque três desses leitores tinham cada um a sua regex estrita,
// `^---\n...\n---`, que não casa nunca com CRLF. No Windows com
// core.autocrlf=true o git grava o SPEC.md com CRLF no checkout, e os três
// caíam no default sem aviso: o break-glass allow_tier3 virava `false` e o
// budget_usd do SPEC era ignorado (rb-ai-team#36).
//
// Duas outras formas do mesmo defeito, fechadas aqui: um BOM no início (o
// Set-Content -Encoding UTF8 do PowerShell 5 o grava) deixava a cerca de abertura
// de ser o primeiro texto, e todo leitor ignorava o arquivo inteiro — o budget caía
// para o default, o infra_kb ficava mudo com o doctor dizendo "ok"; e uma quebra de
// linha só com CR, que o YAML lê como quebra e o leitor por linhas não.
//
// Sem dependências e sem shebang: tier-core.mjs importa este módulo, e o
// tier-guard o carrega em node puro, sem tsx e sem garantia de
// aiteam/node_modules; o shebang quebraria o import sob vite-node num
// checkout CRLF (ver tier-core.mjs/tier-guard.mjs).

const BOM = /^\uFEFF/;
const FRONTMATTER = /^---\n([\s\S]*?)\n---/;

/**
 * O frontmatter do início do texto, sem as cercas e com as quebras de linha
 * normalizadas para LF — CRLF, LF e CR sozinho dão o mesmo resultado, e um BOM no
 * início é descartado.
 * @param {string|null|undefined} text
 * @returns {string|null} null quando o texto não abre com um frontmatter
 */
export function extractFrontmatter(text) {
  const normalized = String(text ?? "").replace(BOM, "").replace(/\r\n?/g, "\n");
  const m = FRONTMATTER.exec(normalized);
  return m ? m[1] : null;
}
