import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { makeSandbox, rmTree, SLOW, type Sandbox } from "./beads-sandbox.js";

// Sem aiteam/node_modules (o toolchain), o pre-push cai num fallback em bash
// puro. Ele bloqueia todo force-push para main/master e NUNCA lê o SPEC.md: o
// allow_tier3 não o destrava. A mensagem mandava ligar essa flag, que ele não
// lê; o certo é mandar instalar o toolchain, de onde o break-glass passa a valer.

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "githooks").replace(/\\/g, "/");

let sb: Sandbox | undefined;
let remote: string | undefined;
afterEach(() => {
  sb?.cleanup();
  if (remote) rmTree(remote);
});

/** Um clone com o pre-push do framework e um remoto bare; o sandbox não tem o tsx, então o hook usa o fallback. */
function cloneWithHook(files: Record<string, string> = {}): Sandbox {
  sb = makeSandbox();
  const s = sb;
  for (const [rel, text] of Object.entries(files)) s.write(rel, text);
  remote = `${s.dir}-remote.git`;
  const init = spawnSync("git", ["init", "--bare", "-q", "-b", "main", remote], { env: s.env, encoding: "utf8" });
  expect(init.status, init.stderr).toBe(0);
  s.git("add", "-A");
  s.git("commit", "-q", "--no-verify", "-m", "base");
  s.git("remote", "add", "origin", remote);
  s.git("push", "-q", "origin", "main");
  s.git("config", "core.hooksPath", HOOKS);
  return s;
}

describe("pre-push — o fallback em bash puro (sem o toolchain)", () => {
  it("bloqueia o force-push para main, mesmo com allow_tier3 true, e manda instalar o toolchain", SLOW, () => {
    // A flag está ligada no SPEC.md, e o fallback não a lê: continua bloqueando.
    const s = cloneWithHook({ "SPEC.md": "---\nproject: x\ntier_defaults:\n  allow_tier3: true\n---\n" });
    s.git("commit", "-q", "--no-verify", "--amend", "-m", "reescrito");

    const r = s.gitTry("push", "--force", "origin", "main");

    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/Tier 3 \(critical\) blocked/);
    // A mensagem diz a verdade sobre a flag...
    expect(r.out).toMatch(/does not read SPEC\.md/);
    // ...e manda fazer o que funciona: instalar o toolchain.
    expect(r.out).toMatch(/toolchain/i);
    expect(r.out).toMatch(/npm install/);
    // Não a instrução que não funcionava: "ligue o allow_tier3 para permitir".
    expect(r.out).not.toMatch(/to permit it/);
  });

  it("deixa passar o que não é rewrite de branch protegida", SLOW, () => {
    const s = cloneWithHook();

    s.write("novo.txt", "x");
    s.git("add", "-A");
    s.git("commit", "-q", "--no-verify", "-m", "avanca");
    const ff = s.gitTry("push", "origin", "main");
    expect(ff.status, ff.out).toBe(0);

    s.git("checkout", "-q", "-b", "feat/x");
    s.git("push", "-q", "origin", "feat/x");
    s.git("commit", "-q", "--no-verify", "--amend", "-m", "reescrito");
    const rewrite = s.gitTry("push", "--force", "origin", "feat/x");
    expect(rewrite.status, rewrite.out).toBe(0);
  });
});
