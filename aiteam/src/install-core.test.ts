import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./repo-root.js";
import {
  mergeDeny,
  ensurePreToolUseHook,
  ensureHookCommand,
  mergeSettings,
  mergeMcpServers,
  mcpServersAdded,
  mcpAddedLabel,
  ensureImportLine,
  planHookChaining,
  ensureChainLine,
  ensurePointerFile,
  resolveHookPath,
  planInfraRemote,
  planTierRulesSeed,
  FRAMEWORK_SETTINGS,
  CHAINED_HOOKS,
  ensureGitignoreEntry,
  WORKTREES_IGNORE,
} from "./install-core.mjs";

describe("mergeDeny — union without duplicates", () => {
  it("adds framework rules the host lacks", () => {
    expect(mergeDeny(["a"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("does not duplicate rules already present", () => {
    expect(mergeDeny(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("handles a missing host array", () => {
    expect(mergeDeny(undefined, ["a"])).toEqual(["a"]);
  });
});

describe("ensurePreToolUseHook — idempotent Bash guard", () => {
  const cmd = "node aiteam/hooks/tier-guard.mjs";

  it("adds the guard when absent", () => {
    const out = ensurePreToolUseHook([], cmd);
    expect(out).toHaveLength(1);
    expect(out[0]!.matcher).toBe("Bash");
    expect(out[0]!.hooks[0]!.command).toBe(cmd);
  });

  it("does not add a second copy when already present", () => {
    const existing = [{ matcher: "Bash", hooks: [{ type: "command", command: cmd }] }];
    expect(ensurePreToolUseHook(existing, cmd)).toHaveLength(1);
  });

  it("preserves unrelated PreToolUse entries", () => {
    const existing = [{ matcher: "Read", hooks: [{ type: "command", command: "x" }] }];
    expect(ensurePreToolUseHook(existing, cmd)).toHaveLength(2);
  });
});

describe("ensureHookCommand — idempotent, matcher-less hook merge (e.g. SessionStart)", () => {
  const cmd = "node aiteam/hooks/session-brief.mjs";

  it("adds the hook when absent", () => {
    const out = ensureHookCommand([], cmd);
    expect(out).toHaveLength(1);
    expect(out[0]!.hooks[0]!.command).toBe(cmd);
  });

  it("does not add a second copy when already present", () => {
    const existing = [{ hooks: [{ type: "command", command: cmd }] }];
    expect(ensureHookCommand(existing, cmd)).toHaveLength(1);
  });

  it("preserves unrelated entries for the same event", () => {
    const existing = [{ hooks: [{ type: "command", command: "node other-hook.mjs" }] }];
    expect(ensureHookCommand(existing, cmd)).toHaveLength(2);
  });
});

describe("mergeSettings — deny + PreToolUse, idempotent, non-destructive", () => {
  const framework = {
    permissions: { deny: ["Bash(vercel --prod:*)"] },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node aiteam/hooks/tier-guard.mjs" }] }],
      SessionStart: [{ hooks: [{ type: "command", command: "node aiteam/hooks/session-brief.mjs" }] }],
    },
  };

  it("keeps the host's own deny rules and hooks", () => {
    const host = {
      permissions: { deny: ["Bash(host-rule:*)"] },
      hooks: { PreToolUse: [{ matcher: "Read", hooks: [{ command: "h" }] }] },
    };
    const merged = mergeSettings(host, framework);
    expect(merged.permissions.deny).toContain("Bash(host-rule:*)");
    expect(merged.permissions.deny).toContain("Bash(vercel --prod:*)");
    expect(merged.hooks.PreToolUse.some((e) => e.matcher === "Read")).toBe(true);
  });

  it("adds the SessionStart hook for a host that has none yet", () => {
    const merged = mergeSettings({}, framework);
    expect(merged.hooks.SessionStart).toHaveLength(1);
    expect(merged.hooks.SessionStart[0]!.hooks[0]!.command).toBe("node aiteam/hooks/session-brief.mjs");
    // Must not clobber PreToolUse while adding SessionStart.
    expect(merged.hooks.PreToolUse[0]!.hooks[0]!.command).toBe("node aiteam/hooks/tier-guard.mjs");
  });

  it("keeps the host's own SessionStart hooks alongside the framework's", () => {
    const host = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node host-hook.mjs" }] }] } };
    const merged = mergeSettings(host, framework);
    const commands = merged.hooks.SessionStart.flatMap((e) => e.hooks.map((h) => h.command));
    expect(commands).toContain("node host-hook.mjs");
    expect(commands).toContain("node aiteam/hooks/session-brief.mjs");
  });

  it("is idempotent — merging twice equals merging once", () => {
    const once = mergeSettings({}, framework);
    expect(mergeSettings(once, framework)).toEqual(once);
  });

  it("does not mutate the host object", () => {
    const host = { permissions: { deny: ["x"] } };
    const snapshot = JSON.stringify(host);
    mergeSettings(host, framework);
    expect(JSON.stringify(host)).toBe(snapshot);
  });
});

describe("mergeMcpServers — add framework server, keep the host's", () => {
  const framework = {
    mcpServers: { "rb-ai-team-tools": { command: "npx", args: ["tsx", "aiteam/mcp/server.ts"] } },
  };

  it("adds the framework server when absent", () => {
    const merged = mergeMcpServers({ mcpServers: { mine: {} } }, framework);
    expect(merged.mcpServers["rb-ai-team-tools"]).toBeDefined();
    expect(merged.mcpServers["mine"]).toBeDefined();
  });

  it("is idempotent", () => {
    const once = mergeMcpServers({}, framework);
    expect(mergeMcpServers(once, framework)).toEqual(once);
  });

  it("does not overwrite a host server of the same name", () => {
    const host = { mcpServers: { "rb-ai-team-tools": { command: "custom" } } };
    expect(mergeMcpServers(host, framework).mcpServers["rb-ai-team-tools"].command).toBe("custom");
  });
});

describe("mcpServersAdded / mcpAddedLabel — o que o merge vai acrescentar, para o rótulo do install", () => {
  const framework = { mcpServers: { "rb-ai-team-tools": { command: "a" }, "trello-tools": { command: "b" } } };

  it("lista só os servidores que o hospedeiro ainda não tem, na ordem do framework", () => {
    expect(mcpServersAdded({}, framework)).toEqual(["rb-ai-team-tools", "trello-tools"]);
    expect(mcpServersAdded({ mcpServers: { "rb-ai-team-tools": {} } }, framework)).toEqual(["trello-tools"]);
    expect(mcpServersAdded({ mcpServers: { "trello-tools": { command: "local" } } }, framework)).toEqual(["rb-ai-team-tools"]);
    expect(mcpServersAdded({ mcpServers: { "rb-ai-team-tools": {}, "trello-tools": {} } }, framework)).toEqual([]);
    expect(mcpServersAdded(null, framework)).toEqual(["rb-ai-team-tools", "trello-tools"]);
  });

  it("concorda com o mergeMcpServers: o que a lista diz é o que o merge de fato acrescenta", () => {
    for (const host of [{}, { mcpServers: { "trello-tools": {} } }, { mcpServers: { x: {} } }]) {
      const merged = mergeMcpServers(host, framework);
      const before = Object.keys((host as { mcpServers?: object }).mcpServers ?? {});
      expect(Object.keys(merged.mcpServers).filter((k) => !before.includes(k))).toEqual(mcpServersAdded(host, framework));
    }
  });

  it("o rótulo nomeia o arquivo e os servidores, no singular e no plural", () => {
    expect(mcpAddedLabel(".mcp.json", {}, framework)).toBe(".mcp.json — added the rb-ai-team-tools and trello-tools servers");
    expect(mcpAddedLabel(".mcp.json", { mcpServers: { "rb-ai-team-tools": {} } }, framework)).toBe(".mcp.json — added the trello-tools server");
    expect(mcpAddedLabel(".cursor/mcp.json", { mcpServers: { "trello-tools": {} } }, framework)).toBe(".cursor/mcp.json — added the rb-ai-team-tools server");
  });
});

describe("ensureImportLine — idempotent CLAUDE.md/AGENTS.md injection", () => {
  it("appends the import when absent", () => {
    expect(ensureImportLine("# My project\n", "@aiteam/CLAUDE.md")).toContain("@aiteam/CLAUDE.md");
  });

  it("does not append twice", () => {
    const once = ensureImportLine("# My project\n", "@aiteam/CLAUDE.md");
    expect(ensureImportLine(once, "@aiteam/CLAUDE.md")).toBe(once);
  });

  it("creates content from empty", () => {
    expect(ensureImportLine("", "@aiteam/AGENTS.md")).toContain("@aiteam/AGENTS.md");
  });
});

// git accepts core.hooksPath as relative OR absolute. install used to
// path.join(root, hooksPath, hook) unconditionally, which glued two roots
// together for an absolute value and died: ENOENT ...'C:\repo\C:\repo\.githooks'
// (observed in jusbraz/crm). Windows and POSIX disagree on what "absolute"
// looks like, so both shapes are pinned here — the same config must behave the
// same wherever the installer runs.
describe("resolveHookPath — respect an absolute core.hooksPath", () => {
  const norm = (s: string) => s.replace(/\\/g, "/");

  it("joins a RELATIVE hooksPath against the repo root", () => {
    expect(norm(resolveHookPath("/repo", ".githooks", "pre-commit"))).toBe("/repo/.githooks/pre-commit");
  });

  it("does NOT glue the root onto a POSIX-absolute hooksPath", () => {
    expect(norm(resolveHookPath("/repo", "/etc/hooks", "pre-commit"))).toBe("/etc/hooks/pre-commit");
  });

  it("does NOT glue the root onto a WINDOWS-absolute hooksPath", () => {
    const out = norm(resolveHookPath("C:/repo", "C:\\repo\\.githooks", "pre-commit"));
    expect(out).toBe("C:/repo/.githooks/pre-commit");
    expect(out).not.toContain("repo/C:");
  });
});

describe("planHookChaining — never clobber host hooks", () => {
  it("sets hooksPath when the host has none", () => {
    expect(planHookChaining("", "aiteam/githooks").action).toBe("set");
  });

  it("is a noop when already pointing at the framework hooks", () => {
    expect(planHookChaining("aiteam/githooks", "aiteam/githooks").action).toBe("noop");
  });

  it("routes (chains) when the host already has a different hooksPath", () => {
    expect(planHookChaining(".husky", "aiteam/githooks").action).toBe("router");
  });

  // An ABSOLUTE path ending at the framework's own hooks dir is the canonical
  // value written non-canonically — git resolves a RELATIVE core.hooksPath per
  // working tree, so the absolute form silently pins every worktree to the main
  // checkout's hooks. Treating it as a foreign host dir (router) made install
  // try to chain the framework's hooks into themselves, and path.join(root,
  // <absolute>) then yields a nonsense path (ENOENT). Self-heal to relative.
  it("normalizes an absolute path that already reaches the framework hooks", () => {
    const plan = planHookChaining("C:\\devops\\source\\rb-ai-team\\aiteam\\githooks", "aiteam/githooks");
    expect(plan.action).toBe("set");
    expect(plan).toHaveProperty("hooksPath", "aiteam/githooks");
  });

  it("normalizes a POSIX absolute path to the framework hooks too", () => {
    expect(planHookChaining("/home/me/proj/aiteam/githooks", "aiteam/githooks").action).toBe("set");
  });

  it("still routes a host dir whose name merely resembles the framework's", () => {
    expect(planHookChaining(".husky/aiteam-githooks", "aiteam/githooks").action).toBe("router");
  });
});

describe("ensureChainLine — chain the framework hook without clobbering the host's", () => {
  it("appends a call to the framework hook, preserving existing content", () => {
    const out = ensureChainLine("#!/bin/sh\necho hi\n", "aiteam/githooks", "pre-commit");
    expect(out).toContain("echo hi");
    expect(out).toContain("aiteam/githooks/pre-commit");
    expect(out).toContain('"$@"');
  });

  it("is idempotent — chaining twice does not duplicate the call", () => {
    const once = ensureChainLine("#!/bin/sh\n", "aiteam/githooks", "pre-commit");
    expect(ensureChainLine(once, "aiteam/githooks", "pre-commit")).toBe(once);
  });

  it("adds a shebang when the host hook is empty", () => {
    expect(ensureChainLine("", "aiteam/githooks", "post-checkout").startsWith("#!")).toBe(true);
  });
});

// rb-ai-team#37: o beads-guard (aiteam/hooks/beads-guard.mjs) nega no Claude
// Code o Write/Edit que o pre-commit recusaria — visão gerada, arquivo de outra
// branch. Entrada própria, ao lado da do infra-kb-guard no mesmo matcher.
describe("FRAMEWORK_SETTINGS — carrega o beads-guard", () => {
  const GUARD = "node aiteam/hooks/beads-guard.mjs";
  const has = (pre: { matcher: string; hooks: { command: string }[] }[], command: string) =>
    pre.some((e) => e.matcher === "Write|Edit" && e.hooks.some((h) => h.command === command));

  it("declara Write|Edit -> beads-guard.mjs", () => {
    expect(has(FRAMEWORK_SETTINGS.hooks.PreToolUse, GUARD)).toBe(true);
  });

  it("um consumidor com o infra-kb-guard ganha o beads-guard sem perder nada, e o merge é idempotente", () => {
    const host = {
      hooks: { PreToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "node aiteam/hooks/infra-kb-guard.mjs" }] }] },
    };
    const merged = mergeSettings(host, FRAMEWORK_SETTINGS);
    expect(has(merged.hooks.PreToolUse, GUARD)).toBe(true);
    expect(has(merged.hooks.PreToolUse, "node aiteam/hooks/infra-kb-guard.mjs")).toBe(true);
    expect(mergeSettings(merged, FRAMEWORK_SETTINGS)).toEqual(merged);
  });
});

// rb-ai-team#37: as visões do .beads são regeneradas por quatro hooks. Num
// hospedeiro com core.hooksPath próprio (modo roteador), um hook fora desta
// lista nunca roda — e a visão fica velha sem ninguém saber.
describe("CHAINED_HOOKS — os hooks que o roteador encadeia", () => {
  it("inclui os quatro hooks que regeneram as visões do .beads", () => {
    for (const h of ["post-checkout", "post-merge", "post-commit", "post-rewrite"]) expect(CHAINED_HOOKS).toContain(h);
    expect(CHAINED_HOOKS).toContain("pre-commit");
    expect(CHAINED_HOOKS).toContain("pre-push");
  });
});

describe("ensurePointerFile — non-clobbering adapter pointer for shared host files", () => {
  const block = "# rb-ai-team\n\nRead and obey AGENTS.md.\n";

  it("appends the block when the file is empty", () => {
    expect(ensurePointerFile("", block)).toBe(block);
  });

  it("appends the block after the host's own content", () => {
    const out = ensurePointerFile("# My own rules\ndo X\n", block);
    expect(out).toContain("# My own rules");
    expect(out).toContain("do X");
    expect(out).toContain(block.trim());
  });

  // The host file is CRLF on a Windows checkout (git autocrlf), but the block we
  // compare against is authored with LF — a raw substring match then never sees
  // the block it just wrote and appends a duplicate on every install run. The
  // LF-only fixtures above are blind to this, so pin the CRLF case explicitly.
  it("is idempotent on a CRLF host file (Windows checkout)", () => {
    const block = "# rb-ai-team\n\nRead AGENTS.md before writing code.\n";
    const crlf = ensurePointerFile("", block).replace(/\n/g, "\r\n");
    expect(ensurePointerFile(crlf, block)).toBe(crlf);
  });

  it("is idempotent — does not append a second copy", () => {
    const once = ensurePointerFile("# My own rules\n", block);
    expect(ensurePointerFile(once, block)).toBe(once);
  });

  it("does not mutate unrelated host content when re-run", () => {
    const host = "# My own rules\ndo X\n";
    const once = ensurePointerFile(host, block);
    const twice = ensurePointerFile(once, block);
    expect(twice).toBe(once);
    expect(twice).toContain("do X");
  });
});

// Regressão do review final da branch: o hook PreToolUse(Write|Edit) que injeta
// o extrato da KB de infra (infra-kb-guard.mjs) foi wireado em .claude/settings.json
// (dogfood deste repo) mas ficou de fora de FRAMEWORK_SETTINGS — o objeto que
// install.mjs de fato funde em CADA consumidor. Sem essa entrada, o rollout
// planejado ("camadas 1 + 2") entrega só a camada 1 (SessionStart) pra sempre:
// a metade do hook de edição nunca chega em consumidor nenhum, e nada acusa.
describe("FRAMEWORK_SETTINGS — carrega a entrada do infra-kb-guard", () => {
  const hasInfraKbGuard = (pre: { matcher: string; hooks: { command: string }[] }[]) =>
    pre.some(
      (e) => e.matcher === "Write|Edit" && e.hooks.some((h) => h.command === "node aiteam/hooks/infra-kb-guard.mjs")
    );

  it("declara o hook Write|Edit -> infra-kb-guard.mjs", () => {
    expect(hasInfraKbGuard(FRAMEWORK_SETTINGS.hooks.PreToolUse)).toBe(true);
  });

  // A prova exata que o reviewer usou pra achar o bug: mergeSettings({}, FRAMEWORK_SETTINGS)
  // é o que install.mjs roda contra um consumidor novo. Se essa saída não carrega
  // o guard, nenhum consumidor jamais o recebe — não importa o que .claude/settings.json
  // deste próprio repo tenha (esse é só o dogfood, install.mjs nunca o lê).
  it("mergeSettings({}, FRAMEWORK_SETTINGS) entrega o guard a um consumidor novo", () => {
    const merged = mergeSettings({}, FRAMEWORK_SETTINGS);
    expect(hasInfraKbGuard(merged.hooks.PreToolUse)).toBe(true);
    // E não deve perder o tier-guard no processo.
    expect(
      merged.hooks.PreToolUse.some(
        (e: any) => e.matcher === "Bash" && e.hooks.some((h: any) => h.command === "node aiteam/hooks/tier-guard.mjs")
      )
    ).toBe(true);
  });
});

// Issue #12: o tier-guard só era registrado para o Bash. A entrada nova é
// PRÓPRIA (matcher diferente) e não uma troca do matcher do Bash: mergeSettings
// é idempotente por matcher+command, então um consumidor instalado antes mantém
// a entrada Bash e ganha esta — em vez de acabar com o guard duas vezes no Bash.
describe("FRAMEWORK_SETTINGS — tier-guard em toda ferramenta que executa comando", () => {
  const GUARD = "node aiteam/hooks/tier-guard.mjs";
  const SHELLS = "PowerShell|Monitor|mcp__terminal__run_in_terminal";
  const guardMatchers = (pre: { matcher: string; hooks: { command: string }[] }[]) =>
    pre.filter((e) => e.hooks.some((h) => h.command === GUARD)).map((e) => e.matcher);

  it("declara a entrada do Bash e uma entrada própria para PowerShell, Monitor e o terminal do app", () => {
    expect(guardMatchers(FRAMEWORK_SETTINGS.hooks.PreToolUse)).toEqual(["Bash", SHELLS]);
  });

  it("um consumidor instalado antes (só a entrada Bash) ganha a nova sem duplicar a do Bash", () => {
    const legacy = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: GUARD }] }] } };
    const merged = mergeSettings(legacy, FRAMEWORK_SETTINGS);
    expect(guardMatchers(merged.hooks.PreToolUse)).toEqual(["Bash", SHELLS]);
    expect(mergeSettings(merged, FRAMEWORK_SETTINGS)).toEqual(merged);
  });
});

