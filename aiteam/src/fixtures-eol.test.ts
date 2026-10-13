import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { isUpstream, repoRoot } from "./repo-root.js";

// As fixtures dos testes são comparadas com .replace() de trechos multilinha
// ("status: pending\n    effort: M"), que não casam em CRLF. Num checkout novo no
// Windows (clone, git worktree add) o autocrlf as gravava em CRLF e o
// beads-migrate.test.ts quebrava. A regra mora num .gitattributes DENTRO de
// aiteam/src/__fixtures__/ — e não no da raiz — porque os consumidores
// vendorizam esses testes e só a pasta aiteam/ viaja com o sync: o .gitattributes
// raiz do consumidor é dele.
describe("fixtures dos testes ficam em LF em qualquer checkout", () => {
  const root = repoRoot();
  const fixtures = path.join(root, "aiteam", "src", "__fixtures__");

  it("aiteam/src/__fixtures__/.gitattributes manda text eol=lf para tudo", () => {
    const rules = fs
      .readFileSync(path.join(fixtures, ".gitattributes"), "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"));
    expect(rules).toContain("* text eol=lf");
  });

  // Só no upstream: o .gitattributes da raiz de um consumidor é dele (o cabeçalho
  // acima), pode nem existir, e não é o framework que o confere.
  it.skipIf(!isUpstream())("o .gitattributes da raiz não repete a regra (viaja a da pasta)", () => {
    const rootRules = fs.readFileSync(path.join(root, ".gitattributes"), "utf8");
    expect(rootRules).not.toMatch(/__fixtures__/);
  });

  it("o git aplica eol=lf às fixtures, pela regra da pasta", () => {
    const r = spawnSync(
      "git",
      ["check-attr", "text", "eol", "--", "aiteam/src/__fixtures__/beads-legacy/active.yaml", "aiteam/src/__fixtures__/infra-kb-readme.md"],
      { cwd: root, encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split(/\r?\n/);
    expect(lines).toContain("aiteam/src/__fixtures__/beads-legacy/active.yaml: text: set");
    expect(lines).toContain("aiteam/src/__fixtures__/beads-legacy/active.yaml: eol: lf");
    expect(lines).toContain("aiteam/src/__fixtures__/infra-kb-readme.md: eol: lf");
  });

  it("as fixtures desta cópia de trabalho estão em LF", () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name !== ".gitattributes") files.push(p);
      }
    };
    walk(fixtures);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(fs.readFileSync(f, "utf8").includes("\r"), path.relative(root, f)).toBe(false);
    }
  });
});
