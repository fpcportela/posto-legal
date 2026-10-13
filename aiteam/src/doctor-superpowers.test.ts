import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SUPERPOWERS_VALIDATED, checkSuperpowers, compareVersions, parseVersion, readSuperpowersFacts } from "./doctor-superpowers.mjs";
import { repoRoot } from "./repo-root.js";

// Issue 51: o framework foi escrito contra o comportamento do plugin superpowers
// (o ledger do SDD e do executing-plans, o TDD que manda rodar a suíte do
// projeto) e não dizia com que versão, nem se ele deve estar ligado. O doctor
// passa a mostrar a versão instalada e se o plugin está ligado: só leitura, INFO
// ou WARN, nunca FAIL, e em silêncio quando falta o que ler. Só lê dentro de
// ~/.claude e do repo.

describe("parseVersion / compareVersions", () => {
  it("lê major.minor.patch, com ou sem o v e com sufixo", () => {
    expect(parseVersion("6.4.1")).toEqual([6, 4, 1]);
    expect(parseVersion("v6.2.0")).toEqual([6, 2, 0]);
    expect(parseVersion("6.4.2-rc.1")).toEqual([6, 4, 2]);
  });

  it("o que não é versão vem null", () => {
    for (const v of ["main", "", "6.4", null, undefined, 6]) expect(parseVersion(v as never), String(v)).toBeNull();
  });

  it("compara por major, minor e patch, e não por texto", () => {
    expect(compareVersions([6, 1, 1], [6, 2, 0])).toBeLessThan(0);
    expect(compareVersions([6, 10, 0], [6, 9, 9])).toBeGreaterThan(0);
    expect(compareVersions([6, 2, 0], [6, 2, 0])).toBe(0);
    expect(compareVersions([5, 99, 99], [6, 0, 0])).toBeLessThan(0);
  });
});