// Issue 38: o subagente com isolation: "worktree" nasce de origin/<default>
// (worktree.baseRef: "fresh", o padrão), sem os commits locais ainda não
// empurrados — e este projeto não faz push automático. O valor "head" parte do
// HEAD local. Os valores válidos são os do schema oficial do settings
// (https://json.schemastore.org/claude-code-settings.json: enum fresh|head) e
// de code.claude.com/docs/en/worktrees e settings-reference; o "remote"/"local"
// que uma página do doc chegou a mostrar NÃO é aceito por eles.
describe("FRAMEWORK_SETTINGS — worktree.baseRef (issue 38)", () => {
  const settings = FRAMEWORK_SETTINGS as unknown as { worktree?: { baseRef?: string } };

  it("o framework pede worktrees a partir do HEAD local, e o valor é um dos do schema oficial", () => {
    expect(settings.worktree?.baseRef).toBe("head");
    expect(["fresh", "head"]).toContain(settings.worktree?.baseRef);
  });

  it("um consumidor sem worktree no settings recebe o baseRef", () => {
    expect(mergeSettings({}, FRAMEWORK_SETTINGS)).toMatchObject({ worktree: { baseRef: "head" } });
  });

  it("a escolha do hospedeiro vale: um baseRef explícito não é sobrescrito", () => {
    const host = { worktree: { baseRef: "fresh" } };
    expect(mergeSettings(host, FRAMEWORK_SETTINGS)).toMatchObject({ worktree: { baseRef: "fresh" } });
  });

  it("acrescenta o baseRef sem perder as outras chaves de worktree do hospedeiro", () => {
    const host = { worktree: { symlinkDirectories: ["node_modules"], sparsePaths: ["src"] } };
    const merged = mergeSettings(host, FRAMEWORK_SETTINGS) as unknown as { worktree: Record<string, unknown> };
    expect(merged.worktree).toEqual({ symlinkDirectories: ["node_modules"], sparsePaths: ["src"], baseRef: "head" });
  });

  it("é idempotente e não muda o objeto do hospedeiro", () => {
    const host = { worktree: { sparsePaths: ["src"] } };
    const snapshot = JSON.parse(JSON.stringify(host));
    const once = mergeSettings(host, FRAMEWORK_SETTINGS);
    expect(host).toEqual(snapshot);
    expect(mergeSettings(once, FRAMEWORK_SETTINGS)).toEqual(once);
  });

  it("um worktree do hospedeiro que não é objeto fica como está (config dele, não do framework)", () => {
    const merged = mergeSettings({ worktree: "xyz" } as never, FRAMEWORK_SETTINGS) as unknown as { worktree: unknown };
    expect(merged.worktree).toBe("xyz");
  });

  it("o settings.json deste repo (dogfood) tem o mesmo baseRef do framework", () => {
    const dogfood = JSON.parse(readFileSync(resolve(repoRoot(), ".claude", "settings.json"), "utf8"));
    expect(dogfood.worktree).toEqual({ baseRef: settings.worktree?.baseRef });
  });
});

