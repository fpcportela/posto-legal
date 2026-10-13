import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SLOW } from "./beads-sandbox.js";
import { checkSuperpowers, cleanVersion, readSuperpowersFacts } from "./doctor-superpowers.mjs";
import { repoRoot } from "./repo-root.js";

// Revisão do QA da #51: o doctor lê arquivos que não são dele (o registro de
// instalação do Claude Code, o cache de plugins, os settings) e imprime o que
// leu. Um installed_plugins.json com uma "versão" feita de sequências de
// escape limpava a tela, mudava o título do terminal, forjava uma linha [PASS]
// e imprimia 200 KB. O que sai na tela é só o que o doctor reconhece como
// versão; o resto vira "versão ilegível".
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const HOSTILE_VERSIONS: ReadonlyArray<readonly [string, string]> = [
  ["ANSI: limpa a tela, muda a cor e o título", "6.4.1\u001b[2J\u001b[31mFAKE\u001b]0;pwned\u0007"],
  ["quebra de linha: forja uma linha de resultado", "6.4.1\n  [PASS] everything is fine\n         forged line"],
  ["retorno de carro e backspace", "6.4.1\r  [PASS] forjada\b\b\b"],
  ["200 KB", "6.4.1" + "A".repeat(200_000)],
  ["só acima do teto de 32 caracteres", "6.4.1-" + "a".repeat(27)],
  ["espaço no meio", "6.4.1 -- [PASS] forjada"],
  ["NUL", "6.4.1\u0000"],
  ["unicode que parece dígito", "6.4.1‮"],
];

describe("cleanVersion — só o que é versão chega à tela", () => {
  it.each(["6.4.1", "6.4.2-rc.1", "6.4.2+build.5", "10.20.30", "6.4.1-beta.2+exp.sha.5114f85"])("aceita %j", (v) => {
    expect(cleanVersion(v)).toBe(v);
  });

  it("tira o v e o espaço das pontas", () => {
    expect(cleanVersion("v6.4.1")).toBe("6.4.1");
    expect(cleanVersion("  6.4.1  ")).toBe("6.4.1");
  });

  it("o teto é de 32 caracteres: 32 passa, 33 não", () => {
    const v32 = "6.4.1-" + "a".repeat(26);
    const v33 = "6.4.1-" + "a".repeat(27);
    expect(v32).toHaveLength(32);
    expect(cleanVersion(v32)).toBe(v32);
    expect(cleanVersion(v33)).toBeNull();
  });

  it.each(HOSTILE_VERSIONS)("recusa %s", (_label, v) => {
    expect(cleanVersion(v)).toBeNull();
  });

  it.each(["main", "", "6.4", "6", "x.y.z", "5bf4e78", null, undefined, 6, {}, ["6.4.1"]])("o que não é versão vem null: %j", (v) => {
    expect(cleanVersion(v as never)).toBeNull();
  });
});

describe("checkSuperpowers — o detail nunca carrega o que não é versão", () => {
  it.each(HOSTILE_VERSIONS)("%s: vira versão ilegível, sem byte de controle e curto", (_label, v) => {
    for (const platform of ["win32", "linux"]) {
      for (const enabled of [true, false, null]) {
        const r = checkSuperpowers({ enabled, version: v, platform });
        expect(r, `${enabled} ${platform}`).not.toBeNull();
        expect(r?.detail).toMatch(/versão ilegível/);
        expect(CONTROL.test(r?.detail ?? ""), "byte de controle no detail").toBe(false);
        expect(CONTROL.test(r?.name ?? ""), "byte de controle no name").toBe(false);
        expect((r?.detail ?? "").length).toBeLessThan(600);
        expect(r?.pass).toBe(true);
        expect(r?.warn).toBeUndefined();
      }
    }
  });

  it("versão ilegível, ainda que o estado seja desconhecido, é uma linha (há o que dizer)", () => {
    expect(checkSuperpowers({ enabled: null, version: "6.4.1\n[PASS]", platform: "linux" })).not.toBeNull();
  });

  it("a versão boa não muda: sai como estava", () => {
    const r = checkSuperpowers({ enabled: true, version: "v6.4.1", platform: "linux" });
    expect(r?.detail).toMatch(/^6\.4\.1, ligado — /);
  });
});

