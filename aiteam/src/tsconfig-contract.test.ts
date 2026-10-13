import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `npm run typecheck` é `tsc --noEmit` e só vê o que o `include` do tsconfig
// lista. O mcp/ ficou de fora durante meses e acumulou erros de tipo que o CI
// nunca viu (o registry.ts, o servidor das tools de tier). Cada diretório de
// código do framework tem de estar no include.

const AITEAM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("tsconfig.json — o typecheck cobre o código do framework", () => {
  // Lido dentro do it, não no corpo do describe: o corpo roda na coleta, e um arquivo
  // que lança ali derruba o arquivo de teste inteiro.
  const tsconfig = () => JSON.parse(fs.readFileSync(path.join(AITEAM, "tsconfig.json"), "utf8")) as { include?: string[] };

  it.each(["src", "scripts", "mcp", "evals"])("%s/ está no include", (dir) => {
    expect(fs.existsSync(path.join(AITEAM, dir))).toBe(true);
    expect(tsconfig().include).toContain(`${dir}/**/*`);
  });
});