describe("checkSuperpowers — a linha do doctor", () => {
  it("em silêncio quando não há nada para dizer: sem versão e sem estado", () => {
    expect(checkSuperpowers({ enabled: null, version: null, platform: "win32" })).toBeNull();
  });

  it("ligado, na versão validada: INFO, que passa, com a versão e a que o framework foi validado", () => {
    const r = checkSuperpowers({ enabled: true, version: SUPERPOWERS_VALIDATED, platform: "linux" });
    expect(r).toMatchObject({ pass: true, info: true });
    expect(r?.warn).toBeUndefined();
    expect(r?.detail).toContain(SUPERPOWERS_VALIDATED);
    expect(r?.detail).toMatch(/ligado/);
    expect(r?.detail).toContain(`validado com o superpowers ${SUPERPOWERS_VALIDATED}`);
  });

  it("a versão validada é a que o marketplace oficial serve (a 6.4.1)", () => {
    expect(SUPERPOWERS_VALIDATED).toBe("6.4.1");
  });

  it("desligado: INFO dizendo desligado", () => {
    const r = checkSuperpowers({ enabled: false, version: "6.1.1", platform: "linux" });
    expect(r).toMatchObject({ pass: true, info: true });
    expect(r?.detail).toMatch(/6\.1\.1, desligado/);
  });

  it("ligado ou desligado sem declaração em enabledPlugins: diz isso", () => {
    const r = checkSuperpowers({ enabled: null, version: "6.4.1", platform: "linux" });
    expect(r).toMatchObject({ pass: true, info: true });
    expect(r?.detail).toMatch(/não declarado em enabledPlugins/);
  });

  it("ligado mas sem a versão no cache: diz o que sabe, sem inventar versão", () => {
    const r = checkSuperpowers({ enabled: true, version: null, platform: "linux" });
    expect(r).toMatchObject({ pass: true, info: true });
    expect(r?.detail).toMatch(/versão não encontrada no cache de plugins, ligado/);
  });

  describe("WARN: no Windows, antes da 6.2.0 o hook SessionStart falhava sem aviso", () => {
    it("6.1.1 ligado no Windows: WARN (passa, mas avisa), nomeando o hook e a 6.2.0", () => {
      const r = checkSuperpowers({ enabled: true, version: "6.1.1", platform: "win32" });
      expect(r).toMatchObject({ pass: true, warn: true });
      expect(r?.info).toBeUndefined();
      expect(r?.detail).toMatch(/6\.2\.0/);
      expect(r?.detail).toMatch(/SessionStart/);
      expect(r?.detail).toMatch(/sem aviso/);
    });

    it("6.2.0 já não avisa (a fronteira), e a 6.4.1 também não", () => {
      for (const version of ["6.2.0", "6.2.1", "6.4.1", "7.0.0"]) {
        const r = checkSuperpowers({ enabled: true, version, platform: "win32" });
        expect(r, version).toMatchObject({ pass: true, info: true });
        expect(r?.warn, version).toBeUndefined();
      }
    });

    it("fora do Windows a versão antiga não avisa", () => {
      for (const platform of ["linux", "darwin"]) {
        const r = checkSuperpowers({ enabled: true, version: "6.1.1", platform });
        expect(r?.warn, platform).toBeUndefined();
        expect(r).toMatchObject({ pass: true, info: true });
      }
    });

    it("desligado, o hook não roda: vira INFO, com a nota para atualizar antes de ligar", () => {
      const r = checkSuperpowers({ enabled: false, version: "6.1.1", platform: "win32" });
      expect(r).toMatchObject({ pass: true, info: true });
      expect(r?.warn).toBeUndefined();
      expect(r?.detail).toMatch(/desligado/);
      expect(r?.detail).toMatch(/atualize antes de ligá-lo/);
    });

    it("versão que não dá para ler não avisa", () => {
      const r = checkSuperpowers({ enabled: true, version: "main", platform: "win32" });
      expect(r?.warn).toBeUndefined();
    });
  });

  it("nunca reprova: pass é sempre true, qualquer que seja a entrada", () => {
    const versions = [null, "6.1.1", "6.4.1", "9.9.9", "lixo"];
    for (const enabled of [true, false, null]) {
      for (const version of versions) {
        for (const platform of ["win32", "linux", "darwin"]) {
          const r = checkSuperpowers({ enabled, version, platform });
          if (r !== null) expect(r.pass, `${enabled} ${version} ${platform}`).toBe(true);
        }
      }
    }
  });
});

