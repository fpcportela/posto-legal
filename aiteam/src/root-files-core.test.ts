import { describe, expect, it } from "vitest";
import {
  GITATTRIBUTES_EOL_PATTERNS,
  MARKER_PATH,
  ROOT_FILES,
  ROOT_SOURCES,
  SHIMS,
  STALE_DAYS,
  checkCiTemplateSteps,
  checkGitattributesEol,
  checkRootFilesUpstream,
  checkSchemaPointer,
  checkShimImports,
  checkUpstreamRef,
  hasSchemaPointer,
  parseUpstreamMarker,
  renderRootChanges,
  renderUpstreamMarker,
  type RootChanges,
  type RootFilesFacts,
} from "./root-files-core.mjs";

// O julgamento puro dos arquivos de raiz × upstream (rb-ai-team#39). Cada check recebe os textos
// que a leitura (root-files-io.mjs) trouxe; aqui nada toca disco nem git.

const REF = "upstream/main";
const SHA = "a9d862f0123456789abcdef0123456789abcdef0";

describe("ROOT_FILES — os arquivos de raiz que o framework distribui", () => {
  it("lista os oito, cada um com a fonte que o upstream tem", () => {
    expect(ROOT_FILES.map((f) => f.path)).toEqual([
      ".beads/SCHEMA.md",
      "AGENTS.md",
      "CLAUDE.md",
      "GEMINI.md",
      ".gitattributes",
      ".claude/tier-rules.json",
      ".github/workflows/ci.yml",
      ".github/workflows/deploy.yml",
    ]);
    for (const f of ROOT_FILES) expect(f.upstream.length, f.path).toBeGreaterThan(0);
  });

  it("os modelos copy-once vêm de aiteam/templates/, não da raiz do upstream (a raiz dele é o CI do próprio framework)", () => {
    const source = (p: string) => ROOT_FILES.find((f) => f.path === p)?.upstream;
    expect(source(".github/workflows/ci.yml")).toEqual(["aiteam/templates/ci.yml.example"]);
    expect(source(".github/workflows/deploy.yml")).toEqual(["aiteam/templates/deploy.yml.example"]);
    expect(source(".claude/tier-rules.json")).toEqual(["aiteam/templates/tier-rules.json"]);
  });

  it("ROOT_SOURCES é o conjunto das fontes, sem repetir", () => {
    expect(ROOT_SOURCES).toContain(".beads/SCHEMA.md");
    expect(ROOT_SOURCES).toContain("aiteam/templates/ci.yml.example");
    expect(new Set(ROOT_SOURCES).size).toBe(ROOT_SOURCES.length);
  });

  it("o marcador mora em aiteam/ (ADR 0002: a pegada na raiz do hospedeiro é o mínimo)", () => {
    expect(MARKER_PATH).toBe("aiteam/UPSTREAM");
  });
});

describe("parseUpstreamMarker / renderUpstreamMarker", () => {
  it("ida e volta: o que o sync grava é o que o doctor lê", () => {
    const text = renderUpstreamMarker({ commit: SHA, date: "2026-10-06" });
    expect(parseUpstreamMarker(text)).toEqual({ state: "ok", commit: SHA, date: "2026-10-06" });
  });

  it("o cabeçalho é comentário: as duas linhas de dados bastam ao leitor", () => {
    const text = renderUpstreamMarker({ commit: SHA, date: "2026-10-06" });
    expect(text.split("\n").filter((l) => l.startsWith("#")).length).toBeGreaterThan(0);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain(`commit: ${SHA}\n`);
  });

  it("a data é opcional", () => {
    expect(parseUpstreamMarker(renderUpstreamMarker({ commit: SHA }))).toEqual({ state: "ok", commit: SHA, date: null });
  });

  it("tolera CRLF (checkout Windows com core.autocrlf)", () => {
    const text = renderUpstreamMarker({ commit: SHA, date: "2026-10-06" }).replace(/\n/g, "\r\n");
    expect(parseUpstreamMarker(text)).toEqual({ state: "ok", commit: SHA, date: "2026-10-06" });
  });

  // QA da #39 (A5): o Out-File do PowerShell 5 e vários editores do Windows gravam UTF-8 com BOM, e o doctor e a CLI
  // leem do disco: com o \uFEFF na frente a linha `commit:` da primeira linha não casava e o marcador dava `malformed`.
  it("tolera o BOM do UTF-8 (a primeira linha pode ser o commit:), com LF ou CRLF", () => {
    const expected = { state: "ok", commit: SHA, date: "2026-10-06" };
    expect(parseUpstreamMarker(`\uFEFFcommit: ${SHA}\ndate: 2026-10-06\n`)).toEqual(expected);
    expect(parseUpstreamMarker(`\uFEFFcommit: ${SHA}\r\ndate: 2026-10-06\r\n`)).toEqual(expected);
    expect(parseUpstreamMarker(`\uFEFF${renderUpstreamMarker({ commit: SHA, date: "2026-10-06" })}`)).toEqual(expected);
    expect(parseUpstreamMarker(`\uFEFF`)).toEqual({ state: "absent" });
    expect(parseUpstreamMarker(`\uFEFFnada de commit\n`)).toEqual({ state: "malformed" });
  });

  it("aceita um sha abreviado (7 a 64 hex), recusa o que não é sha", () => {
    expect(parseUpstreamMarker("commit: a9d862f\n")).toEqual({ state: "ok", commit: "a9d862f", date: null });
    expect(parseUpstreamMarker("commit: a9d86\n")).toEqual({ state: "malformed" });
    expect(parseUpstreamMarker("commit: main\n")).toEqual({ state: "malformed" });
    expect(parseUpstreamMarker("commit: A9D862F\n")).toEqual({ state: "malformed" });
  });

  it("sem texto → absent; com texto sem a linha commit: → malformed (um comentário solto não conta)", () => {
    expect(parseUpstreamMarker(null)).toEqual({ state: "absent" });
    expect(parseUpstreamMarker("")).toEqual({ state: "absent" });
    expect(parseUpstreamMarker("  \n")).toEqual({ state: "absent" });
    expect(parseUpstreamMarker("# commit: a9d862f\n")).toEqual({ state: "malformed" });
    expect(parseUpstreamMarker("data: 2026-10-06\n")).toEqual({ state: "malformed" });
  });
});

