import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { FRAMEWORK_SETTINGS, mergeSettings } from "./install-core.mjs";

// AITEAM_UPSTREAM=1 no `env` do .claude/settings.json desliga o ASK nas edições do código do próprio gate
// (aiteam/hooks, o fecho dos imports, aiteam/templates/tier-rules.json). Só o repo rb-ai-team a tem:
//  - o install NUNCA a escreve num consumidor (FRAMEWORK_SETTINGS não leva env);
//  - quem nasce do "Using This Repo as a Template" copia o settings.json inteiro, então o README manda tirá-la;
//  - o doctor avisa quando ela está ligada num repo que não é o rb-ai-team (doctor-core.test.ts).
// A prova de que um agente num consumidor não a liga sozinha está nos testes dos hooks (tier-guard-hook.test.ts
// e gate-edit-guard.test.ts): editar o env de um settings.json é editar o gate, e pede ASK.

const HERE = path.dirname(fileURLToPath(import.meta.url)); // aiteam/src
const AITEAM = path.resolve(HERE, "..");
const REPO = path.resolve(AITEAM, "..");

// O upstream é o único repo onde a raiz tem a variável. Num consumidor a suíte do aiteam/ roda também, e o
// settings.json é DELE: afirmar a variável lá falharia por uma propriedade do repo dele. O marcador do upstream
// é o manifesto do aiteam-sync — aqui é só teste, não segurança (o hook NÃO decide por ele).
const IS_UPSTREAM = existsSync(path.join(REPO, "tools", "aiteam-sync", "manifest.json"));

describe("FRAMEWORK_SETTINGS — o install nunca leva a AITEAM_UPSTREAM a um consumidor", () => {
  it("o objeto que o install escreve não tem a variável, nem uma chave env", () => {
    expect(JSON.stringify(FRAMEWORK_SETTINGS)).not.toContain("AITEAM_UPSTREAM");
    expect(Object.keys(FRAMEWORK_SETTINGS)).not.toContain("env");
  });

  it.each([
    ["um consumidor novo", {}],
    ["um consumidor com settings próprio sem env", { permissions: { allow: ["Bash(ls)"] } }],
    ["um consumidor com env próprio", { env: { MINHA: "1", OUTRA: "dois" } }],
  ])("mergeSettings sobre %s não cria a variável", (_what, host) => {
    const merged = mergeSettings(host, FRAMEWORK_SETTINGS) as { env?: Record<string, string> };
    expect(JSON.stringify(merged)).not.toContain("AITEAM_UPSTREAM");
    expect(merged.env).toEqual((host as { env?: Record<string, string> }).env);
  });

  it("o env do host passa intacto, e rodar de novo não muda nada", () => {
    const host = { env: { MINHA: "1" }, hooks: {} };
    const once = mergeSettings(host, FRAMEWORK_SETTINGS);
    expect((once as unknown as { env: unknown }).env).toEqual({ MINHA: "1" });
    expect(mergeSettings(once, FRAMEWORK_SETTINGS)).toEqual(once);
  });

  it("o install NÃO remove uma variável que o host trouxe (um template clonado): é por isso que o README e o doctor existem", () => {
    const host = { env: { AITEAM_UPSTREAM: "1" } };
    expect((mergeSettings(host, FRAMEWORK_SETTINGS) as unknown as { env: Record<string, string> }).env).toEqual({ AITEAM_UPSTREAM: "1" });
  });
});

describe.skipIf(!IS_UPSTREAM)("o settings.json do rb-ai-team (upstream)", () => {
  it('tem env.AITEAM_UPSTREAM = "1": é onde a isenção do guard vive', () => {
    const settings = JSON.parse(readFileSync(path.join(REPO, ".claude", "settings.json"), "utf8"));
    expect(settings.env?.AITEAM_UPSTREAM).toBe("1");
  });
});

// O README (EN e PT) manda, no passo do template, tirar a linha — e dá o comando. O comando roda de verdade.
describe("README — o passo do template tira a AITEAM_UPSTREAM do .claude/settings.json", () => {
  const readme = readFileSync(path.join(AITEAM, "README.md"), "utf8");
  const SECTIONS = [
    { lang: "EN", from: "## 🧬 Using This Repo as a Template for a New Project", to: "# Step 3" },
    { lang: "PT", from: "## 🧬 Usando Este Repositório como Template para um Novo Projeto", to: "# Passo 3" },
  ];

  it.each(SECTIONS)("$lang: a seção cita a variável, explica o porquê e traz o comando", ({ from, to }) => {
    const start = readme.indexOf(from);
    expect(start, from).toBeGreaterThan(-1);
    const section = readme.slice(start, readme.indexOf(to, start));
    expect(section).toContain("AITEAM_UPSTREAM");
    expect(section).toContain(".claude/settings.json");
    expect(section).toMatch(/node -e "[^\n]*AITEAM_UPSTREAM[^\n]*"/);
    expect(section).toMatch(/rb-ai-team/);
  });

  // O comando é o `node -e "…"` da seção EN; o da PT é o mesmo texto.
  const commandOf = (from: string, to: string): string => {
    const start = readme.indexOf(from);
    const section = readme.slice(start, readme.indexOf(to, start));
    return /node -e "([^\n]*AITEAM_UPSTREAM[^\n]*)"/.exec(section)![1]!;
  };

  const inProject = (settings: unknown, code: string): { text: string; parsed: Record<string, unknown> } => {
    const dir = mkdtempSync(path.join(tmpdir(), "upstream-flag-"));
    try {
      mkdirSync(path.join(dir, ".claude"));
      const file = path.join(dir, ".claude", "settings.json");
      writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
      const r = spawnSync(process.execPath, ["-e", code], { cwd: dir, encoding: "utf8" });
      expect(r.status, String(r.stderr)).toBe(0);
      const text = readFileSync(file, "utf8");
      return { text, parsed: JSON.parse(text) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it.each(SECTIONS)("$lang: o comando tira só a variável e deixa o resto do settings.json", ({ from, to }) => {
    const code = commandOf(from, to);
    const full = { permissions: { deny: ["Bash(x)"] }, worktree: { baseRef: "head" }, hooks: { PreToolUse: [] } };

    const only = inProject({ ...full, env: { AITEAM_UPSTREAM: "1" } }, code);
    expect(only.text).not.toContain("AITEAM_UPSTREAM");
    expect(only.parsed).toEqual(full); // o env vazio some junto
    expect(only.text.endsWith("\n")).toBe(true);

    const shared = inProject({ ...full, env: { AITEAM_UPSTREAM: "1", MINHA: "2" } }, code);
    expect(shared.parsed).toEqual({ ...full, env: { MINHA: "2" } });

    const none = inProject(full, code);
    expect(none.parsed).toEqual(full);
  });
});
