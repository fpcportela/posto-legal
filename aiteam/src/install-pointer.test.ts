import { afterEach, describe, expect, it } from "vitest";
import {
  ADAPTER_POINTER_BLOCK,
  CURSOR_RULE_CONTENT,
  LEGACY_ADAPTER_POINTER_BLOCKS,
  ensurePointerFile,
} from "./install-core.mjs";
import { makeSandbox, SLOW, type Sandbox } from "./beads-sandbox.js";

// O bloco-apontador que o install acrescenta a .windsurfrules e a
// .github/copilot-instructions.md dizia "the runtime Tier-3 Bash gate", mas o
// gate cobre Bash, PowerShell, Monitor e o terminal do app. Trocar o texto sem
// mais nada faria o install, que reconhece o bloco por inclusão do texto exato,
// acrescentar um segundo bloco em cada consumidor. Por isso o install reconhece
// o bloco antigo e o TROCA no lugar.

// O texto que os consumidores já têm, tal como o install o gravou desde 2026-07-04.
const SHIPPED_BEFORE = `# rb-ai-team

Read and obey AGENTS.md (repo root, imports aiteam/AGENTS.md) and the active
persona under aiteam/agents/ before writing code. See
aiteam/docs/provider-agnostic-improvements.md for the enforcement portability
matrix: the runtime Tier-3 Bash gate (aiteam/hooks/tier-guard.mjs) is
Claude-Code-specific, but the git pre-push backstop
(aiteam/githooks/pre-push) and the MCP tool tier gating
(aiteam/mcp/registry.ts) apply to any client that uses them.
`;

const count = (text: string, part: string) => text.split(part).length - 1;
const HEADING = "# rb-ai-team";

describe("o texto do bloco-apontador", () => {
  it("diz a verdade sobre o gate: Bash, PowerShell, Monitor e o terminal do app", () => {
    expect(ADAPTER_POINTER_BLOCK).not.toMatch(/Tier-3 Bash gate/);
    for (const surface of ["Bash", "PowerShell", "Monitor", "terminal"]) {
      expect(ADAPTER_POINTER_BLOCK).toContain(surface);
    }
    expect(ADAPTER_POINTER_BLOCK).toContain("aiteam/hooks/tier-guard.mjs");
  });

  it("o texto que os consumidores têm hoje está na lista dos reconhecidos como antigos", () => {
    expect(LEGACY_ADAPTER_POINTER_BLOCKS).toContain(SHIPPED_BEFORE);
    expect(LEGACY_ADAPTER_POINTER_BLOCKS).not.toContain(ADAPTER_POINTER_BLOCK);
  });

  it("a regra do Cursor, que o install escreve inteira, leva o texto novo", () => {
    expect(CURSOR_RULE_CONTENT).toContain(ADAPTER_POINTER_BLOCK);
  });
});