// Issue 38: as worktrees dos subagentes ficam em .claude/worktrees/<nome>/ dentro
// do próprio repo; sem a regra no .gitignore o checkout principal as vê como
// árvore não rastreada (e um `git add -A` ali as empacotaria).
describe("ensureGitignoreEntry — .claude/worktrees/ (issue 38)", () => {
  const LINE = ".claude/worktrees/";
  const COMMENT = "# Claude Code: worktrees dos subagentes (isolation: worktree)";

  it("arquivo vazio ou ausente: cria só o comentário e a regra", () => {
    expect(ensureGitignoreEntry("", LINE, COMMENT)).toBe(`${COMMENT}\n${LINE}\n`);
    expect(ensureGitignoreEntry(undefined, LINE, COMMENT)).toBe(`${COMMENT}\n${LINE}\n`);
  });

  it("acrescenta no fim, separado por uma linha em branco, sem tocar no que o hospedeiro tinha", () => {
    const host = "node_modules/\ndist/\n";
    expect(ensureGitignoreEntry(host, LINE, COMMENT)).toBe(`${host}\n${COMMENT}\n${LINE}\n`);
  });

  it("arquivo sem quebra de linha no fim", () => {
    expect(ensureGitignoreEntry("dist/", LINE, COMMENT)).toBe(`dist/\n\n${COMMENT}\n${LINE}\n`);
  });

  it("é idempotente", () => {
    const once = ensureGitignoreEntry("dist/\n", LINE, COMMENT);
    expect(ensureGitignoreEntry(once, LINE, COMMENT)).toBe(once);
  });

  it.each([".claude/worktrees/", ".claude/worktrees", "/.claude/worktrees/", ".claude/worktrees/*", ".claude/worktrees/**", "  .claude/worktrees/  "])(
    "já coberto por %j: não acrescenta nada",
    (existing) => {
      const host = `dist/\n${existing}\n`;
      expect(ensureGitignoreEntry(host, LINE, COMMENT)).toBe(host);
    },
  );

  it("comentário e negação com o mesmo texto não contam como regra", () => {
    const host = "# .claude/worktrees/\n!.claude/worktrees/\n";
    expect(ensureGitignoreEntry(host, LINE, COMMENT)).toContain(`\n${LINE}\n`);
    expect(ensureGitignoreEntry(host, LINE, COMMENT).split("\n").filter((l) => l === LINE)).toHaveLength(1);
  });

  it("arquivo em CRLF continua em CRLF", () => {
    const out = ensureGitignoreEntry("dist/\r\n", LINE, COMMENT);
    expect(out).toBe(`dist/\r\n\r\n${COMMENT}\r\n${LINE}\r\n`);
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("o .gitignore deste repo (dogfood) já tem a regra", () => {
    const gitignore = readFileSync(resolve(repoRoot(), ".gitignore"), "utf8");
    expect(ensureGitignoreEntry(gitignore, WORKTREES_IGNORE, COMMENT)).toBe(gitignore);
  });
});

describe("planInfraRemote", () => {
  const pointer = { remote: "vps-infra", url: "git@github.com:acme/vps-infra.git", ref: "main", entry: "README.md" };

  it("não faz nada quando o projeto não declara o slot", () => {
    expect(planInfraRemote(null, ["origin"]).action).toBe("skip");
  });

  it("adiciona o remote quando ele falta", () => {
    expect(planInfraRemote(pointer, ["origin", "upstream"])).toEqual({
      action: "add",
      remote: "vps-infra",
      url: "git@github.com:acme/vps-infra.git",
    });
  });

  it("é idempotente quando o remote já existe", () => {
    expect(planInfraRemote(pointer, ["origin", "vps-infra"]).action).toBe("noop");
  });

  // Sem url não há o que adicionar — mas o slot existe, então o operador
  // precisa saber por que nada aconteceu. Silêncio aqui vira um doctor
  // vermelho sem explicação.
  it("explica quando não há url para criar o remote", () => {
    const semUrl = { ...pointer, url: null };
    const r = planInfraRemote(semUrl, ["origin"]);
    expect(r.action).toBe("skip");
    expect(r.reason).toMatch(/url/i);
  });
});

// O .claude/tier-rules.json fica fora de aiteam/ e não viaja com o vendor: o
// install o semeia a partir de aiteam/templates/tier-rules.json. Puro — o shell
// lê os dois arquivos e grava o resultado.
describe("planTierRulesSeed", () => {
  const TEMPLATE = '{\n  "tier3": { "patterns": ["x"] }\n}\n';

  it("semeia o template quando o projeto não tem o arquivo", () => {
    expect(planTierRulesSeed(null, TEMPLATE)).toEqual({ action: "seed", content: TEMPLATE });
    expect(planTierRulesSeed(undefined, TEMPLATE)).toEqual({ action: "seed", content: TEMPLATE });
  });

  it("nunca sobrescreve: o arquivo do projeto, customizado, fica intocado", () => {
    expect(planTierRulesSeed('{"tier3":{"patterns":["meu"]}}', TEMPLATE).action).toBe("noop");
  });

  // O arquivo é do projeto, mesmo quebrado: quem o conserta é o dono (o guard já
  // protege pela cópia canônica e o doctor reprova).
  it.each([
    ["vazio", ""],
    ["com JSON inválido", "{ nope"],
    ["com estrutura inválida", "[]"],
  ])("nunca sobrescreve nem o arquivo existente %s", (_label, existing) => {
    expect(planTierRulesSeed(existing, TEMPLATE).action).toBe("noop");
  });

  it.each([[null], [undefined], [""]])("sem template legível (%j) não semeia e diz por quê", (template) => {
    const plan = planTierRulesSeed(null, template as string | null);
    expect(plan.action).toBe("skip");
    expect(plan.reason).toMatch(/template/i);
  });

  it("com o arquivo do projeto presente, a falta do template não importa", () => {
    expect(planTierRulesSeed("{}", null).action).toBe("noop");
  });
});

// Onda 2, item 7 (F13): o gate-edit-guard pede confirmação na edição dos arquivos do gate. Ele cobre as
// quatro ferramentas de edição (o beads-guard e o infra-kb-guard só olham Write|Edit), então tem entrada
// PRÓPRIA no FRAMEWORK_SETTINGS: um consumidor instalado antes a ganha sem mexer nas outras, e o merge
// é idempotente. Sem a entrada no FRAMEWORK_SETTINGS nenhum consumidor a recebe, seja o que for que o
// .claude/settings.json deste repo (o dogfood) tenha.
describe("FRAMEWORK_SETTINGS — carrega o gate-edit-guard (F13)", () => {
  const GUARD = "node aiteam/hooks/gate-edit-guard.mjs";
  const MATCHER = "Write|Edit|MultiEdit|NotebookEdit";
  type Pre = { matcher: string; hooks: { command: string }[] }[];
  const entries = (pre: Pre) => pre.filter((e) => e.hooks.some((h) => h.command === GUARD));

  it("declara as quatro ferramentas de edição -> gate-edit-guard.mjs, numa entrada só", () => {
    const found = entries(FRAMEWORK_SETTINGS.hooks.PreToolUse as Pre);
    expect(found).toHaveLength(1);
    expect(found[0]!.matcher).toBe(MATCHER);
  });

  it("mergeSettings({}, FRAMEWORK_SETTINGS) entrega o guard a um consumidor novo", () => {
    const merged = mergeSettings({}, FRAMEWORK_SETTINGS);
    expect(entries(merged.hooks.PreToolUse as Pre)).toHaveLength(1);
  });

  it("um consumidor com os outros guards de Write|Edit ganha o novo sem perder nada, e o merge é idempotente", () => {
    const host = {
      hooks: {
        PreToolUse: [
          { matcher: "Write|Edit", hooks: [{ type: "command", command: "node aiteam/hooks/infra-kb-guard.mjs" }] },
          { matcher: "Write|Edit", hooks: [{ type: "command", command: "node aiteam/hooks/beads-guard.mjs" }] },
          { matcher: "Bash", hooks: [{ type: "command", command: "node aiteam/hooks/tier-guard.mjs" }] },
        ],
      },
    };
    const merged = mergeSettings(host, FRAMEWORK_SETTINGS);
    const commands = (merged.hooks.PreToolUse as Pre).flatMap((e) => e.hooks.map((h) => h.command));
    for (const kept of ["node aiteam/hooks/infra-kb-guard.mjs", "node aiteam/hooks/beads-guard.mjs", "node aiteam/hooks/tier-guard.mjs", GUARD]) {
      expect(commands).toContain(kept);
    }
    expect(entries(merged.hooks.PreToolUse as Pre)).toHaveLength(1);
    expect(mergeSettings(merged, FRAMEWORK_SETTINGS)).toEqual(merged);
  });

  it("o settings.json deste repo (dogfood) tem a mesma entrada do framework", () => {
    const dogfood = JSON.parse(readFileSync(resolve(repoRoot(), ".claude", "settings.json"), "utf8"));
    const found = entries(dogfood.hooks.PreToolUse as Pre);
    expect(found).toHaveLength(1);
    expect(found[0]!.matcher).toBe(MATCHER);
  });
});