describe("renderRootChanges — o que mudou na raiz desde o último sync", () => {
  const previous = { commit: "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", date: "2026-07-17" };
  const current = { commit: SHA, date: "2026-10-06" };

  it("sem marcador: diz que não dá para medir e manda conferir tudo", () => {
    const out = renderRootChanges({ status: "no-marker", previous: null, current, entries: [] });
    expect(out).toMatch(/aiteam\/UPSTREAM/);
    expect(out).toMatch(/não dá para medir/);
    expect(out).toMatch(/\*\*todos\*\* os itens do checklist/);
    expect(out).toMatch(/doctor/);
  });

  it("marcador sem a linha commit: → também não dá para medir", () => {
    const out = renderRootChanges({ status: "malformed" });
    expect(out).toMatch(/não dá para medir/);
    expect(out).toMatch(/commit: <sha>/);
  });

  it("marcador que o upstream local não conhece → não dá para medir, e diz o sha", () => {
    const out = renderRootChanges({ status: "unknown-commit", previous, current });
    expect(out).toMatch(/não dá para medir/);
    expect(out).toContain("1111111");
    expect(out).toMatch(/git fetch upstream/);
  });

  it("mesmo commit → nada mudou", () => {
    const out = renderRootChanges({ status: "same", previous: current, current });
    expect(out).toMatch(/Nada mudou/);
    expect(out).toContain("a9d862f");
  });

  it("sem commit que tenha tocado a raiz → diz isso, com os dois commits", () => {
    const out = renderRootChanges({ status: "changes", previous, current, entries: [] });
    expect(out).toMatch(/Nenhum commit do upstream tocou arquivos de raiz/);
    expect(out).toContain("1111111");
    expect(out).toContain("a9d862f");
  });

  it("lista cada commit com a data, o assunto e os arquivos de raiz que ele tocou", () => {
    const out = renderRootChanges({
      status: "changes",
      previous,
      current,
      entries: [
        { hash: "8562965", date: "2026-07-17", subject: "docs(beads): corrige exemplos", files: [".beads/SCHEMA.md"] },
        { hash: "f0b19a3", date: "2026-10-03", subject: "docs(beads): §8", files: [".beads/SCHEMA.md", "AGENTS.md"] },
      ],
    });
    expect(out).toMatch(/2 commit\(s\)/);
    expect(out).toContain("- `8562965` 2026-07-17 docs(beads): corrige exemplos — `.beads/SCHEMA.md`");
    expect(out).toContain("`.beads/SCHEMA.md`, `AGENTS.md`");
  });

  it("a frase final de 'como seguir' é de quem chama (o sync e a CLI dizem coisas diferentes)", () => {
    expect(renderRootChanges({ status: "no-marker" }, { next: "Este sync grava o marcador." })).toMatch(/\n\nEste sync grava o marcador\.$/);
    expect(renderRootChanges({ status: "no-marker" })).not.toMatch(/\n\n$/);
  });
});

