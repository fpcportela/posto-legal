import { describe, expect, it } from "vitest";
import { scanForSecrets, isPlaceholder } from "./secret-scanner.js";

// Fixtures are concatenated so no contiguous secret literal exists in this
// source file — the pre-commit scanner skips *.test.ts, but this keeps the
// file clean even if that ever changes.
const ANTHROPIC = "sk-ant-" + "api03-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4";
const OPENAI = "sk-" + "proj-" + "abcDEF1234567890abcDEF1234567890";
const GOOGLE = "AIza" + "SyD0123456789abcdefghijklmnopqrstuv";
const AWS_ID = "AKIA" + "IOSFODNN7EXAMPLE0".slice(0, 16);
const GITHUB = "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789";

describe("scanForSecrets — named provider keys with a real value", () => {
  it("flags GEMINI_API_KEY with a value (the gap the audit found)", () => {
    const findings = scanForSecrets(`GEMINI_API_KEY=${GOOGLE}`);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.line === 1)).toBe(true);
  });

  it("flags ANTHROPIC_API_KEY with a value (regression of the original rule)", () => {
    expect(scanForSecrets(`ANTHROPIC_API_KEY=${ANTHROPIC}`).length).toBeGreaterThan(0);
  });

  it("flags OPENAI_API_KEY with a value", () => {
    expect(scanForSecrets(`OPENAI_API_KEY="${OPENAI}"`).length).toBeGreaterThan(0);
  });

  it("flags AWS_SECRET_ACCESS_KEY with a value", () => {
    expect(scanForSecrets(`AWS_SECRET_ACCESS_KEY = wJalrXUtnFEMI0K7MDENG0bPxRfiCYEXAMPLEKEY`).length).toBeGreaterThan(0);
  });
});

describe("scanForSecrets — raw key material with no variable name", () => {
  it("flags a bare Anthropic key", () => {
    expect(scanForSecrets(`const k = "${ANTHROPIC}";`).length).toBeGreaterThan(0);
  });

  it("flags a bare Google AIza key", () => {
    expect(scanForSecrets(GOOGLE).length).toBeGreaterThan(0);
  });

  it("flags a bare AWS access key id", () => {
    expect(scanForSecrets(AWS_ID).length).toBeGreaterThan(0);
  });

  it("flags a bare GitHub token", () => {
    expect(scanForSecrets(GITHUB).length).toBeGreaterThan(0);
  });

  it("flags a PEM private key header", () => {
    expect(scanForSecrets("-----BEGIN RSA PRIVATE KEY-----").length).toBeGreaterThan(0);
  });

  it("flags a redis URL with embedded credentials", () => {
    expect(scanForSecrets("REDIS_URL=redis://admin:s3cr3t@cache:6379").length).toBeGreaterThan(0);
  });
});

describe("scanForSecrets — placeholders and mentions do NOT trip", () => {
  it("ignores the empty .env.example placeholder", () => {
    expect(scanForSecrets("ANTHROPIC_API_KEY=")).toEqual([]);
  });

  it("ignores a your-... style placeholder", () => {
    expect(scanForSecrets("GEMINI_API_KEY=your-gemini-key-here")).toEqual([]);
  });

  it("ignores an angle-bracket placeholder", () => {
    expect(scanForSecrets("OPENAI_API_KEY=<your-key>")).toEqual([]);
  });

  it("ignores a prose mention of a key name without a value", () => {
    expect(scanForSecrets("Add your ANTHROPIC_API_KEY to the .env file before running.")).toEqual([]);
  });

  it("ignores a documentation VAR=… example (ellipsis value)", () => {
    expect(scanForSecrets("a staged GEMINI_API_KEY=AIza… blocks the commit")).toEqual([]);
  });
});

describe("scanForSecrets — line attribution", () => {
  it("reports the 1-based line of the leak in a multi-line blob", () => {
    const blob = ["first line", "second line", `GEMINI_API_KEY=${GOOGLE}`].join("\n");
    const findings = scanForSecrets(blob);
    expect(findings.some((f) => f.line === 3)).toBe(true);
  });

  it("does not leak the secret value verbatim in the snippet", () => {
    const findings = scanForSecrets(`ANTHROPIC_API_KEY=${ANTHROPIC}`);
    expect(findings[0]?.snippet ?? "").not.toContain(ANTHROPIC);
  });
});

describe("isPlaceholder", () => {
  it.each([
    ["", "empty"],
    ["your-key-here", "your- prefix"],
    ["<your-key>", "angle brackets"],
    ["xxxxx", "all x"],
    ["changeme", "changeme"],
    ["example-value", "example"],
    ["AIza…", "ellipsis char (doc example)"],
    ["sk-ant-...", "three-dot ellipsis (doc example)"],
  ])("treats %j as a placeholder (%s)", (value) => {
    expect(isPlaceholder(value)).toBe(true);
  });

  it("treats a high-entropy value as a real secret", () => {
    expect(isPlaceholder("wJalrXUtnFEMI0K7MDENG0bPxRfiCYEXAMPLEKEY")).toBe(false);
  });

  // Doc que ENSINA a regra ("o hook bloqueia `ANTHROPIC_API_KEY=` literais") tem
  // o code span fechando logo depois do `=`, então o que o scanner captura como
  // "valor" é a crase de fechamento e a prosa seguinte. Menção, não valor — foi
  // o que barrou o commit do binding gerado da persona backend-architect.
  it("não confunde `VAR=` fechado num code span com atribuição real", () => {
    expect(isPlaceholder("` literals; do not attempt to bypass it.")).toBe(true);
  });

  // Estreito de propósito: crase seguida de material de chave continua valendo.
  it("ainda pega chave real escrita entre crases", () => {
    expect(isPlaceholder("`wJalrXUtnFEMI0K7MDENG0bPxRfiCYEXAMPLEKEY`")).toBe(false);
  });
});