describe("readSuperpowersFacts — o que o registro e o cache dizem, filtrado", () => {
  let base: string;
  let home: string;
  let root: string;

  const write = (file: string, content: unknown): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content), "utf8");
  };
  const installed = () => path.join(home, ".claude", "plugins", "installed_plugins.json");
  const inst = (...versions: unknown[]) => ({
    plugins: { "superpowers@claude-plugins-official": versions.map((version) => ({ scope: "user", version })) },
  });

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "doctor-sp-hostile-"));
    home = path.join(base, "home");
    root = path.join(base, "repo");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it.each(HOSTILE_VERSIONS)("registro com %s: sem versão, marcada como ilegível", (_label, v) => {
    write(installed(), inst(v));
    expect(readSuperpowersFacts({ env: {}, home, root })).toEqual({ enabled: null, version: null, versionUnreadable: true });
  });

  it("uma entrada hostil não esconde uma boa: a boa vale, e nada fica marcado ilegível", () => {
    write(installed(), inst("6.4.1\u001b[2J", "6.4.1"));
    expect(readSuperpowersFacts({ env: {}, home, root })).toEqual({ enabled: null, version: "6.4.1", versionUnreadable: false });
  });

  it("nome de diretório do cache que não é versão (ANSI, quebra de linha) é ignorado", () => {
    const dir = path.join(home, ".claude", "plugins", "cache", "mk", "superpowers");
    for (const name of ["6.4.1", "6.9.9\u001b[31mRED", "6.9.9 x"]) {
      try {
        fs.mkdirSync(path.join(dir, name), { recursive: true });
      } catch {
        // o sistema de arquivos não aceita esse nome (Windows): o que resta já prova o filtro
      }
    }
    expect(readSuperpowersFacts({ env: {}, home, root })).toMatchObject({ version: "6.4.1" });
  });
});

