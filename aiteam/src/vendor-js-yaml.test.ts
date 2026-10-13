import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CORE_SCHEMA, load } from "../vendor/js-yaml.mjs";

// O js-yaml vendorizado existe para os gates do .beads (hooks, CLIs, brief,
// guard) rodarem em node puro, sem aiteam/node_modules: worktree recém-criada,
// clone novo, máquina sem `npm install`. Uma cópia que diverge do pacote
// instalado é uma segunda versão do parser vivendo em silêncio — este teste
// é o que obriga a atualizar os dois juntos.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.resolve(HERE, "..", "vendor");
const require = createRequire(import.meta.url);
const PKG_DIR = path.dirname(require.resolve("js-yaml/package.json"));

const lf = (s: string) => s.replace(/\r\n/g, "\n");
// A única diferença admitida: a cópia não traz a linha `//# sourceMappingURL=`
// do build, porque o .map não vem junto e o vite reclamaria a cada import.
const semSourceMap = (s: string) => s.replace(/^\/\/# sourceMappingURL=.*$/m, "").trimEnd();
const vendored = lf(readFileSync(path.join(VENDOR, "js-yaml.mjs"), "utf8"));
const installed = lf(readFileSync(path.join(PKG_DIR, "dist", "js-yaml.mjs"), "utf8"));
const installedVersion = (JSON.parse(readFileSync(path.join(PKG_DIR, "package.json"), "utf8")) as { version: string })
  .version;

describe("js-yaml vendorizado — sem drift em relação ao pacote instalado", () => {
  it("a cópia é idêntica ao dist/js-yaml.mjs do pacote (em LF, sem a linha do source map)", () => {
    expect(semSourceMap(vendored) === semSourceMap(installed)).toBe(true);
  });

  it("a cópia não aponta para um source map que não foi copiado", () => {
    expect(vendored).not.toMatch(/sourceMappingURL/);
  });

  it("o banner da cópia traz a mesma versão do pacote instalado", () => {
    const m = /js-yaml (\d+\.\d+\.\d+)/.exec(vendored.slice(0, 200));
    expect(m?.[1]).toBe(installedVersion);
  });

  it("a licença MIT do upstream acompanha a cópia", () => {
    const license = lf(readFileSync(path.join(VENDOR, "js-yaml.LICENSE"), "utf8"));
    expect(license).toBe(lf(readFileSync(path.join(PKG_DIR, "LICENSE"), "utf8")));
    expect(license).toMatch(/MIT License/);
  });
});

describe("js-yaml vendorizado — autocontido", () => {
  // Um import ou require na cópia traria de volta a dependência de
  // node_modules que o vendor existe para eliminar.
  it("não importa nada", () => {
    expect(vendored).not.toMatch(/^\s*import\s/m);
    expect(vendored).not.toMatch(/\brequire\(\s*["']/);
  });

  it("carrega e faz parse com CORE_SCHEMA (timestamp continua texto)", () => {
    const doc = load('created_at: 2026-10-05T01:49:14Z\nn: 2.50\nok: true\n', { schema: CORE_SCHEMA }) as Record<
      string,
      unknown
    >;
    expect(doc["created_at"]).toBe("2026-10-05T01:49:14Z");
    expect(doc["n"]).toBe(2.5);
    expect(doc["ok"]).toBe(true);
  });
});