describe("readSuperpowersFacts — só lê dentro de ~/.claude e do repo", () => {
  let base: string;
  let home: string;
  let root: string;

  const write = (file: string, content: unknown): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content), "utf8");
  };
  const userSettings = () => path.join(home, ".claude", "settings.json");
  const projectSettings = () => path.join(root, ".claude", "settings.json");
  const localSettings = () => path.join(root, ".claude", "settings.local.json");
  const installed = () => path.join(home, ".claude", "plugins", "installed_plugins.json");
  const cacheVersion = (marketplace: string, version: string) =>
    fs.mkdirSync(path.join(home, ".claude", "plugins", "cache", marketplace, "superpowers", version), { recursive: true });

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "doctor-superpowers-"));
    home = path.join(base, "home");
    root = path.join(base, "repo");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("nada para ler: tudo null, sem lançar", () => {
    expect(readSuperpowersFacts({ env: {}, home, root })).toEqual({ enabled: null, version: null, versionUnreadable: false });
    expect(readSuperpowersFacts({ env: {}, home: path.join(base, "nao-existe"), root: path.join(base, "tambem-nao") })).toEqual({
      enabled: null,
      version: null,
      versionUnreadable: false,
    });
  });

  it("enabledPlugins do usuário", () => {
    write(userSettings(), { enabledPlugins: { "superpowers@claude-plugins-official": true } });
    expect(readSuperpowersFacts({ env: {}, home, root }).enabled).toBe(true);
    write(userSettings(), { enabledPlugins: { "superpowers@claude-plugins-official": false } });
    expect(readSuperpowersFacts({ env: {}, home, root }).enabled).toBe(false);
  });

  it("o projeto vale mais que o usuário, e o settings.local do projeto mais que os dois", () => {
    write(userSettings(), { enabledPlugins: { "superpowers@claude-plugins-official": true } });
    write(projectSettings(), { enabledPlugins: { "superpowers@claude-plugins-official": false } });
    expect(readSuperpowersFacts({ env: {}, home, root }).enabled).toBe(false);
    write(localSettings(), { enabledPlugins: { "superpowers@claude-plugins-official": true } });
    expect(readSuperpowersFacts({ env: {}, home, root }).enabled).toBe(true);
  });

  it("outros plugins e valores que não são booleanos não contam", () => {
    write(userSettings(), {
      enabledPlugins: { "frontend-design@claude-plugins-official": true, "superpowers@claude-plugins-official": "yes" },
    });
    expect(readSuperpowersFacts({ env: {}, home, root }).enabled).toBeNull();
  });

  it("qualquer marketplace serve: superpowers@<marketplace>", () => {
    write(userSettings(), { enabledPlugins: { "superpowers@superpowers-marketplace": true } });
    expect(readSuperpowersFacts({ env: {}, home, root }).enabled).toBe(true);
  });

  it("JSON quebrado, com BOM ou sem enabledPlugins não derruba: o que não dá para ler fica em silêncio", () => {
    write(userSettings(), "{ não é json");
    write(projectSettings(), "\uFEFF" + JSON.stringify({ enabledPlugins: { "superpowers@claude-plugins-official": true } }));
    write(localSettings(), { outra: 1 });
    expect(readSuperpowersFacts({ env: {}, home, root }).enabled).toBe(true);
  });

  it("a versão vem do installed_plugins.json, do escopo de usuário", () => {
    write(installed(), {
      version: 2,
      plugins: { "superpowers@claude-plugins-official": [{ scope: "user", version: "6.4.1", installPath: "C:\\x" }] },
    });
    expect(readSuperpowersFacts({ env: {}, home, root }).version).toBe("6.4.1");
  });

  it("não segue o installPath: a versão é a registrada, e nada fora de ~/.claude é lido", () => {
    const fora = path.join(base, "fora");
    write(path.join(fora, "package.json"), { version: "0.0.1" });
    write(installed(), {
      plugins: { "superpowers@claude-plugins-official": [{ scope: "user", version: "6.4.1", installPath: fora }] },
    });
    expect(readSuperpowersFacts({ env: {}, home, root }).version).toBe("6.4.1");
  });

  it("instalação de projeto vale só para o projeto dela, e ganha do escopo de usuário nele", () => {
    write(installed(), {
      plugins: {
        "superpowers@claude-plugins-official": [
          { scope: "user", version: "6.1.1" },
          { scope: "project", version: "6.4.1", projectPath: root },
          { scope: "project", version: "9.9.9", projectPath: path.join(base, "outro-repo") },
        ],
      },
    });
    expect(readSuperpowersFacts({ env: {}, home, root }).version).toBe("6.4.1");
    expect(readSuperpowersFacts({ env: {}, home, root: path.join(base, "sem-instalacao") }).version).toBe("6.1.1");
  });

  it("sem o installed_plugins.json, cai no cache de plugins: a maior versão que parece versão", () => {
    cacheVersion("claude-plugins-official", "6.1.1");
    cacheVersion("claude-plugins-official", "6.4.1");
    cacheVersion("claude-plugins-official", "6.10.0");
    fs.mkdirSync(path.join(home, ".claude", "plugins", "cache", "claude-plugins-official", "superpowers", "temp_git_abc"), { recursive: true });
    expect(readSuperpowersFacts({ env: {}, home, root }).version).toBe("6.10.0");
  });

  it("com o installed_plugins.json sem superpowers, o cache ainda responde", () => {
    write(installed(), { plugins: { "context7@claude-plugins-official": [{ scope: "user", version: "1.0.0" }] } });
    cacheVersion("claude-plugins-official", "6.4.1");
    expect(readSuperpowersFacts({ env: {}, home, root }).version).toBe("6.4.1");
  });

  it("o installed_plugins.json vale mais que o cache (o cache guarda versões antigas)", () => {
    write(installed(), { plugins: { "superpowers@claude-plugins-official": [{ scope: "user", version: "6.4.1" }] } });
    cacheVersion("claude-plugins-official", "6.1.1");
    cacheVersion("claude-plugins-official", "6.4.1");
    cacheVersion("claude-plugins-official", "6.4.2");
    expect(readSuperpowersFacts({ env: {}, home, root }).version).toBe("6.4.1");
  });

  it("versão que não é texto no installed_plugins.json é ignorada", () => {
    write(installed(), { plugins: { "superpowers@claude-plugins-official": [{ scope: "user", version: 6 }, null, "x"] } });
    expect(readSuperpowersFacts({ env: {}, home, root }).version).toBeNull();
  });
});

