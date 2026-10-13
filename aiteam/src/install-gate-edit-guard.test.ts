import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { makeSandbox, SLOW, type Sandbox } from "./beads-sandbox.js";

// O install.mjs roda como subprocesso num repo descartável, como o consumidor o vê (o mesmo desenho do
// install-tier-rules.test.ts). F13: o hook que pede confirmação na edição dos arquivos do gate tem de
// chegar ao .claude/settings.json de um consumidor — o novo e o instalado antes — e ficar de pé.

const SETTINGS = ".claude/settings.json";
const GUARD = "node aiteam/hooks/gate-edit-guard.mjs";
const MATCHER = "Write|Edit|MultiEdit|NotebookEdit";

let sb: Sandbox | undefined;
const sandbox = (): Sandbox => {
  sb = makeSandbox();
  return sb;
};
afterEach(() => sb?.cleanup());

type Entry = { matcher?: string; hooks?: Array<{ command?: string }> };
const guardEntries = (settingsText: string): Entry[] =>
  ((JSON.parse(settingsText).hooks?.PreToolUse ?? []) as Entry[]).filter((e) => (e.hooks ?? []).some((h) => h.command === GUARD));

describe("install.mjs — propaga o gate-edit-guard (F13)", () => {
  it("adotante novo: o settings.json nasce com a entrada, e rodar de novo não a duplica", SLOW, () => {
    const s = sandbox();
    const first = s.node("install.mjs");
    expect(first.status, first.out).toBe(0);
    const entries = guardEntries(s.read(SETTINGS));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.matcher).toBe(MATCHER);

    const again = s.node("install.mjs");
    expect(again.status, again.out).toBe(0);
    expect(guardEntries(s.read(SETTINGS))).toHaveLength(1);
  });

  it("consumidor instalado antes (sem a entrada): ganha-a sem perder as suas", SLOW, () => {
    const s = sandbox();
    const legacy = {
      permissions: { deny: ["Bash(minha-regra:*)"] },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node aiteam/hooks/tier-guard.mjs" }] }, { matcher: "Read", hooks: [{ type: "command", command: "meu-hook" }] }] },
    };
    s.write(SETTINGS, `${JSON.stringify(legacy, null, 2)}\n`);

    const r = s.node("install.mjs");
    expect(r.status, r.out).toBe(0);
    const text = s.read(SETTINGS);
    expect(guardEntries(text)).toHaveLength(1);
    const parsed = JSON.parse(text);
    expect(parsed.permissions.deny).toContain("Bash(minha-regra:*)");
    const commands = (parsed.hooks.PreToolUse as Entry[]).flatMap((e) => (e.hooks ?? []).map((h) => h.command));
    expect(commands).toContain("meu-hook");
    expect(commands).toContain("node aiteam/hooks/tier-guard.mjs");
  });

  // A isenção do ASK no código do gate (AITEAM_UPSTREAM no env do settings) é só do rb-ai-team.
  it("o install nunca escreve a AITEAM_UPSTREAM num consumidor, novo ou antigo, e preserva o env dele", SLOW, () => {
    const fresh = sandbox();
    expect(fresh.node("install.mjs").status).toBe(0);
    expect(fresh.read(SETTINGS)).not.toContain("AITEAM_UPSTREAM");
    expect(JSON.parse(fresh.read(SETTINGS)).env).toBeUndefined();
    fresh.cleanup();

    const own = sandbox();
    own.write(SETTINGS, `${JSON.stringify({ env: { MINHA: "1" } }, null, 2)}\n`);
    expect(own.node("install.mjs").status).toBe(0);
    const parsed = JSON.parse(own.read(SETTINGS));
    expect(parsed.env).toEqual({ MINHA: "1" });
    expect(own.read(SETTINGS)).not.toContain("AITEAM_UPSTREAM");
  });

  // O install só ADICIONA o que é do framework e nunca remove chave do host: a que um template trouxe fica, e
  // quem a vê é o README (manda tirá-la) e o doctor (WARN, doctor-core.test.ts e doctor-io.test.ts).
  it("um projeto que herdou a variável do template: o install a deixa onde está", SLOW, () => {
    const s = sandbox();
    s.write(SETTINGS, `${JSON.stringify({ env: { AITEAM_UPSTREAM: "1" } }, null, 2)}\n`);
    expect(s.node("install.mjs").status).toBe(0);
    expect(JSON.parse(s.read(SETTINGS)).env).toEqual({ AITEAM_UPSTREAM: "1" });
  });

  it("o hook que o install registra existe no vendor e responde: ask na edição do tier-rules.json", SLOW, () => {
    const s = sandbox();
    expect(s.node("install.mjs").status).toBe(0);
    expect(s.exists("aiteam/hooks/gate-edit-guard.mjs")).toBe(true);
    expect(s.exists("aiteam/src/gate-files-core.mjs")).toBe(true);
    const r = spawnSync(process.execPath, [path.join(s.dir, "aiteam", "hooks", "gate-edit-guard.mjs")], {
      input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: ".claude/tier-rules.json", content: "{}" } }),
      cwd: s.dir,
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(r.status, String(r.stderr)).toBe(0);
    expect(JSON.parse(String(r.stdout)).hookSpecificOutput.permissionDecision).toBe("ask");
  });
});
