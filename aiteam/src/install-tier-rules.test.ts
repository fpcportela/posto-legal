import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { makeSandbox, SLOW, type Sandbox } from "./beads-sandbox.js";

// O install.mjs roda como subprocesso num repo descartável, como o consumidor o
// vê. O .claude/tier-rules.json fica fora de aiteam/ e não viaja com o vendor;
// sem ele o guard não teria regras do projeto. O install o semeia a partir de
// aiteam/templates/tier-rules.json.

const TEMPLATE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "tier-rules.json");
// O sandbox copia o framework com LF; um checkout CRLF não muda o que se compara.
const TEMPLATE = fs.readFileSync(TEMPLATE_PATH, "utf8").replace(/\r\n/g, "\n");
const RULES = ".claude/tier-rules.json";

let sb: Sandbox | undefined;
const sandbox = (): Sandbox => {
  sb = makeSandbox();
  return sb;
};
afterEach(() => sb?.cleanup());

describe("install.mjs — semeia o .claude/tier-rules.json", () => {
  it("adotante novo: cria o arquivo a partir do template, diz que criou e é idempotente", SLOW, () => {
    const s = sandbox();
    expect(s.exists(RULES)).toBe(false);

    const first = s.node("install.mjs");
    expect(first.status, first.out).toBe(0);
    expect(first.out).toMatch(/tier-rules\.json/);
    expect(s.read(RULES)).toBe(TEMPLATE);

    const again = s.node("install.mjs");
    expect(again.status, again.out).toBe(0);
    expect(again.out).toMatch(/already installed|nothing to change/);
    expect(s.read(RULES)).toBe(TEMPLATE);
  });

  it("nunca sobrescreve o arquivo do projeto, customizado", SLOW, () => {
    const s = sandbox();
    const custom = JSON.stringify({ tier3: { patterns: ["\\bmeu-deploy\\b"] }, tier2: { patterns: [] } }, null, 2) + "\n";
    s.write(RULES, custom);

    const r = s.node("install.mjs");
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toMatch(/tier-rules\.json/);
    expect(s.read(RULES)).toBe(custom);
  });

  // Quebrado também é do projeto: quem conserta é o dono. O guard protege pela
  // cópia canônica enquanto isso, e o doctor reprova.
  it("nunca sobrescreve nem o arquivo ilegível", SLOW, () => {
    const s = sandbox();
    s.write(RULES, "{ não é json");

    expect(s.node("install.mjs").status).toBe(0);

    expect(s.read(RULES)).toBe("{ não é json");
  });

  it("--dry-run mostra o que faria e não escreve", SLOW, () => {
    const s = sandbox();

    const r = s.node("install.mjs", ["--dry-run"]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/would:.*tier-rules\.json/);
    expect(s.exists(RULES)).toBe(false);
  });

  it("vendor sem o template: avisa, não cria arquivo nenhum e o install segue", SLOW, () => {
    const s = sandbox();
    s.remove("aiteam/templates/tier-rules.json");

    const r = s.node("install.mjs");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/templates\/tier-rules\.json/);
    expect(s.exists(RULES)).toBe(false);
  });
});
