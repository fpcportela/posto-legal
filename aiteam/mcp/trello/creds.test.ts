import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadRootEnv, requireCreds } from "./creds.js";

const CRLF = String.fromCharCode(13, 10);

describe("requireCreds", () => {
  it("returns key/token when both are present and valid", () => {
    expect(requireCreds({ TRELLO_API_KEY: "abc123", TRELLO_TOKEN: "def456" })).toEqual({
      key: "abc123",
      token: "def456",
    });
  });

  it("throws naming the missing var, without leaking values", () => {
    expect(() => requireCreds({})).toThrow(/TRELLO_API_KEY/);
    expect(() => requireCreds({ TRELLO_API_KEY: "abc" })).toThrow(/TRELLO_TOKEN/);
  });

  // Sem credencial o servidor sobe e só a chamada falha — com a mensagem que diz onde pôr o quê.
  it("a mensagem de credencial ausente diz onde pôr as duas e como gerar o token, sem apontar arquivo que o framework não tem", () => {
    let msg = "";
    try {
      requireCreds({});
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/TRELLO_API_KEY and TRELLO_TOKEN/);
    expect(msg).toMatch(/gitignored root \.env/);
    expect(msg).toMatch(/trello\.com\/1\/authorize/);
    expect(msg).not.toMatch(/\.env\.example/);
  });

  it("rejects non-alphanumeric values (OAuth header-injection guard)", () => {
    expect(() => requireCreds({ TRELLO_API_KEY: 'a"b', TRELLO_TOKEN: "ok" })).toThrow(/invalid format/);
    let msg = "";
    try {
      requireCreds({ TRELLO_API_KEY: "inject" + CRLF + "X", TRELLO_TOKEN: "ok" });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toContain("inject");
  });
});

describe("loadRootEnv", () => {
  let dir = "";
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("reads .env without overwriting values already in the environment", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trello-env-"));
    fs.writeFileSync(
      path.join(dir, ".env"),
      ["# comment", "TRELLO_API_KEY=fromfile", 'EXISTING="keep-me"', "blank", ""].join("\n"),
      "utf8",
    );
    const env: Record<string, string | undefined> = { EXISTING: "already-set" };
    loadRootEnv(dir, env);
    expect(env.TRELLO_API_KEY).toBe("fromfile");
    expect(env.EXISTING).toBe("already-set");
  });

  it("carrega só as chaves TRELLO_*: o resto do .env (banco, tokens de deploy) não entra no processo do MCP", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trello-env-"));
    fs.writeFileSync(
      path.join(dir, ".env"),
      ["DATABASE_URL=postgres://u:p@h/db", "ANTHROPIC_API_KEY=sk-nao-carregar", "TRELLO_API_KEY=abc123", "TRELLO_TOKEN='def456'"].join(CRLF),
      "utf8",
    );
    const env: Record<string, string | undefined> = {};
    loadRootEnv(dir, env);
    expect(env).toEqual({ TRELLO_API_KEY: "abc123", TRELLO_TOKEN: "def456" });
  });

  it("sem o argumento, a raiz é a do repo (repoRoot): RB_REPO_ROOT aponta para o .env certo", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trello-env-"));
    fs.writeFileSync(path.join(dir, ".env"), "TRELLO_API_KEY=daraiz\n", "utf8");
    const saved = process.env["RB_REPO_ROOT"];
    process.env["RB_REPO_ROOT"] = dir;
    try {
      const env: Record<string, string | undefined> = {};
      loadRootEnv(undefined, env);
      expect(env["TRELLO_API_KEY"]).toBe("daraiz");
    } finally {
      if (saved === undefined) delete process.env["RB_REPO_ROOT"];
      else process.env["RB_REPO_ROOT"] = saved;
    }
  });

  it("is a no-op when no .env exists", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trello-env-"));
    const env: Record<string, string | undefined> = {};
    expect(() => loadRootEnv(dir, env)).not.toThrow();
    expect(Object.keys(env)).toHaveLength(0);
  });
});