// Revisão do QA da #51 (A8): o estado "ligado" e a versão vinham de lugares
// diferentes — qualquer chave superpowers@* ligada valia, e a versão era a de
// qualquer instalação —, então duas chaves (dois marketplaces) davam uma linha
// que misturava uma com a outra. As duas coisas vêm da MESMA chave.
describe("readSuperpowersFacts — o estado e a versão vêm da mesma chave superpowers@<marketplace>", () => {
  let base: string;
  let home: string;
  let root: string;

  const write = (file: string, content: unknown): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(content), "utf8");
  };
  const enabled = (map: Record<string, boolean>) => write(path.join(home, ".claude", "settings.json"), { enabledPlugins: map });
  const installs = (map: Record<string, string>) =>
    write(path.join(home, ".claude", "plugins", "installed_plugins.json"), {
      plugins: Object.fromEntries(Object.entries(map).map(([key, version]) => [key, [{ scope: "user", version }]])),
    });
  const facts = () => readSuperpowersFacts({ env: {}, home, root });

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "doctor-sp-key-"));
    home = path.join(base, "home");
    root = path.join(base, "repo");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("a chave que tem estado E instalação ganha: o desligado com a 6.1.1 não vira ligado por causa de outra chave", () => {
    enabled({ "superpowers@velho": false, "superpowers@outro": true });
    installs({ "superpowers@velho": "6.1.1" });
    expect(facts()).toMatchObject({ enabled: false, version: "6.1.1" });
  });

  it("duas chaves com estado e instalação: vale a ligada, com a versão dela", () => {
    enabled({ "superpowers@a": false, "superpowers@b": true });
    installs({ "superpowers@a": "6.1.1", "superpowers@b": "6.4.1" });
    expect(facts()).toMatchObject({ enabled: true, version: "6.4.1" });
  });

  it("empatadas, a do marketplace oficial vale, e depois a maior versão", () => {
    enabled({ "superpowers@claude-plugins-official": true, "superpowers@zzz": true });
    installs({ "superpowers@claude-plugins-official": "6.4.1", "superpowers@zzz": "6.9.0" });
    expect(facts()).toMatchObject({ enabled: true, version: "6.4.1" });
    enabled({ "superpowers@aaa": true, "superpowers@zzz": true });
    installs({ "superpowers@aaa": "6.1.1", "superpowers@zzz": "6.9.0" });
    expect(facts()).toMatchObject({ enabled: true, version: "6.9.0" });
  });

  it("estado de uma chave e instalação de outra: a instalação vale, e o estado dela fica sem declaração (não empresta o da outra)", () => {
    enabled({ "superpowers@y": true });
    installs({ "superpowers@x": "6.4.1" });
    expect(facts()).toEqual({ enabled: null, version: "6.4.1", versionUnreadable: false });
  });

  it("só estado: a versão vem do cache do marketplace da chave, não do de outro", () => {
    enabled({ "superpowers@claude-plugins-official": true });
    fs.mkdirSync(path.join(home, ".claude", "plugins", "cache", "claude-plugins-official", "superpowers", "6.4.1"), { recursive: true });
    fs.mkdirSync(path.join(home, ".claude", "plugins", "cache", "outro-mkt", "superpowers", "9.0.0"), { recursive: true });
    expect(facts()).toMatchObject({ enabled: true, version: "6.4.1" });
  });

  it("sem chave nenhuma, o cache de qualquer marketplace responde, como antes", () => {
    fs.mkdirSync(path.join(home, ".claude", "plugins", "cache", "mk", "superpowers", "6.4.1"), { recursive: true });
    fs.mkdirSync(path.join(home, ".claude", "plugins", "cache", "outro", "superpowers", "6.1.1"), { recursive: true });
    expect(facts()).toEqual({ enabled: null, version: "6.4.1", versionUnreadable: false });
  });

  it("o marketplace da chave não vira caminho: .. e separadores não saem do cache", () => {
    enabled({ "superpowers@../../fora": true, "superpowers@a/b": true });
    fs.mkdirSync(path.join(base, "fora", "superpowers", "9.9.9"), { recursive: true });
    expect(facts().version).toBeNull();
  });

  it("a chave só com versão ilegível marca ilegível, e a chave de outro marketplace com versão boa não esconde essa", () => {
    enabled({ "superpowers@ruim": true });
    installs({ "superpowers@ruim": "6.4.1\u001b[2J" });
    expect(facts()).toEqual({ enabled: true, version: null, versionUnreadable: true });
  });
});