describe("checkSchemaPointer — .beads/SCHEMA.md × upstream", () => {
  const POINTER = "# .beads — contrato\n> O formato está em [`aiteam/docs/beads-schema.md`](../aiteam/docs/beads-schema.md).\n";
  const COPY = "# .beads — contrato\n## 1. Visão geral\n## 9. Arquivamento\n";

  it("o consumidor tem o apontador → PASS", () => {
    const r = checkSchemaPointer({ ref: REF, local: POINTER + "\n## Convenções locais\n- trello:\n", remote: POINTER });
    expect(r).toMatchObject({ name: ".beads/SCHEMA.md × upstream", pass: true });
    expect(r.warn).toBeUndefined();
  });

  it("o consumidor ainda tem a cópia do contrato (o caso do mesa-crm) → WARN com o que fazer, nunca FAIL", () => {
    const r = checkSchemaPointer({ ref: REF, local: COPY, remote: POINTER });
    expect(r.pass).toBe(true);
    expect(r.warn).toBe(true);
    expect(r.detail).toMatch(/não aponta para aiteam\/docs\/beads-schema\.md/);
    expect(r.detail).toContain(`git show ${REF}:.beads/SCHEMA.md`);
    expect(r.detail).toMatch(/apêndice/);
  });

  it("o consumidor não tem o arquivo → WARN", () => {
    const r = checkSchemaPointer({ ref: REF, local: null, remote: POINTER });
    expect(r).toMatchObject({ pass: true, warn: true });
    expect(r.detail).toMatch(/não existe/);
  });

  it("o apontador com CRLF e com BOM também conta", () => {
    expect(checkSchemaPointer({ ref: REF, local: POINTER.replace(/\n/g, "\r\n"), remote: POINTER }).warn).toBeUndefined();
    expect(checkSchemaPointer({ ref: REF, local: `\uFEFF${POINTER}`, remote: POINTER }).warn).toBeUndefined();
  });

  // QA da #39 (A3): uma cópia legada do contrato que CITA o caminho em prosa dava PASS falso. O apontador é o
  // blockquote do topo do arquivo (o do upstream: linha 3), não qualquer menção.
  describe("o apontador é um blockquote nas primeiras linhas, não uma menção ao caminho", () => {
    const filler = Array.from({ length: 30 }, (_, i) => `linha ${i + 1} do contrato`).join("\n");

    it("hasSchemaPointer: blockquote nas primeiras linhas conta; prosa, código e blockquote lá embaixo não", () => {
      expect(hasSchemaPointer(POINTER)).toBe(true);
      expect(hasSchemaPointer(`> [\`aiteam/docs/beads-schema.md\`](../aiteam/docs/beads-schema.md)\n${filler}`)).toBe(true);
      expect(hasSchemaPointer(`${COPY}\nO contrato novo está em aiteam/docs/beads-schema.md, leia lá.\n`)).toBe(false);
      expect(hasSchemaPointer(`# .beads — contrato\n\nVeja \`aiteam/docs/beads-schema.md\` para o formato.\n${filler}`)).toBe(false);
      expect(hasSchemaPointer(`# .beads — contrato\n${filler}\n> aiteam/docs/beads-schema.md\n`)).toBe(false);
      expect(hasSchemaPointer(`# .beads — contrato\n\n- aiteam/docs/beads-schema.md\n`)).toBe(false);
      expect(hasSchemaPointer("")).toBe(false);
      expect(hasSchemaPointer(null)).toBe(false);
    });

    // O crm de verdade: a cópia legada abre com um blockquote que explica o modo legado e LINKA o contrato novo (linha 5),
    // e segue com as seções numeradas do contrato antigo. Um blockquote no topo que cita o caminho não basta: o apontador
    // não carrega o contrato inteiro.
    const CRM_HEADER = [
      "# .beads/ YAML Schema — legacy model (Mesa)",
      "",
      "> **This repo is still on the legacy beads model:** one `.beads/active.yaml`, tracked by git and",
      "> edited by hand. The framework's contract is the",
      "> per-bead model — [`aiteam/docs/beads-schema.md`](../aiteam/docs/beads-schema.md), one file per",
      "> bead and branch — and it applies here only after the migration (§12).",
      "",
    ].join("\n");
    const SECTIONS = ["## 1. Top-Level Structure", "texto", "## 2. Task Node", "### 2.1 `trello`", "texto", "## 3. Task id", "texto", "## 4. status"].join("\n");

    it("cópia legada cujo blockquote do topo linka o contrato novo (o crm) NÃO é o apontador: tem as seções numeradas do contrato", () => {
      expect(hasSchemaPointer(`${CRM_HEADER}\n${SECTIONS}\n`)).toBe(false);
      expect(hasSchemaPointer(`${CRM_HEADER}\n${SECTIONS}\n`.replace(/\n/g, "\r\n"))).toBe(false);
    });

    it("o apontador com um apêndice local pode ter uns poucos títulos numerados (menos de 3), sem virar cópia", () => {
      expect(hasSchemaPointer(`${POINTER}\n## Convenções locais\n## 1. Trello\n## 2. Backlog\n`)).toBe(true);
      expect(hasSchemaPointer(`${POINTER}\n## 1. Trello\n## 2. Backlog\n## 3. Outro\n`)).toBe(false);
    });

    it("título numerado dentro de bloco de código ou texto corrido não conta; só ## e ### no começo da linha", () => {
      expect(hasSchemaPointer(`${POINTER}\nveja a seção ## 1. x, ## 2. y e ## 3. z em prosa\n`)).toBe(true);
      expect(hasSchemaPointer(`${POINTER}\n#### 1. a\n#### 2. b\n#### 3. c\n`)).toBe(true);
    });

    it("checkSchemaPointer: a cópia do crm num repo legado passa (é o contrato em vigor), e num repo migrado é WARN", () => {
      const local = `${CRM_HEADER}\n${SECTIONS}\n`;
      const legacy = checkSchemaPointer({ ref: REF, local, remote: POINTER, legacy: true });
      expect(legacy.warn).toBeUndefined();
      expect(legacy.detail).toMatch(/a cópia local é o contrato em vigor/);
      expect(checkSchemaPointer({ ref: REF, local, remote: POINTER, legacy: false }).warn).toBe(true);
    });

    it("o limite é o das 10 primeiras linhas (o do upstream está na 3ª)", () => {
      const at = (n: number) => `${Array.from({ length: n - 1 }, () => "texto").join("\n")}\n> aiteam/docs/beads-schema.md\n`;
      expect(hasSchemaPointer(at(10))).toBe(true);
      expect(hasSchemaPointer(at(11))).toBe(false);
    });

    it("BOM, CRLF e blockquote com espaço antes do > na mesma linha de texto não mudam a regra", () => {
      expect(hasSchemaPointer(`\uFEFF${POINTER}`.replace(/\n/g, "\r\n"))).toBe(true);
      expect(hasSchemaPointer("# t\r\n  > aiteam/docs/beads-schema.md\r\n")).toBe(false); // `>` tem de abrir a linha
    });

    it("cópia legada que cita o caminho em prosa, num repo migrado → WARN (antes dava PASS falso)", () => {
      const legacyCopyWithMention = `${COPY}\nO contrato novo está em aiteam/docs/beads-schema.md, leia lá.\n`;
      const r = checkSchemaPointer({ ref: REF, local: legacyCopyWithMention, remote: POINTER });
      expect(r).toMatchObject({ pass: true, warn: true });
      expect(r.detail).toMatch(/não aponta para aiteam\/docs\/beads-schema\.md/);
    });

    it("o upstream cujo SCHEMA.md só cita o caminho em prosa não é um apontador → não comparado", () => {
      const r = checkSchemaPointer({ ref: REF, local: COPY, remote: `${COPY}\nVeja aiteam/docs/beads-schema.md\n` });
      expect(r.warn).toBeUndefined();
      expect(r.detail).toMatch(/não comparado/);
    });

    it("em modo legado, o arquivo que só cita o caminho em prosa é a cópia (PASS), não o apontador (WARN de contradição)", () => {
      const r = checkSchemaPointer({ ref: REF, local: `${COPY}\nVeja aiteam/docs/beads-schema.md\n`, remote: POINTER, legacy: true });
      expect(r.warn).toBeUndefined();
      expect(r.detail).toMatch(/a cópia local é o contrato em vigor/);
    });
  });

  it("o upstream (uma ref velha) ainda não tem o apontador, ou não tem o arquivo → não há o que comparar, PASS", () => {
    for (const remote of [COPY, null]) {
      const r = checkSchemaPointer({ ref: REF, local: COPY, remote });
      expect(r).toMatchObject({ pass: true });
      expect(r.warn).toBeUndefined();
      expect(r.detail).toMatch(/não comparado/);
    }
  });

  // QA da #39 (R1): o contrato do framework diz "siga o .beads/SCHEMA.md local até migrar" (beads-schema.md §11,
  // BOOT.md, AGENTS.md). O apontador manda escrever em .beads/tasks/, que o pre-commit recusa em modo legado: o WARN
  // "troque pelo apontador" levaria um repo legado a um commit que o hook barra.
  describe("modo legado (o .beads/active.yaml do modelo antigo ainda rastreado)", () => {
    it("a cópia local do contrato é o contrato em vigor: PASS, sem WARN, e diz que o apontador vem na migração", () => {
      const r = checkSchemaPointer({ ref: REF, local: COPY, remote: POINTER, legacy: true });
      expect(r).toMatchObject({ pass: true });
      expect(r.warn).toBeUndefined();
      expect(r.detail).toMatch(/modo legado/);
      expect(r.detail).toMatch(/contrato em vigor até migrar/);
      expect(r.detail).toMatch(/\.beads\/tasks\//);
      expect(r.detail).toMatch(/pre-commit recusa/);
      expect(r.detail).toMatch(/troque pelo apontador na migração/);
      expect(r.detail).toMatch(/beads-schema\.md §11/);
      expect(r.detail).toMatch(/migrate-beads\.mjs --dry-run/);
      expect(r.detail).not.toContain(`git show ${REF}:.beads/SCHEMA.md`);
    });

    it("o mesmo arquivo, depois de migrar (legacy: false), volta a ser WARN", () => {
      expect(checkSchemaPointer({ ref: REF, local: COPY, remote: POINTER, legacy: false }).warn).toBe(true);
      expect(checkSchemaPointer({ ref: REF, local: COPY, remote: POINTER }).warn).toBe(true); // o padrão é migrado
    });

    it("o apontador num repo ainda legado é uma contradição: WARN que manda migrar (ou voltar à cópia)", () => {
      const r = checkSchemaPointer({ ref: REF, local: POINTER, remote: POINTER, legacy: true });
      expect(r).toMatchObject({ pass: true, warn: true });
      expect(r.detail).toMatch(/ainda está em modo legado/);
      expect(r.detail).toMatch(/migrate-beads\.mjs --dry-run/);
    });

    it("sem o arquivo num repo legado → WARN que diz que ele é o contrato em vigor (sem mandar criar o apontador)", () => {
      const r = checkSchemaPointer({ ref: REF, local: null, remote: POINTER, legacy: true });
      expect(r).toMatchObject({ pass: true, warn: true });
      expect(r.detail).toMatch(/contrato em vigor/);
      expect(r.detail).not.toContain(`git show ${REF}:.beads/SCHEMA.md`);
    });

    it("o upstream sem apontador continua 'não comparado', legado ou não", () => {
      expect(checkSchemaPointer({ ref: REF, local: COPY, remote: COPY, legacy: true }).detail).toMatch(/não comparado/);
    });

    it("checkRootFilesUpstream repassa o modo legado da leitura para a linha do SCHEMA.md", () => {
      const facts = {
        upstream: { state: "ok" as const, ref: REF, sha: SHA, ageDays: 1 },
        marker: { state: "absent" as const },
        since: null,
        legacy: true,
        local: { ".beads/SCHEMA.md": COPY },
        remote: { ".beads/SCHEMA.md": POINTER },
        template: null,
        workflows: null,
        workflowsUnavailable: "sem js-yaml",
      };
      const line = checkRootFilesUpstream(facts).find((l) => l.name.startsWith(".beads/SCHEMA.md"));
      expect(line?.warn).toBeUndefined();
      expect(line?.detail).toMatch(/modo legado/);
    });
  });
});

describe("checkShimImports — AGENTS.md / CLAUDE.md / GEMINI.md × upstream", () => {
  const upstream = {
    "AGENTS.md": "# AGENTS\n\n@aiteam/AGENTS.md\n",
    "CLAUDE.md": "<!-- shim -->\n@aiteam/CLAUDE.md\n",
    "GEMINI.md": "<!-- shim -->\n@aiteam/GEMINI.md\n",
  };

  it("os três shims têm a linha → PASS", () => {
    const local = { "AGENTS.md": "# meu\n@aiteam/AGENTS.md\n", "CLAUDE.md": "@aiteam/CLAUDE.md", "GEMINI.md": "x\n@aiteam/GEMINI.md\n" };
    const r = checkShimImports({ ref: REF, local, remote: upstream });
    expect(r).toMatchObject({ pass: true });
    expect(r.warn).toBeUndefined();
    expect(r.detail).toMatch(/3 shims/);
  });

  it("um shim sem a linha → WARN que nomeia o arquivo e o conserto (o install para AGENTS/CLAUDE)", () => {
    const local = { "AGENTS.md": "# sem import\n", "CLAUDE.md": "@aiteam/CLAUDE.md\n", "GEMINI.md": "@aiteam/GEMINI.md\n" };
    const r = checkShimImports({ ref: REF, local, remote: upstream });
    expect(r).toMatchObject({ pass: true, warn: true });
    expect(r.detail).toMatch(/AGENTS\.md sem a linha @aiteam\/AGENTS\.md — rode node aiteam\/install\.mjs/);
    expect(r.detail).not.toMatch(/CLAUDE\.md sem/);
  });

  it("o GEMINI.md vai à mão: o install só injeta em AGENTS.md e CLAUDE.md", () => {
    const local = { "AGENTS.md": "@aiteam/AGENTS.md", "CLAUDE.md": "@aiteam/CLAUDE.md", "GEMINI.md": "# só meu\n" };
    const r = checkShimImports({ ref: REF, local, remote: upstream });
    expect(r.warn).toBe(true);
    expect(r.detail).toMatch(/GEMINI\.md sem a linha @aiteam\/GEMINI\.md — acrescente a linha/);
    expect(r.detail).toContain(`git show ${REF}:GEMINI.md`);
    expect(r.detail).not.toMatch(/GEMINI\.md sem a linha @aiteam\/GEMINI\.md — rode/);
    expect(SHIMS.find((s) => s.file === "GEMINI.md")?.fix).toBeNull();
  });

  it("arquivo ausente → WARN 'não existe'", () => {
    const r = checkShimImports({ ref: REF, local: { "AGENTS.md": "@aiteam/AGENTS.md", "CLAUDE.md": "@aiteam/CLAUDE.md", "GEMINI.md": null }, remote: upstream });
    expect(r.warn).toBe(true);
    expect(r.detail).toMatch(/GEMINI\.md não existe/);
  });

  it("a linha é a linha inteira, aparada: `@aiteam/AGENTS.md` dentro de prosa não conta", () => {
    const local = { "AGENTS.md": "veja @aiteam/AGENTS.md para detalhes\n", "CLAUDE.md": "  @aiteam/CLAUDE.md  \r\n", "GEMINI.md": "@aiteam/GEMINI.md" };
    const r = checkShimImports({ ref: REF, local, remote: upstream });
    expect(r.detail).toMatch(/AGENTS\.md sem a linha/);
    expect(r.detail).not.toMatch(/CLAUDE\.md sem/);
    expect(r.detail).not.toMatch(/GEMINI\.md sem/);
  });

  it("só se cobra a linha de um shim que o upstream tem", () => {
    const r = checkShimImports({ ref: REF, local: { "AGENTS.md": "@aiteam/AGENTS.md" }, remote: { "AGENTS.md": "@aiteam/AGENTS.md", "CLAUDE.md": null, "GEMINI.md": "sem import\n" } });
    expect(r).toMatchObject({ pass: true });
    expect(r.warn).toBeUndefined();
    expect(r.detail).toMatch(/1 shims/);
  });

  it("o upstream não tem nenhum shim com a linha → não comparado, PASS", () => {
    const r = checkShimImports({ ref: REF, local: {}, remote: { "AGENTS.md": "# velho\n" } });
    expect(r).toMatchObject({ pass: true });
    expect(r.detail).toMatch(/não comparado/);
  });
});

describe("checkGitattributesEol — .gitattributes × upstream", () => {
  const UPSTREAM_ATTRS = [
    "# comentário *.mjs text eol=lf (não é regra)",
    "aiteam/agents/*.md text eol=lf",
    ".claude/agents/*.md text eol=lf",
    "SPEC.md text eol=lf",
    "*.mjs text eol=lf",
    "*.ts  text eol=lf",
    "*.mts text eol=lf",
    "aiteam/githooks/* text eol=lf",
    "",
  ].join("\n");
  const ALL = GITATTRIBUTES_EOL_PATTERNS.map((p) => `${p} text eol=lf`).join("\n");

  it("o consumidor tem as cinco regras que o checklist cobra → PASS", () => {
    const r = checkGitattributesEol({ ref: REF, local: `# meu\n${ALL}\n*.png binary\n`, remote: UPSTREAM_ATTRS });
    expect(r).toMatchObject({ pass: true });
    expect(r.warn).toBeUndefined();
    expect(r.detail).toMatch(/5 regras/);
  });

  it("faltam regras → WARN que lista cada uma e manda renormalizar", () => {
    const r = checkGitattributesEol({ ref: REF, local: "*.mjs text eol=lf\n", remote: UPSTREAM_ATTRS });
    expect(r).toMatchObject({ pass: true, warn: true });
    expect(r.detail).toMatch(/faltam 4 regra\(s\)/);
    for (const p of ["*.mts", "aiteam/agents/*.md", ".claude/agents/*.md", "SPEC.md"]) expect(r.detail).toContain(`${p} text eol=lf`);
    expect(r.detail).not.toContain("*.mjs text eol=lf");
    expect(r.detail).toMatch(/git add --renormalize/);
  });

  it("comentário não é regra: uma linha `# *.mjs text eol=lf` não cumpre", () => {
    const r = checkGitattributesEol({ ref: REF, local: ALL.split("\n").map((l) => `# ${l}`).join("\n"), remote: UPSTREAM_ATTRS });
    expect(r.warn).toBe(true);
    expect(r.detail).toMatch(/faltam 5/);
  });

  it("a regra sem eol=lf não cumpre (text=auto, por exemplo)", () => {
    const r = checkGitattributesEol({ ref: REF, local: `${ALL.replace("SPEC.md text eol=lf", "SPEC.md text=auto")}\n`, remote: UPSTREAM_ATTRS });
    expect(r.warn).toBe(true);
    expect(r.detail).toContain("SPEC.md text eol=lf");
  });

  it("um `* text eol=lf` global vale para todos os padrões", () => {
    const r = checkGitattributesEol({ ref: REF, local: "* text=auto eol=lf\n", remote: UPSTREAM_ATTRS });
    expect(r.warn).toBeUndefined();
  });

  it("`/SPEC.md` com barra inicial é a mesma regra; CRLF no arquivo não atrapalha", () => {
    const local = ALL.replace("SPEC.md text", "/SPEC.md text").replace(/\n/g, "\r\n");
    expect(checkGitattributesEol({ ref: REF, local, remote: UPSTREAM_ATTRS }).warn).toBeUndefined();
  });

  it("sem .gitattributes → WARN com as cinco, dizendo que o arquivo não existe", () => {
    const r = checkGitattributesEol({ ref: REF, local: null, remote: UPSTREAM_ATTRS });
    expect(r.warn).toBe(true);
    expect(r.detail).toMatch(/o arquivo não existe/);
    expect(r.detail).toMatch(/faltam 5/);
  });

  it("só se cobra o que o upstream tem: uma ref velha sem a regra do SPEC.md não a exige", () => {
    const old = "aiteam/agents/*.md text eol=lf\n*.mjs text eol=lf\n";
    const r = checkGitattributesEol({ ref: REF, local: old, remote: old });
    expect(r.warn).toBeUndefined();
    expect(r.detail).toMatch(/2 regras/);
  });

  it("upstream sem o arquivo, ou sem nenhuma regra eol=lf do checklist → não comparado, PASS", () => {
    for (const remote of [null, "*.png binary\n"]) {
      const r = checkGitattributesEol({ ref: REF, local: "", remote });
      expect(r).toMatchObject({ pass: true });
      expect(r.detail).toMatch(/não comparado/);
    }
  });
});

describe("checkCiTemplateSteps — os workflows de PR × o modelo do upstream", () => {
  const run = (cmd: string) => ({ run: cmd });
  const template = {
    doc: {
      jobs: {
        framework: {
          steps: [{ uses: "actions/checkout@v4" }, run("npm ci"), run("npm run typecheck"), run("npm run validate:beads"), run("npm run validate:agents"), run("npm run test")],
        },
        app: { steps: [run("npm ci"), run("npm run lint"), run("npm run typecheck"), run("npm run test")] },
      },
    },
  };
  const wf = (file: string, steps: Array<{ run?: string }>, on: unknown = { pull_request: null }) => ({ file, doc: { on, jobs: { ci: { steps } } } });
  const FULL = [run("npm run typecheck"), run("npm run validate:beads"), run("npm run validate:agents"), run("npm run test")];

  it("o workflow roda os quatro scripts do job framework → PASS", () => {
    const r = checkCiTemplateSteps({ ref: REF, template, workflows: [wf("ci.yml", FULL)] });
    expect(r).toMatchObject({ pass: true });
    expect(r.warn).toBeUndefined();
    expect(r.detail).toMatch(/ci\.yml/);
    expect(r.detail).toMatch(/4 scripts/);
  });

  it("falta o validate:agents que o modelo ganhou depois da cópia → WARN que o nomeia (o caso do trabalhista e do crm)", () => {
    const r = checkCiTemplateSteps({ ref: REF, template, workflows: [wf("ci.yml", FULL.filter((s) => !/agents/.test(s.run)))] });
    expect(r).toMatchObject({ pass: true, warn: true });
    expect(r.detail).toContain("npm run validate:agents");
    expect(r.detail).not.toContain("npm run validate:beads");
    expect(r.detail).toContain(`git show ${REF}:aiteam/templates/ci.yml.example`);
  });

  it("o job app do modelo é ADAPTE: lint, que o consumidor não declara, não é cobrado", () => {
    const r = checkCiTemplateSteps({ ref: REF, template, workflows: [wf("ci.yml", FULL)] });
    expect(r.detail).not.toMatch(/lint/);
  });

  it("o nome do arquivo não importa (build.yml, python-ci.yml...) e os scripts podem vir de qualquer workflow de PR", () => {
    const r = checkCiTemplateSteps({
      ref: REF,
      template,
      workflows: [wf("build.yml", [run("npm run typecheck"), run("npm run test")]), wf("framework.yml", [run("npm run validate:beads"), run("npm run validate:agents")])],
    });
    expect(r.warn).toBeUndefined();
    expect(r.detail).toMatch(/build\.yml, framework\.yml/);
  });

  it("tolera as formas de chamar: npm --prefix aiteam run x, npm run x -w y, pnpm run x, cd aiteam && npm run x", () => {
    const r = checkCiTemplateSteps({
      ref: REF,
      template,
      workflows: [
        wf("ci.yml", [
          run("npm --prefix aiteam run typecheck"),
          run("cd aiteam && npm run validate:beads -- --quiet"),
          run("pnpm run validate:agents"),
          run("npm run test -w api"),
        ]),
      ],
    });
    expect(r.warn).toBeUndefined();
  });

  it("um script que só aparece como prefixo de outro não conta (validate:beads-extra ≠ validate:beads)", () => {
    const r = checkCiTemplateSteps({
      ref: REF,
      template,
      workflows: [wf("ci.yml", [run("npm run typecheck"), run("npm run validate:beads-extra"), run("npm run validate:agents"), run("npm run test")])],
    });
    expect(r.warn).toBe(true);
    expect(r.detail).toContain("npm run validate:beads");
  });

  it("só conta workflow disparado em pull_request (eval.yml e deploy.yml não são o pipeline de PR)", () => {
    const r = checkCiTemplateSteps({
      ref: REF,
      template,
      workflows: [wf("ci.yml", FULL.slice(0, 2)), wf("deploy.yml", FULL.slice(2), { push: { branches: ["main"] } })],
    });
    expect(r.warn).toBe(true);
    expect(r.detail).toContain("npm run validate:agents");
    expect(r.detail).not.toMatch(/deploy\.yml/);
  });

  it("`on:` como texto e como lista também é lido", () => {
    for (const on of ["pull_request", ["push", "pull_request"]]) {
      expect(checkCiTemplateSteps({ ref: REF, template, workflows: [wf("ci.yml", FULL, on)] }).warn, JSON.stringify(on)).toBeUndefined();
    }
  });

  it("nenhum workflow de PR → não comparado, PASS: o contrato de CI é quem cobra o pipeline", () => {
    for (const workflows of [[], [wf("deploy.yml", FULL, { push: null })], null]) {
      const r = checkCiTemplateSteps({ ref: REF, template, workflows });
      expect(r).toMatchObject({ pass: true });
      expect(r.warn).toBeUndefined();
      expect(r.detail).toMatch(/não comparado/);
    }
  });

  it("workflow que não parseou entra como ausente, sem derrubar", () => {
    const r = checkCiTemplateSteps({ ref: REF, template, workflows: [{ file: "quebrado.yml", error: "bad indentation" }, wf("ci.yml", FULL)] });
    expect(r.warn).toBeUndefined();
    expect(r.detail).not.toMatch(/quebrado/);
  });

  it("sem js-yaml, ou sem o modelo no upstream, ou com um modelo ilegível ou sem o job framework → não comparado, PASS", () => {
    const cases = [
      { template, workflows: null, workflowsUnavailable: "js-yaml indisponível" },
      { template: null, workflows: [wf("ci.yml", FULL)] },
      { template: { error: "boom" }, workflows: [wf("ci.yml", FULL)] },
      { template: { doc: { jobs: { app: { steps: [run("npm run test")] } } } }, workflows: [wf("ci.yml", FULL)] },
    ];
    for (const c of cases) {
      const r = checkCiTemplateSteps({ ref: REF, ...c });
      expect(r).toMatchObject({ pass: true });
      expect(r.warn).toBeUndefined();
      expect(r.detail).toMatch(/não comparado/);
    }
  });
});

describe("checkUpstreamRef — o remote, a ref e o marcador", () => {
  const ok = (extra: object = {}) => ({ state: "ok" as const, ref: REF, sha: SHA, ageDays: 2, ...extra });

  it("sem o remote upstream → PASS que diz como criá-lo (CI e clones sem upstream não ganham aviso)", () => {
    const r = checkUpstreamRef({ upstream: { state: "no-remote" } });
    expect(r).toMatchObject({ pass: true });
    expect(r.warn).toBeUndefined();
    expect(r.detail).toMatch(/git remote add upstream/);
  });

  // QA da #39 (A11): um remote com outro nome que aponta para o rb-ai-team (o vigacapital chama o seu de rb-ai-team)
  it("sem o upstream, mas com um remote que aponta para o rb-ai-team → WARN que sugere o git remote rename", () => {
    const r = checkUpstreamRef({ upstream: { state: "no-remote", alias: "rb-ai-team" } });
    expect(r).toMatchObject({ pass: true, warn: true });
    expect(r.detail).toContain("git remote rename rb-ai-team upstream");
    expect(r.detail).toMatch(/o remote rb-ai-team aponta para o rb-ai-team/);
    expect(r.detail).toMatch(/aiteam-sync/);
  });

  it("o alias sozinho não vira WARN quando há o remote upstream (a ref ok manda)", () => {
    expect(checkUpstreamRef({ upstream: { state: "ok", ref: REF, sha: SHA, ageDays: 1 } }).detail).not.toMatch(/rename/);
  });

  it("o remote existe, mas a ref nunca foi buscada → WARN que manda o fetch, dito como ação do usuário", () => {
    const r = checkUpstreamRef({ upstream: { state: "no-ref" } });
    expect(r).toMatchObject({ pass: true, warn: true });
    expect(r.detail).toMatch(/git fetch upstream/);
    expect(r.detail).toMatch(/nunca roda fetch/);
  });

  it("o git não respondeu → PASS não comparado", () => {
    expect(checkUpstreamRef({ upstream: { state: "no-git" } })).toMatchObject({ pass: true });
  });

  it("ref fresca com marcador → PASS com o sha, a idade e o último sync", () => {
    const r = checkUpstreamRef({
      upstream: ok(),
      marker: { state: "ok", commit: "1111111aaaa", date: "2026-07-17" },
      since: { status: "changes", entries: [] },
    });
    expect(r.warn).toBeUndefined();
    expect(r.detail).toContain("upstream/main = a9d862f (2 dias)");
    expect(r.detail).toContain("último sync: 1111111 (2026-07-17)");
    expect(r.detail).toMatch(/nenhum commit do upstream tocou arquivos de raiz/);
  });

  it("commits de raiz desde o último sync → conta e aponta o comando que os lista", () => {
    const r = checkUpstreamRef({
      upstream: ok(),
      marker: { state: "ok", commit: "1111111aaaa", date: null },
      since: { status: "changes", entries: [{}, {}, {}] },
    });
    expect(r.detail).toMatch(/3 commit\(s\) do upstream tocaram arquivos de raiz desde então/);
    expect(r.detail).toContain("node aiteam/scripts/upstream-marker.mjs changes");
  });

  it("sem aiteam/UPSTREAM: diz que não dá para medir e manda conferir tudo", () => {
    const r = checkUpstreamRef({ upstream: ok(), marker: { state: "absent" } });
    expect(r.detail).toMatch(/sem aiteam\/UPSTREAM — não dá para medir o que mudou na raiz desde o último sync; confira todos/);
    expect(r.detail).toMatch(/upstream-marker\.mjs write/);
    expect(r.warn).toBeUndefined();
  });

  it("marcador malformado e marcador que a ref local não tem → dizem que não dá para medir", () => {
    expect(checkUpstreamRef({ upstream: ok(), marker: { state: "malformed" } }).detail).toMatch(/commit: <sha> — não dá para medir/);
    const r = checkUpstreamRef({ upstream: ok(), marker: { state: "ok", commit: "1111111", date: null }, since: { status: "unknown-commit" } });
    expect(r.detail).toMatch(/não tem esse commit/);
    expect(r.detail).toMatch(/não dá para medir/);
  });

  it("aiteam/ que já veio deste commit → diz isso", () => {
    const r = checkUpstreamRef({ upstream: ok(), marker: { state: "ok", commit: SHA, date: null }, since: { status: "same" } });
    expect(r.detail).toMatch(/aiteam\/ já veio deste commit/);
  });

  it("a ponta do upstream passou de STALE_DAYS → WARN que manda o fetch sem prometer que ele resolve", () => {
    const r = checkUpstreamRef({ upstream: ok({ ageDays: STALE_DAYS + 1 }), marker: { state: "absent" } });
    expect(r).toMatchObject({ pass: true, warn: true });
    expect(r.detail).toContain(`tem ${STALE_DAYS + 1} dias`);
    expect(r.detail).toMatch(/git fetch upstream/);
    expect(r.detail).toMatch(/pode ser normal/);
    expect(r.detail).toMatch(/nunca roda fetch/);
    expect(checkUpstreamRef({ upstream: ok({ ageDays: STALE_DAYS }) }).warn).toBeUndefined();
  });

  it("idade desconhecida (git log falhou) não vira aviso de ref velha", () => {
    expect(checkUpstreamRef({ upstream: ok({ ageDays: null }) }).warn).toBeUndefined();
  });
});

// QA da #39 (A8): "upstream/main = a9d862f (0 dia(s))" tinha parênteses dentro de parênteses; e o texto do
// unknown-commit sugeria um `git fetch upstream` pendente num contexto (o sync) em que o fetch acabou de rodar.
describe("texto: sem parênteses aninhados, e o unknown-commit conta o contexto de quem o lê", () => {
  const NESTED = /\([^()]*\([^()]*\)[^()]*\)/;
  const previous = { commit: "1111111aaaa", date: "2026-07-17" };
  const current = { commit: SHA, date: "2026-10-06" };
  const entries = [{ hash: "abc1234", date: "2026-10-03", subject: "docs: algo", files: [".beads/SCHEMA.md", "AGENTS.md"] }];

  it("nenhuma linha do doctor, em nenhuma combinação de ref, marcador e medida, tem parênteses dentro de parênteses", () => {
    const markers = [{ state: "absent" as const }, { state: "malformed" as const }, { state: "ok" as const, commit: "1111111aaaa", date: "2026-07-17" }];
    const e = { hash: "abc1234", date: "2026-10-03", subject: "docs: algo", files: ["AGENTS.md"] };
    const sinces: Array<RootChanges | null> = [
      null,
      { status: "changes", entries: [] },
      { status: "changes", entries: [e, e] },
      { status: "same" },
      { status: "unknown-commit" },
    ];
    for (const ageDays of [0, 1, 2, 14, 15, 400, null]) {
      for (const marker of markers) {
        for (const since of sinces) {
          const lines = checkRootFilesUpstream({
            upstream: { state: "ok", ref: REF, sha: SHA, ageDays },
            marker,
            since,
            legacy: false,
            local: { ".beads/SCHEMA.md": "## 9. velho", "AGENTS.md": "", "CLAUDE.md": "", "GEMINI.md": null, ".gitattributes": null },
            remote: { ".beads/SCHEMA.md": "# t\n> aiteam/docs/beads-schema.md\n", "AGENTS.md": "@aiteam/AGENTS.md", "CLAUDE.md": "@aiteam/CLAUDE.md", "GEMINI.md": "@aiteam/GEMINI.md", ".gitattributes": "SPEC.md text eol=lf\n" },
            template: null,
            workflows: null,
            workflowsUnavailable: "sem js-yaml",
          });
          for (const l of lines) expect(l.detail ?? "", `${l.name} ageDays=${ageDays} ${marker.state} ${since?.status}`).not.toMatch(NESTED);
        }
      }
    }
  });

  it("a idade vem no singular e no plural, sem '(s)': 0 dias, 1 dia, 2 dias", () => {
    const age = (ageDays: number) => checkUpstreamRef({ upstream: { state: "ok", ref: REF, sha: SHA, ageDays } }).detail ?? "";
    expect(age(0)).toContain("(0 dias)");
    expect(age(1)).toContain("(1 dia)");
    expect(age(2)).toContain("(2 dias)");
    expect(age(1)).not.toMatch(/dia\(s\)/);
  });

  it("renderRootChanges não tem parênteses aninhados em nenhum status", () => {
    for (const m of [
      { status: "no-marker" as const, previous: null, current, entries: [] },
      { status: "malformed" as const },
      { status: "unknown-commit" as const, previous, current },
      { status: "same" as const, previous: current, current },
      { status: "changes" as const, previous, current, entries: [] },
      { status: "changes" as const, previous, current, entries },
    ]) {
      expect(renderRootChanges(m, { next: "Este PR grava o marcador." }), m.status).not.toMatch(NESTED);
      expect(renderRootChanges(m, { fetched: true }), `${m.status} fetched`).not.toMatch(NESTED);
    }
  });

  it("unknown-commit na CLI e no doctor: o fetch pode estar pendente, e o texto diz para rodá-lo", () => {
    const out = renderRootChanges({ status: "unknown-commit", previous, current });
    expect(out).toMatch(/git fetch upstream/);
    expect(out).toMatch(/pendente/);
  });

  it("unknown-commit no sync, onde o fetch acabou de rodar: não sugere fetch pendente, diz que o histórico mudou ou o sha está errado", () => {
    const out = renderRootChanges({ status: "unknown-commit", previous, current }, { fetched: true });
    expect(out).not.toMatch(/pendente/);
    expect(out).not.toMatch(/git fetch upstream` pendente/);
    expect(out).toMatch(/acabou de rodar/);
    expect(out).toMatch(/histórico do upstream foi reescrito/);
    expect(out).toMatch(/sha errado/);
    expect(out).toMatch(/não dá para medir/);
    expect(out).toContain("1111111");
  });

  it("o resto dos status não muda com `fetched`", () => {
    for (const m of [{ status: "no-marker" as const }, { status: "same" as const, previous: current, current }]) {
      expect(renderRootChanges(m, { fetched: true })).toBe(renderRootChanges(m));
    }
  });
});

describe("checkRootFilesUpstream — as linhas do doctor", () => {
  const POINTER = "> [`aiteam/docs/beads-schema.md`]";
  const baseFacts = (overrides: Partial<RootFilesFacts> = {}): RootFilesFacts => ({
    upstream: { state: "ok", ref: REF, sha: SHA, ageDays: 1 },
    marker: { state: "absent" },
    since: null,
    local: { ".beads/SCHEMA.md": POINTER, "AGENTS.md": "@aiteam/AGENTS.md", "CLAUDE.md": "@aiteam/CLAUDE.md", "GEMINI.md": "@aiteam/GEMINI.md", ".gitattributes": "SPEC.md text eol=lf\n" },
    remote: { ".beads/SCHEMA.md": POINTER, "AGENTS.md": "@aiteam/AGENTS.md", "CLAUDE.md": "@aiteam/CLAUDE.md", "GEMINI.md": "@aiteam/GEMINI.md", ".gitattributes": "SPEC.md text eol=lf\n" },
    template: null,
    workflows: null,
    workflowsUnavailable: "js-yaml indisponível",
    ...overrides,
  });

  it("sem o remote ou sem a ref: uma linha só, a que diz por quê", () => {
    expect(checkRootFilesUpstream(baseFacts({ upstream: { state: "no-remote" } }))).toHaveLength(1);
    expect(checkRootFilesUpstream(baseFacts({ upstream: { state: "no-ref" } }))).toHaveLength(1);
  });

  it("com a ref: a linha do upstream e uma por arquivo de raiz (SCHEMA.md, shims, .gitattributes, CI de PR)", () => {
    const lines = checkRootFilesUpstream(baseFacts());
    expect(lines.map((l) => l.name)).toEqual([
      "upstream do rb-ai-team (arquivos de raiz)",
      ".beads/SCHEMA.md × upstream",
      "AGENTS.md / CLAUDE.md / GEMINI.md × upstream",
      ".gitattributes × upstream",
      "CI de PR × modelo do upstream",
    ]);
  });

  it("NUNCA reprova: o consumidor com tudo errado só ganha WARN (a customização de raiz é legítima)", () => {
    const worst = baseFacts({
      upstream: { state: "ok", ref: REF, sha: SHA, ageDays: 400 },
      local: { ".beads/SCHEMA.md": "## 9. velho", "AGENTS.md": "", "CLAUDE.md": "", "GEMINI.md": null, ".gitattributes": null },
    });
    const lines = checkRootFilesUpstream(worst);
    expect(lines.filter((l) => l.warn).length).toBeGreaterThanOrEqual(4);
    for (const l of lines) expect(l.pass, l.name).toBe(true);
  });

  it("não repete o que o doctor já confere: nada de tier-rules, settings.json ou .mcp.json aqui", () => {
    const names = checkRootFilesUpstream(baseFacts()).map((l) => l.name).join("\n");
    expect(names).not.toMatch(/tier-rules|settings\.json|\.mcp\.json|ci:|deploy:/);
  });
});