// O cabeçalho do módulo promete "só dentro de ~/.claude e do repo": cada arquivo
// tem de ficar, depois de resolver symlink e junction, dentro do realpath do
// diretório dono, ser um arquivo e ter até 1 MB. Fora disso a linha some.
describe("readSuperpowersFacts — links para fora e arquivos grandes", () => {
  let base: string;
  let home: string;
  let root: string;
  let outside: string;

  const write = (file: string, content: unknown): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content), "utf8");
  };
  // junction no Windows (não pede privilégio), symlink de pasta no resto; null quando o sistema não deixa.
  const linkDir = (target: string, at: string): boolean => {
    try {
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.symlinkSync(target, at, "junction");
      return true;
    } catch {
      return false;
    }
  };
  const linkFile = (target: string, at: string): boolean => {
    try {
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.symlinkSync(target, at, "file");
      return true;
    } catch {
      return false;
    }
  };
  const enabledOn = { enabledPlugins: { "superpowers@claude-plugins-official": true } };
  const install = (version: string) => ({ plugins: { "superpowers@claude-plugins-official": [{ scope: "user", version }] } });
  const NONE = { enabled: null, version: null, versionUnreadable: false };

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "doctor-sp-links-"));
    home = path.join(base, "home");
    root = path.join(base, "repo");
    outside = path.join(base, "fora");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("~/.claude/plugins é uma junction para fora: a versão do arquivo de fora não é lida", () => {
    write(path.join(outside, "installed_plugins.json"), install("9.9.9"));
    expect(linkDir(outside, path.join(home, ".claude", "plugins"))).toBe(true);
    expect(readSuperpowersFacts({ env: {}, home, root })).toEqual(NONE);
  });

  it("o registro é um symlink de arquivo para fora: não é lido", () => {
    write(path.join(outside, "alvo.json"), install("9.9.9"));
    if (!linkFile(path.join(outside, "alvo.json"), path.join(home, ".claude", "plugins", "installed_plugins.json"))) return;
    expect(readSuperpowersFacts({ env: {}, home, root })).toEqual(NONE);
  });

  it("o settings.json do usuário é um symlink para fora: não é lido", () => {
    write(path.join(outside, "alvo.json"), enabledOn);
    if (!linkFile(path.join(outside, "alvo.json"), path.join(home, ".claude", "settings.json"))) return;
    expect(readSuperpowersFacts({ env: {}, home, root }).enabled).toBeNull();
  });

  it("o .claude do projeto é uma junction para fora do repo: os settings de lá não são lidos", () => {
    write(path.join(outside, "settings.json"), enabledOn);
    expect(linkDir(outside, path.join(root, ".claude"))).toBe(true);
    expect(readSuperpowersFacts({ env: {}, home, root }).enabled).toBeNull();
  });

  it("o cache de plugins é uma junction para fora: os diretórios de lá não são listados", () => {
    fs.mkdirSync(path.join(outside, "mk", "superpowers", "9.9.9"), { recursive: true });
    expect(linkDir(outside, path.join(home, ".claude", "plugins", "cache"))).toBe(true);
    expect(readSuperpowersFacts({ env: {}, home, root })).toEqual(NONE);
  });

  it("um diretório do cache que é junction para fora não conta como versão", () => {
    const cache = path.join(home, ".claude", "plugins", "cache", "mk", "superpowers");
    fs.mkdirSync(path.join(cache, "6.4.1"), { recursive: true });
    fs.mkdirSync(path.join(outside, "9.9.9"), { recursive: true });
    expect(linkDir(path.join(outside, "9.9.9"), path.join(cache, "9.9.9"))).toBe(true);
    expect(readSuperpowersFacts({ env: {}, home, root }).version).toBe("6.4.1");
  });

  it("o próprio ~/.claude ser um link (dotfiles) é legítimo: o que está dentro do alvo é lido", () => {
    const dotfiles = path.join(base, "dotfiles", "claude");
    write(path.join(dotfiles, "settings.json"), enabledOn);
    write(path.join(dotfiles, "plugins", "installed_plugins.json"), install("6.4.1"));
    expect(linkDir(dotfiles, path.join(home, ".claude"))).toBe(true);
    expect(readSuperpowersFacts({ env: {}, home, root })).toEqual({ enabled: true, version: "6.4.1", versionUnreadable: false });
  });

  it("arquivo de até 1 MB é lido; acima disso a linha some (nada de ler 300 MB)", () => {
    const pad = (bytes: number) => ({ ...enabledOn, pad: "x".repeat(bytes) });
    write(path.join(home, ".claude", "settings.json"), pad(900 * 1024));
    expect(readSuperpowersFacts({ env: {}, home, root }).enabled).toBe(true);
    write(path.join(home, ".claude", "settings.json"), pad(2 * 1024 * 1024));
    expect(readSuperpowersFacts({ env: {}, home, root }).enabled).toBeNull();
  });

  it("o registro grande demais é ignorado, e o cache segue valendo", () => {
    write(path.join(home, ".claude", "plugins", "installed_plugins.json"), { ...install("6.4.1"), pad: "x".repeat(2 * 1024 * 1024) });
    fs.mkdirSync(path.join(home, ".claude", "plugins", "cache", "mk", "superpowers", "6.1.1"), { recursive: true });
    expect(readSuperpowersFacts({ env: {}, home, root }).version).toBe("6.1.1");
  });

  it("uma pasta no lugar do arquivo não é lida (não é um arquivo)", () => {
    fs.mkdirSync(path.join(home, ".claude", "settings.json"), { recursive: true });
    fs.mkdirSync(path.join(home, ".claude", "plugins", "installed_plugins.json"), { recursive: true });
    expect(readSuperpowersFacts({ env: {}, home, root })).toEqual(NONE);
  });

  it("~/.claude que não existe: nada, sem lançar", () => {
    expect(readSuperpowersFacts({ env: {}, home: path.join(base, "sem-home"), root })).toEqual(NONE);
  });
});