// Revisão do QA da #51 (A7): o Claude Code lê o diretório de configuração de
// CLAUDE_CONFIG_DIR quando ele está definido (em vez de ~/.claude), e o doctor
// olhava sempre ~/.claude; e o os.homedir() era chamado no doctor.mjs, FORA do
// try da leitura, então uma máquina sem home derrubava o doctor inteiro.
describe("readSuperpowersFacts — CLAUDE_CONFIG_DIR e o home que não existe", () => {
  let base: string;
  let home: string;
  let root: string;
  let cfg: string;

  const write = (file: string, content: unknown): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(content), "utf8");
  };
  const seed = (dir: string, enabled: boolean, version: string) => {
    write(path.join(dir, "settings.json"), { enabledPlugins: { "superpowers@claude-plugins-official": enabled } });
    write(path.join(dir, "plugins", "installed_plugins.json"), {
      plugins: { "superpowers@claude-plugins-official": [{ scope: "user", version }] },
    });
  };

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "doctor-sp-cfg-"));
    home = path.join(base, "home");
    root = path.join(base, "repo");
    cfg = path.join(base, "cfg");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("com CLAUDE_CONFIG_DIR, lê dali e não de ~/.claude", () => {
    seed(path.join(home, ".claude"), false, "6.1.1");
    seed(cfg, true, "6.4.1");
    expect(readSuperpowersFacts({ home, root, env: { CLAUDE_CONFIG_DIR: cfg } })).toEqual({
      enabled: true,
      version: "6.4.1",
      versionUnreadable: false,
    });
    expect(readSuperpowersFacts({ home, root, env: {} })).toMatchObject({ enabled: false, version: "6.1.1" });
  });

  it("CLAUDE_CONFIG_DIR vazio não conta: vale ~/.claude", () => {
    seed(path.join(home, ".claude"), true, "6.4.1");
    expect(readSuperpowersFacts({ home, root, env: { CLAUDE_CONFIG_DIR: "" } })).toMatchObject({ enabled: true, version: "6.4.1" });
  });

  it("sem home e com CLAUDE_CONFIG_DIR, o home nem é consultado", () => {
    seed(cfg, true, "6.4.1");
    const homedir = () => {
      throw new Error("não devia ser chamado");
    };
    expect(readSuperpowersFacts({ root, env: { CLAUDE_CONFIG_DIR: cfg }, homedir })).toMatchObject({ enabled: true, version: "6.4.1" });
  });

  it("o os.homedir() que lança fica dentro do try: nada, sem derrubar o doctor", () => {
    const homedir = () => {
      throw new Error("ENOENT: no home directory");
    };
    expect(readSuperpowersFacts({ root, env: {}, homedir })).toEqual({ enabled: null, version: null, versionUnreadable: false });
  });

  it("sem o parâmetro home, usa o homedir injetado", () => {
    seed(path.join(home, ".claude"), true, "6.4.1");
    expect(readSuperpowersFacts({ root, env: {}, homedir: () => home })).toMatchObject({ enabled: true, version: "6.4.1" });
  });

  it("a jaula é o CLAUDE_CONFIG_DIR: uma junction para fora, dentro dele, não é seguida", () => {
    const fora = path.join(base, "fora");
    write(path.join(fora, "installed_plugins.json"), { plugins: { "superpowers@claude-plugins-official": [{ scope: "user", version: "9.9.9" }] } });
    write(path.join(cfg, "settings.json"), { enabledPlugins: { "superpowers@claude-plugins-official": true } });
    fs.symlinkSync(fora, path.join(cfg, "plugins"), "junction");
    expect(readSuperpowersFacts({ home, root, env: { CLAUDE_CONFIG_DIR: cfg } })).toEqual({
      enabled: true,
      version: null,
      versionUnreadable: false,
    });
  });
});

