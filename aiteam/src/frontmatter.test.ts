import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFrontmatter } from "./frontmatter.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const crlf = (s: string) => s.replace(/\n/g, "\r\n");

// O tier-guard importa tier-core.mjs em node puro, sem tsx e sem garantia de
// aiteam/node_modules — e tier-core passa a importar este módulo. Mesmo
// invariante de shebang dos outros cores (o strip do vite-node deixa um CR
// órfão em checkout CRLF).
describe("frontmatter.mjs — carregável pelo hook em node puro", () => {
  const src = readFileSync(path.join(HERE, "frontmatter.mjs"), "utf8");

  it("não tem shebang", () => {
    expect(src.startsWith("#!")).toBe(false);
  });

  it("não importa nada", () => {
    expect(src).not.toMatch(/^\s*import\s/m);
  });
});

describe("extractFrontmatter — o único leitor do frontmatter do SPEC.md", () => {
  const SPEC = "---\nbudget_usd: 2.00\ntier_defaults:\n  allow_tier3: false\n---\n\n# Spec\n";

  it("devolve o bloco entre as cercas, sem elas", () => {
    expect(extractFrontmatter(SPEC)).toBe("budget_usd: 2.00\ntier_defaults:\n  allow_tier3: false");
  });

  // Windows com core.autocrlf=true grava o SPEC.md com CRLF no checkout. A
  // regex estrita (`^---\n...\n---`) não casava nunca e os leitores caíam no
  // default em silêncio (rb-ai-team#36).
  it("CRLF e LF devolvem o mesmo bloco", () => {
    expect(extractFrontmatter(crlf(SPEC))).toBe(extractFrontmatter(SPEC));
  });

  it("normaliza as quebras do bloco para LF, mesmo misturadas", () => {
    expect(extractFrontmatter("---\r\na: 1\nb: 2\r\n---\r\n")).toBe("a: 1\nb: 2");
  });

  // F9: o Set-Content -Encoding UTF8 do PowerShell 5 (e vários editores no Windows)
  // grava um BOM no início. Com ele a cerca de abertura deixava de ser o primeiro
  // texto e TODO leitor ignorava o arquivo em silêncio: o budget caía para o default,
  // o infra_kb ficava mudo (o doctor dizendo "sem host compartilhado, ok") e o
  // break-glass nunca valia.
  it("um BOM no início não esconde o frontmatter, em LF ou em CRLF", () => {
    expect(extractFrontmatter(`\uFEFF${SPEC}`)).toBe(extractFrontmatter(SPEC));
    expect(extractFrontmatter(`\uFEFF${crlf(SPEC)}`)).toBe(extractFrontmatter(SPEC));
  });

  it("o BOM só conta no início: um U+FEFF no meio do texto fica onde está", () => {
    expect(extractFrontmatter("---\na: \uFEFFb\n---\n")).toBe("a: \uFEFFb");
    expect(extractFrontmatter("# Spec\n\uFEFF---\na: 1\n---\n")).toBeNull();
  });

  // F20: o YAML lê o CR sozinho como quebra de linha (Mac antigo, editor que o gera, ou
  // um CR plantado), e o leitor por linhas só quebrava em LF: o que o YAML via como duas
  // linhas ele via como uma.
  it("quebras de linha só com CR valem como LF", () => {
    expect(extractFrontmatter("---\ra: 1\rb: 2\r---\r\rcorpo\r")).toBe("a: 1\nb: 2");
    expect(extractFrontmatter("---\r\na: 1\rb: 2\r\n---\r\n")).toBe("a: 1\nb: 2");
  });

  it("para na primeira cerca de fechamento", () => {
    expect(extractFrontmatter("---\na: 1\n---\ncorpo\n---\nb: 2\n")).toBe("a: 1");
  });

  it("só vale frontmatter no início do texto", () => {
    expect(extractFrontmatter("# Spec\n---\na: 1\n---\n")).toBeNull();
  });

  it("devolve null sem frontmatter, com texto vazio, null ou undefined", () => {
    expect(extractFrontmatter("# Só um título\n")).toBeNull();
    expect(extractFrontmatter("")).toBeNull();
    expect(extractFrontmatter(null)).toBeNull();
    expect(extractFrontmatter(undefined)).toBeNull();
  });
});