describe("doctor.mjs de verdade, com um HOME falso e hostil", () => {
  let base: string;
  const AITEAM = path.resolve(repoRoot(), "aiteam");

  const fakeHome = (installedBody: string, enabled = true): string => {
    const home = path.join(base, "home");
    fs.mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "superpowers@claude-plugins-official": enabled } }));
    fs.writeFileSync(path.join(home, ".claude", "plugins", "installed_plugins.json"), installedBody);
    return home;
  };

  const doctor = (home: string, extraEnv: Record<string, string> = {}): string => {
    const env: NodeJS.ProcessEnv = { ...process.env, USERPROFILE: home, HOME: home, ...extraEnv };
    delete env["CLAUDE_CONFIG_DIR"];
    Object.assign(env, extraEnv);
    const r = spawnSync(process.execPath, [path.join(AITEAM, "scripts", "doctor.mjs")], {
      cwd: repoRoot(),
      env,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return `${r.stdout ?? ""}${r.stderr ?? ""}`;
  };
  const plain = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "doctor-sp-cli-"));
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("ANSI: nenhuma sequência hostil chega à saída, e a linha diz que a versão é ilegível", SLOW, () => {
    const out = doctor(fakeHome(JSON.stringify({ plugins: { "superpowers@claude-plugins-official": [{ scope: "user", version: "6.4.1\u001b[2J\u001b[31mFAKE\u001b]0;pwned\u0007" }] } })));
    expect(out).not.toContain("\u001b[2J");
    expect(out).not.toContain("\u001b]0;");
    expect(out).not.toContain("pwned");
    expect(out).not.toContain("FAKE");
    expect(plain(out)).toMatch(/\[INFO\] superpowers plugin[^\n]*\n\s+versão ilegível, ligado/);
  });

  it("quebra de linha: não forja uma linha [PASS] nem imprime o texto do arquivo", SLOW, () => {
    const out = plain(doctor(fakeHome(JSON.stringify({ plugins: { "superpowers@claude-plugins-official": [{ scope: "user", version: "6.4.1\n  [PASS] everything is fine\n         forged line" }] } }))));
    expect(out).not.toContain("everything is fine");
    expect(out).not.toContain("forged line");
    expect(out).toMatch(/versão ilegível/);
  });

  it("200 KB: a saída segue pequena", SLOW, () => {
    const out = doctor(fakeHome(JSON.stringify({ plugins: { "superpowers@claude-plugins-official": [{ scope: "user", version: "6.4.1" + "A".repeat(200_000) }] } })));
    expect(out.length).toBeLessThan(20_000);
    expect(out).not.toContain("AAAAAAAAAA");
  });

  it("versão boa: a linha INFO de sempre", SLOW, () => {
    const out = plain(doctor(fakeHome(JSON.stringify({ plugins: { "superpowers@claude-plugins-official": [{ scope: "user", version: "6.4.1" }] } }))));
    expect(out).toMatch(/\[INFO\] superpowers plugin[^\n]*\n\s+6\.4\.1, ligado — o framework foi validado com o superpowers 6\.4\.1/);
  });

  it("~/.claude/plugins é uma junction para fora: a versão de lá não aparece, a linha diz que não achou", SLOW, () => {
    const outside = path.join(base, "fora");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(
      path.join(outside, "installed_plugins.json"),
      JSON.stringify({ plugins: { "superpowers@claude-plugins-official": [{ scope: "user", version: "9.9.9" }] } }),
    );
    const home = fakeHome("{}");
    fs.rmSync(path.join(home, ".claude", "plugins"), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(home, ".claude", "plugins"), "junction");
    const out = plain(doctor(home));
    expect(out).not.toContain("9.9.9");
    expect(out).toMatch(/versão não encontrada no cache de plugins, ligado/);
  });

  it("CLAUDE_CONFIG_DIR definido: a linha vem dali, não do ~/.claude do USERPROFILE", SLOW, () => {
    const home = fakeHome(JSON.stringify({ plugins: { "superpowers@claude-plugins-official": [{ scope: "user", version: "6.1.1" }] } }), false);
    const cfg = path.join(base, "cfg");
    fs.mkdirSync(path.join(cfg, "plugins"), { recursive: true });
    fs.writeFileSync(path.join(cfg, "settings.json"), JSON.stringify({ enabledPlugins: { "superpowers@claude-plugins-official": true } }));
    fs.writeFileSync(
      path.join(cfg, "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "superpowers@claude-plugins-official": [{ scope: "user", version: "6.4.1" }] } }),
    );
    const out = plain(doctor(home, { CLAUDE_CONFIG_DIR: cfg }));
    expect(out).toMatch(/\[INFO\] superpowers plugin[^\n]*\n\s+6\.4\.1, ligado/);
    expect(out).not.toContain("6.1.1");
  });

  it("registro e settings quebrados: sem linha do superpowers e sem lançar", SLOW, () => {
    const home = fakeHome("{{{");
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{não é json");
    const out = plain(doctor(home));
    expect(out).not.toMatch(/superpowers plugin/);
    expect(out).toMatch(/checks passed|checks failed/);
  });
});