describe("doctor.mjs — usa a leitura testada do superpowers", () => {
  const src = fs.readFileSync(path.resolve(repoRoot(), "aiteam", "scripts", "doctor.mjs"), "utf8");

  it("importa o check e a leitura, e passa a plataforma do processo", () => {
    expect(src).toMatch(/checkSuperpowers/);
    expect(src).toMatch(/readSuperpowersFacts/);
    expect(src).toMatch(/platform:\s*process\.platform/);
  });

  it("o home não é consultado no doctor.mjs: a leitura o faz dentro do próprio try", () => {
    expect(src).not.toMatch(/os\.homedir\(\)/);
    expect(src).not.toMatch(/from "node:os"/);
  });

  it("a linha INFO tem a própria cor e o resultado nulo não vira linha", () => {
    expect(src).toMatch(/r\.info/);
    expect(src).toMatch(/INFO/);
    expect(src).toMatch(/if \(superpowers\) results\.push\(superpowers\)/);
  });
});

describe("a doc diz com que versão do superpowers o framework foi validado", () => {
  const readme = fs.readFileSync(path.resolve(repoRoot(), "aiteam", "README.md"), "utf8").replace(/\s+/g, " ");

  it("README EN e PT dizem quando o WARN vale: ligado ou sem estado declarado, e desligado fica INFO (QA #51, A6)", () => {
    expect(readme).toContain("WARN on Windows below 6.2.0 when the plugin is on or has no declared state");
    expect(readme).toContain("turned off, it stays INFO");
    expect(readme).toContain("WARN no Windows abaixo da 6.2.0 quando o plugin está ligado ou sem estado declarado");
    expect(readme).toContain("desligado, fica em INFO");
  });

  it("o WARN do código é o que o README diz: ligado ou sem estado, mas não desligado", () => {
    for (const enabled of [true, null] as const) {
      expect(checkSuperpowers({ enabled, version: "6.1.1", platform: "win32" })).toMatchObject({ warn: true });
    }
    expect(checkSuperpowers({ enabled: false, version: "6.1.1", platform: "win32" })?.warn).toBeUndefined();
  });

  it("README EN e PT citam a versão que o doctor usa", () => {
    expect(readme).toContain(`validated with superpowers ${SUPERPOWERS_VALIDATED}`);
    expect(readme).toContain(`validado com o superpowers ${SUPERPOWERS_VALIDATED}`);
  });
});