describe("ensurePointerFile — troca o bloco antigo, nunca acrescenta um segundo", () => {
  const legacy = LEGACY_ADAPTER_POINTER_BLOCKS;

  it("arquivo só com o bloco antigo: fica só com o novo", () => {
    const out = ensurePointerFile(SHIPPED_BEFORE, ADAPTER_POINTER_BLOCK, legacy);
    expect(out).toBe(ADAPTER_POINTER_BLOCK);
  });

  it("preserva o que o host escreveu antes e depois do bloco", () => {
    const host = `# Regras do host\nusar tabs\n\n${SHIPPED_BEFORE}\n## Depois\nmais uma regra\n`;
    const out = ensurePointerFile(host, ADAPTER_POINTER_BLOCK, legacy);
    expect(out).toBe(`# Regras do host\nusar tabs\n\n${ADAPTER_POINTER_BLOCK}\n## Depois\nmais uma regra\n`);
    expect(count(out, HEADING)).toBe(1);
    expect(out).not.toContain("Tier-3 Bash gate");
  });

  it("arquivo CRLF (checkout Windows): troca mantendo o CRLF, sem LF solto", () => {
    const host = `# Host\r\nregra\r\n\r\n${SHIPPED_BEFORE.replace(/\n/g, "\r\n")}`;
    const out = ensurePointerFile(host, ADAPTER_POINTER_BLOCK, legacy);
    expect(out).toBe(`# Host\r\nregra\r\n\r\n${ADAPTER_POINTER_BLOCK.replace(/\n/g, "\r\n")}`);
    expect(out.replace(/\r\n/g, "")).not.toMatch(/\n/);
  });

  it("é idempotente: o resultado da troca não muda numa segunda rodada", () => {
    const once = ensurePointerFile(`# Host\n\n${SHIPPED_BEFORE}`, ADAPTER_POINTER_BLOCK, legacy);
    expect(ensurePointerFile(once, ADAPTER_POINTER_BLOCK, legacy)).toBe(once);
  });

  it("cópias antigas duplicadas (o install de antes duplicava em CRLF) viram um bloco só", () => {
    const host = `# Host\n\n${SHIPPED_BEFORE}\n${SHIPPED_BEFORE}\n${SHIPPED_BEFORE}`;
    const out = ensurePointerFile(host, ADAPTER_POINTER_BLOCK, legacy);
    expect(count(out, HEADING)).toBe(1);
    expect(out).not.toContain("Tier-3 Bash gate");
    expect(out.startsWith("# Host\n\n")).toBe(true);
  });

  it("sem bloco nenhum, acrescenta o novo como antes", () => {
    expect(ensurePointerFile("# Host\n", ADAPTER_POINTER_BLOCK, legacy)).toBe(`# Host\n\n${ADAPTER_POINTER_BLOCK}`);
    expect(ensurePointerFile("", ADAPTER_POINTER_BLOCK, legacy)).toBe(ADAPTER_POINTER_BLOCK);
  });

  it("com o bloco novo já lá, não mexe em nada", () => {
    const host = `# Host\n\n${ADAPTER_POINTER_BLOCK}`;
    expect(ensurePointerFile(host, ADAPTER_POINTER_BLOCK, legacy)).toBe(host);
  });

  it("texto parecido mas editado pelo host não é tomado por bloco antigo", () => {
    const edited = SHIPPED_BEFORE.replace("Claude-Code-specific", "só do Claude Code");
    const out = ensurePointerFile(edited, ADAPTER_POINTER_BLOCK, legacy);
    expect(out).toContain(edited.trim());
    expect(out).toContain(ADAPTER_POINTER_BLOCK.trim());
  });

  it("sem a lista de antigos, o comportamento é o de sempre (acrescenta)", () => {
    const out = ensurePointerFile(SHIPPED_BEFORE, ADAPTER_POINTER_BLOCK);
    expect(count(out, HEADING)).toBe(2);
  });
});

describe("install.mjs — arquivo de consumidor com o bloco antigo", () => {
  let sb: Sandbox | undefined;
  afterEach(() => sb?.cleanup());

  it("troca o bloco antigo em .windsurfrules e copilot-instructions, e a segunda rodada não muda nada", SLOW, () => {
    sb = makeSandbox();
    const s = sb;
    const files = [".windsurfrules", ".github/copilot-instructions.md"];
    for (const f of files) s.write(f, `# Regras do host (${f})\nusar tabs\n\n${SHIPPED_BEFORE}`);

    const first = s.node("install.mjs");
    expect(first.status, first.out).toBe(0);
    for (const f of files) {
      const text = s.read(f);
      expect(text, f).toBe(`# Regras do host (${f})\nusar tabs\n\n${ADAPTER_POINTER_BLOCK}`);
      expect(count(text, HEADING), f).toBe(1);
    }
    expect(first.out).toMatch(/\.windsurfrules/);

    const second = s.node("install.mjs");
    expect(second.status, second.out).toBe(0);
    expect(second.out).toMatch(/already installed|nothing to change/);
    for (const f of files) expect(count(s.read(f), HEADING), f).toBe(1);
  });

  it("a regra do Cursor, do framework, é reescrita com o texto novo", SLOW, () => {
    sb = makeSandbox();
    const s = sb;
    s.write(".cursor/rules/aiteam.mdc", `---\ndescription: rb-ai-team framework contract\nalwaysApply: true\n---\n\n${SHIPPED_BEFORE}`);

    expect(s.node("install.mjs").status).toBe(0);

    expect(s.read(".cursor/rules/aiteam.mdc")).toBe(CURSOR_RULE_CONTENT);
  });
});
