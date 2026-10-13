import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { load } from "js-yaml";
import {
  buildState,
  combineBead,
  combineProject,
  idProblems,
  branchFileProblems,
  appendEntry,
  appendOnlyProblem,
  AT_AHEAD_WARN_MS,
  cleanText,
  isAppendOnly,
  nextAt,
  parseInstant,
  pickVersions,
  renderDefinition,
  renderActiveView,
  renderIndexView,
  sanitizeBranch,
  viewIntegrity,
  GITIGNORE,
  GITIGNORE_PATH,
  mergeGitignore,
  type BeadInput,
} from "./beads-core.mjs";
import { validateBeads } from "./beads-schema.js";

// Contrato: aiteam/docs/beads-schema.md. Cada describe abaixo fixa uma regra
// daquele documento — §3 (formato), §4 (combinação), §6 (projeto) e §7 (visões).

const NOW = Date.parse("2026-10-05T12:00:00Z");
const opts = { nowMs: NOW };

const file = (branchFile: string, text: string) => ({ branchFile, text });
const one = (text: string, id = "api-login", branchFile = "main") => combineBead(id, [file(branchFile, text)], opts);

const DEF = `title: "Login"
description: "Formulário de login"
effort: "M"
created_at: "2026-10-01T10:00:00Z"
`;

describe("§3 formato — definição válida", () => {
  it("o topo vira asserções no created_at e as entradas no seu at", () => {
    const r = one(`${DEF}entries:
  - at: "2026-10-02T10:00:00Z"
    status: "in_progress"
    stage: "implement"
`);
    expect(r.errors).toEqual([]);
    expect(r.bead?.status).toBe("in_progress");
    expect(r.bead?.fields["stage"]).toBe("implement");
    expect(r.bead?.fields["title"]).toBe("Login");
    expect(r.bead?.created_at).toBe("2026-10-01T10:00:00Z");
    expect(r.bead?.updated_at).toBe("2026-10-02T10:00:00Z");
    expect(r.bead?.branches).toEqual(["main"]);
  });

  it("o status pode ir no topo como estado inicial, e a entrada mais nova vence", () => {
    const r = one(`${DEF}status: "blocked"
entries:
  - at: "2026-10-03T10:00:00Z"
    status: "completed"
`);
    expect(r.bead?.status).toBe("completed");
    expect(r.bead?.done).toBe("2026-10-03T10:00:00Z");
  });

  it("CRLF dá o mesmo resultado que LF", () => {
    const lf = `${DEF}entries:\n  - at: "2026-10-02T10:00:00Z"\n    status: "in_progress"\n`;
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(one(crlf)).toEqual(one(lf));
  });

  it("timestamp sem aspas continua texto (CORE_SCHEMA)", () => {
    const r = one(`title: "x"\ncreated_at: 2026-10-01T10:00:00Z\n`);
    expect(r.errors).toEqual([]);
    expect(r.bead?.created_at).toBe("2026-10-01T10:00:00Z");
  });

  it("id no topo igual à pasta é aceito", () => {
    expect(one(`id: "api-login"\n${DEF}`).errors).toEqual([]);
  });
});

describe("§3 formato — erros", () => {
  const erro = (text: string, re: RegExp) => {
    const r = one(text);
    expect(r.bead).toBeNull();
    expect(r.errors.join("\n")).toMatch(re);
  };

  it("definição sem created_at", () => erro(`title: "x"\n`, /created_at/));
  it("created_at fora do formato", () => erro(`title: "x"\ncreated_at: "2026-10-01 10:00"\n`, /created_at/));
  it("data inexistente (30 de fevereiro)", () => erro(`title: "x"\ncreated_at: "2026-02-30T10:00:00Z"\n`, /created_at/));
  it("fuso que não é Z", () => erro(`title: "x"\ncreated_at: "2026-10-01T10:00:00-03:00"\n`, /created_at/));

  it("timestamp mais de 24 h no futuro", () => {
    erro(`${DEF}entries:\n  - at: "2026-10-06T12:00:01Z"\n    status: "pending"\n`, /futuro/);
  });

  it("até 24 h no futuro passa (relógios diferentes)", () => {
    expect(one(`${DEF}entries:\n  - at: "2026-10-06T11:59:59Z"\n    status: "pending"\n`).errors).toEqual([]);
  });

  it("entries que não é a última chave", () => {
    erro(`title: "x"\nentries:\n  - at: "2026-10-02T10:00:00Z"\n    status: "pending"\ncreated_at: "2026-10-01T10:00:00Z"\n`, /última chave/);
  });

  it("entries em flow style", () => {
    erro(`${DEF}entries: [{at: "2026-10-02T10:00:00Z", status: "pending"}]\n`, /flow/);
    erro(`${DEF}entries: []\n`, /flow/);
  });

  it("status fora do enum", () => erro(`${DEF}status: "done"\n`, /status/));
  it("impl_model fora do enum", () => erro(`${DEF}impl_model: "gpt"\n`, /impl_model/));
  it("tags que não são lista de texto", () => erro(`${DEF}tags: "a, b"\n`, /tags/));
  it("número entre aspas", () => erro(`${DEF}estimated_time_m: "45"\n`, /estimated_time_m/));

  it("campo de estado (que não o status) no topo", () => {
    erro(`${DEF}stage: "plan"\n`, /stage/);
    erro(`${DEF}context_summary: "x"\n`, /context_summary/);
    erro(`${DEF}blockers: []\n`, /blockers/);
    erro(`${DEF}note: "x"\n`, /note/);
  });

  it("campos calculados não se escrevem", () => {
    erro(`${DEF}updated_at: "2026-10-01T10:00:00Z"\n`, /updated_at/);
    erro(`${DEF}branches: ["main"]\n`, /branches/);
    erro(`${DEF}entries:\n  - at: "2026-10-02T10:00:00Z"\n    done: "2026-10-02"\n`, /done/);
  });

  it("id no topo diferente da pasta", () => erro(`id: "api-outro"\n${DEF}`, /pasta/));
  it("id ou created_at dentro de uma entrada", () => {
    erro(`${DEF}entries:\n  - at: "2026-10-02T10:00:00Z"\n    id: "x"\n`, /id/);
    erro(`${DEF}entries:\n  - at: "2026-10-02T10:00:00Z"\n    created_at: "2026-10-02T10:00:00Z"\n`, /created_at/);
  });

  it("entrada sem at", () => erro(`${DEF}entries:\n  - status: "pending"\n`, /at/));
  it("YAML inválido", () => erro(`title: "x\ncreated_at: [\n`, /YAML/));
  it("chave duplicada", () => erro(`title: "a"\ntitle: "b"\ncreated_at: "2026-10-01T10:00:00Z"\n`, /YAML|duplicad/));
  it("arquivo vazio", () => erro(``, /vazio/));

  // Aliases YAML custam pouco no load (o js-yaml reaproveita a referência),
  // mas o dump da visão expande tudo: um campo desconhecido com aliases
  // aninhados derrubaria todo hook e o início de sessão.
  it("estrutura que expande demais (bomba de aliases)", () => {
    const levels = [`&a0 [${Array(10).fill(1).join(", ")}]`];
    for (let i = 1; i <= 6; i++) levels.push(`&a${i} [${Array(10).fill(`*a${i - 1}`).join(", ")}]`);
    erro(`${DEF}bomba: [${levels.join(", ")}]\n`, /grande demais/);
  });
  it("topo que não é mapeamento", () => erro(`- a\n- b\n`, /mapeamento/));
});

describe("§3 formato — avisos", () => {
  const avisa = (text: string, re: RegExp) => {
    const r = one(text);
    expect(r.errors).toEqual([]);
    expect(r.warnings.join("\n")).toMatch(re);
  };

  it("texto multilinha", () => avisa(`${DEF.replace('"Formulário de login"', "|\n  linha 1\n  linha 2")}`, /uma linha|multilinha/));
  it("HTML no texto", () => avisa(`${DEF.replace("Formulário de login", "<b>login</b>")}`, /HTML/));
  it("description acima de 140", () => avisa(`${DEF.replace("Formulário de login", "x".repeat(141))}`, /140/));
  it("entrada sem nenhuma asserção", () => avisa(`${DEF}entries:\n  - at: "2026-10-02T10:00:00Z"\n`, /sem asserção/));
});

// §3.3: `trello` e `trello_scope` saíram do "campo desconhecido": o framework valida o formato
// (issue 28). Ausente é o caso normal — trabalho de bug interno ou de decisão de arquitetura não
// tem card.
describe("§3.3 trello e trello_scope — o card de origem", () => {
  const ok = (extra: string, entries = "") => {
    const r = one(`${DEF}status: "pending"\n${extra}${entries}`);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    return r.bead!;
  };
  const erro = (extra: string, re: RegExp, entries = "") => {
    const r = one(`${DEF}${extra}${entries}`);
    expect(r.bead).toBeNull();
    expect(r.errors.join("\n")).toMatch(re);
  };
  const ENTRY = (campos: string) => `entries:\n  - at: "2026-10-02T10:00:00Z"\n${campos}`;

  it("ausente é o caso normal: sem erro, sem aviso e sem o campo", () => {
    const b = ok("");
    expect(b.fields).not.toHaveProperty("trello");
    expect(b.fields).not.toHaveProperty("trello_scope");
  });

  it("um shortLink, em texto", () => {
    expect(ok('trello: "97e1Chex"\n').fields["trello"]).toBe("97e1Chex");
  });

  it("uma lista de shortLinks: a bead que absorve mais de um card", () => {
    expect(ok('trello: ["0nU0fBM1", "68wGTstW"]\n').fields["trello"]).toEqual(["0nU0fBM1", "68wGTstW"]);
    expect(ok('trello:\n  - "0nU0fBM1"\n  - "68wGTstW"\n').fields["trello"]).toEqual(["0nU0fBM1", "68wGTstW"]);
  });

  it("trello_scope: partial vale junto do trello", () => {
    const b = ok('trello: "97e1Chex"\ntrello_scope: "partial"\n');
    expect(b.fields["trello_scope"]).toBe("partial");
  });

  it("são campos de definição: valem também dentro de entries, e a entrada mais nova vence", () => {
    const b = ok('trello: "97e1Chex"\n', ENTRY('    trello: ["97e1Chex", "68wGTstW"]\n    trello_scope: "partial"\n'));
    expect(b.fields["trello"]).toEqual(["97e1Chex", "68wGTstW"]);
    expect(b.fields["trello_scope"]).toBe("partial");
  });

  it("trello na definição e trello_scope numa entrada combinam", () => {
    expect(ok('trello: "97e1Chex"\n', ENTRY('    trello_scope: "partial"\n')).fields["trello_scope"]).toBe("partial");
  });

  it("a URL inteira em vez do shortLink é erro, e a mensagem diz o que fazer", () => {
    erro('trello: "https://trello.com/c/97e1Chex/12-titulo"\n', /trello.*shortLink/);
  });

  // QA B-A3: o id do card (24 hex, o `id` da API) também casa ^[A-Za-z0-9]+$, mas o reconcile compara com o
  // `shortLink` (8 caracteres): um id grudado no campo nunca casaria e o card sairia "sem bead" para sempre.
  // Não se aperta o regex para 8 caracteres — só se recusa o que é inequivocamente o id.
  it("o id do card (24 hex) é recusado com a mensagem certa: é o id, não o shortLink", () => {
    const ID = "6a04be05693b5ca07cad2001";
    erro(`trello: "${ID}"\n`, /trello .*esse é o id do card, não o shortLink/);
    erro(`trello: ["97e1Chex", "${ID}"]\n`, /trello \[1\] .*esse é o id do card, não o shortLink/);
    erro(`trello: "${ID.toUpperCase()}"\n`, /esse é o id do card/);
    erro("", /entries\[0\].*esse é o id do card/, ENTRY(`    trello: "${ID}"\n`));
  });

  it("não aperta para 8 caracteres: shortLinks de outros tamanhos e 24 caracteres que não são hex seguem valendo", () => {
    expect(ok('trello: "abc"\n').fields["trello"]).toBe("abc");
    expect(ok('trello: "97e1ChexAB"\n').fields["trello"]).toBe("97e1ChexAB");
    expect(ok('trello: "6a04be05693b5ca07cad200g"\n').fields["trello"]).toBe("6a04be05693b5ca07cad200g"); // 24 caracteres, o último não é hex
    expect(ok('trello: "6a04be05693b5ca07cad20011"\n').fields["trello"]).toBe("6a04be05693b5ca07cad20011"); // 25 hex
  });

  it("shortLink vazio, com espaço ou com barra é erro", () => {
    erro('trello: ""\n', /trello/);
    erro('trello: "97e1 Chex"\n', /trello/);
    erro('trello: "c/97e1Chex"\n', /trello/);
  });

  it("lista vazia, ou com item vazio ou inválido, é erro e aponta o item", () => {
    erro("trello: []\n", /trello/);
    erro('trello: ["0nU0fBM1", ""]\n', /trello \[1\]/);
    erro('trello: ["0nU0fBM1", "https://trello.com/c/68wGTstW"]\n', /trello \[1\]/);
    erro('trello: ["0nU0fBM1", 7]\n', /trello \[1\]/);
  });

  it("valor que não é texto é erro: o número sem aspas e o objeto do modelo antigo", () => {
    erro("trello: 12345678\n", /trello.*aspas/);
    erro('trello: {card: "abc"}\n', /trello/);
    erro("trello: true\n", /trello/);
  });

  it("o formato também vale dentro de uma entrada", () => {
    erro('trello: "97e1Chex"\n', /entries\[0\].*trello/, ENTRY('    trello: "https://trello.com/c/97e1Chex"\n'));
  });

  it("trello_scope fora do enum é erro", () => {
    erro('trello: "97e1Chex"\ntrello_scope: "full"\n', /trello_scope.*partial/);
    erro('trello: "97e1Chex"\ntrello_scope: true\n', /trello_scope/);
  });

  it("trello_scope sem trello é erro: a marca só tem sentido junto do card", () => {
    erro('trello_scope: "partial"\n', /trello_scope.*trello/);
    erro("", /trello_scope.*trello/, ENTRY('    trello_scope: "partial"\n'));
  });

  it("a regra é da combinação: o trello pode estar em outra branch, mas em alguma tem de estar", () => {
    const adendo = (campos: string) => `entries:\n  - at: "2026-10-03T10:00:00Z"\n${campos}`;
    const withCard = combineBead("api-login", [file("a", DEF), file("b", adendo('    trello: "97e1Chex"\n')), file("c", adendo('    trello_scope: "partial"\n'))], opts);
    expect(withCard.errors).toEqual([]);
    expect(withCard.bead?.fields["trello_scope"]).toBe("partial");
    const without = combineBead("api-login", [file("a", DEF), file("c", adendo('    trello_scope: "partial"\n'))], opts);
    expect(without.bead).toBeNull();
    expect(without.errors.join("\n")).toMatch(/trello_scope.*trello/);
  });
});

describe("§3 nomes — pasta (id) e arquivo (branch)", () => {
  it("aceita ids e arquivos no charset", () => {
    expect(idProblems("api-login_v2.1")).toEqual([]);
    expect(branchFileProblems("feat-login")).toEqual([]);
  });

  it("recusa id fora do charset, com .., começando com ponto ou nome reservado do Windows", () => {
    for (const bad of ["api login", "api/x", "a..b", ".hidden", "-x", "con", "NUL", "com1", "", "ação"]) {
      expect(idProblems(bad), bad).not.toEqual([]);
    }
  });

  it("sanitizeBranch troca / por - e recusa caractere fora de [A-Za-z0-9._/-]", () => {
    expect(sanitizeBranch("feat/login")).toEqual({ file: "feat-login" });
    expect(sanitizeBranch("chore/beads-modelo-novo").file).toBe("chore-beads-modelo-novo");
    expect(sanitizeBranch("feat/a b").file).toBeNull();
    expect(sanitizeBranch("feat_x")).toEqual({ file: "feat_x" });
    expect(sanitizeBranch("feat+x").file).toBeNull();
    expect(sanitizeBranch("").file).toBeNull();
  });

  it("combineBead acusa pasta ou arquivo com nome inválido", () => {
    expect(combineBead("a..b", [file("main", DEF)], opts).errors.join()).toMatch(/a\.\.b/);
    expect(combineBead("api-x", [file("feat+x", DEF)], opts).errors.join()).toMatch(/feat\+x/);
  });
});

describe("§4 combinação", () => {
  it("vence a asserção mais recente entre arquivos", () => {
    const r = combineBead(
      "api-login",
      [
        file("main", `${DEF}entries:\n  - at: "2026-10-03T10:00:00Z"\n    status: "in_progress"\n`),
        file("feat-x", `entries:\n  - at: "2026-10-04T10:00:00Z"\n    status: "blocked"\n    blockers: ["api-token"]\n`),
      ],
      opts
    );
    expect(r.bead?.status).toBe("blocked");
    expect(r.bead?.fields["blockers"]).toEqual(["api-token"]);
    expect(r.bead?.branches).toEqual(["feat-x", "main"]);
    expect(r.bead?.updated_at).toBe("2026-10-04T10:00:00Z");
  });

  it("compara instantes, não texto (.500Z é depois de :00Z)", () => {
    const r = combineBead(
      "api-login",
      [
        file("main", `${DEF}entries:\n  - at: "2026-10-03T10:00:00.500Z"\n    status: "completed"\n`),
        file("zz", `entries:\n  - at: "2026-10-03T10:00:00Z"\n    status: "blocked"\n`),
      ],
      opts
    );
    expect(r.bead?.status).toBe("completed");
  });

  it("empate no mesmo arquivo: vence a que está mais abaixo", () => {
    const r = one(`${DEF}entries:
  - at: "2026-10-02T10:00:00Z"
    status: "in_progress"
  - at: "2026-10-02T10:00:00Z"
    status: "blocked"
`);
    expect(r.bead?.status).toBe("blocked");
    expect(r.warnings.join()).not.toMatch(/empate/);
  });

  it("empate entre arquivos: vence o nome maior em ordem de bytes, com aviso", () => {
    const r = combineBead(
      "api-login",
      [
        file("main", `${DEF}entries:\n  - at: "2026-10-02T10:00:00Z"\n    status: "in_progress"\n`),
        file("feat-x", `entries:\n  - at: "2026-10-02T10:00:00Z"\n    status: "blocked"\n`),
      ],
      opts
    );
    expect(r.bead?.status).toBe("in_progress"); // "main" > "feat-x"
    expect(r.warnings.join()).toMatch(/empate/);
    expect(r.warnings.join()).toMatch(/status/);
  });

  it("empate entre arquivos com o mesmo valor não gera aviso", () => {
    const r = combineBead(
      "api-login",
      [
        file("main", `${DEF}entries:\n  - at: "2026-10-02T10:00:00Z"\n    status: "completed"\n`),
        file("feat-x", `entries:\n  - at: "2026-10-02T10:00:00Z"\n    status: "completed"\n`),
      ],
      opts
    );
    expect(r.warnings.join()).not.toMatch(/empate/);
  });

  it("listas: a mais recente substitui a lista inteira, e [] limpa", () => {
    const r = one(`${DEF}tags: ["a", "b"]
entries:
  - at: "2026-10-02T10:00:00Z"
    status: "blocked"
    blockers: ["api-x", "api-y"]
    tags: ["c"]
  - at: "2026-10-03T10:00:00Z"
    status: "in_progress"
    blockers: []
`);
    expect(r.bead?.fields["tags"]).toEqual(["c"]);
    expect(r.bead?.fields["blockers"]).toEqual([]);
  });

  it("nenhum status em lugar nenhum: pending, com aviso", () => {
    const r = one(DEF);
    expect(r.bead?.status).toBe("pending");
    expect(r.warnings.join()).toMatch(/status/);
  });

  it("bead definido por duas branches: as duas valem, created_at é o menor, com aviso", () => {
    const r = combineBead(
      "api-login",
      [
        file("main", `title: "Da main"\ncreated_at: "2026-10-01T10:00:00Z"\n`),
        file("feat-x", `title: "Da feat"\ndescription: "só a feat descreve"\ncreated_at: "2026-10-02T10:00:00Z"\n`),
      ],
      opts
    );
    expect(r.errors).toEqual([]);
    expect(r.bead?.created_at).toBe("2026-10-01T10:00:00Z");
    expect(r.bead?.fields["title"]).toBe("Da feat");
    expect(r.bead?.fields["description"]).toBe("só a feat descreve");
    expect(r.warnings.join()).toMatch(/definido por feat-x e main/);
  });

  it("pasta só com adendos: created_at é o menor at", () => {
    const r = combineBead(
      "api-login",
      [
        file("feat-x", `entries:\n  - at: "2026-10-03T10:00:00Z"\n    status: "in_progress"\n    title: "Veio por adendo"\n`),
        file("feat-y", `entries:\n  - at: "2026-10-02T10:00:00Z"\n    note: "primeiro"\n`),
      ],
      opts
    );
    expect(r.errors).toEqual([]);
    expect(r.bead?.created_at).toBe("2026-10-02T10:00:00Z");
    expect(r.bead?.fields["title"]).toBe("Veio por adendo");
  });

  it("sem title nem description é erro", () => {
    const r = combineBead("api-login", [file("feat-x", `entries:\n  - at: "2026-10-03T10:00:00Z"\n    status: "pending"\n`)], opts);
    expect(r.bead).toBeNull();
    expect(r.errors.join()).toMatch(/title|description/);
  });

  it("campo desconhecido é repassado", () => {
    const r = one(`${DEF}squad: {nome: "pagamentos"}\nentries:\n  - at: "2026-10-02T10:00:00Z"\n    escopo: "sprint-3"\n`);
    expect(r.bead?.fields["squad"]).toEqual({ nome: "pagamentos" });
    expect(r.bead?.fields["escopo"]).toBe("sprint-3");
  });

  it("definição dentro de entries corrige o topo", () => {
    const r = one(`${DEF}entries:\n  - at: "2026-10-02T10:00:00Z"\n    title: "Login (corrigido)"\n`);
    expect(r.bead?.fields["title"]).toBe("Login (corrigido)");
  });

  it("um arquivo inválido invalida o bead inteiro", () => {
    const r = combineBead("api-login", [file("main", DEF), file("feat-x", "entries: [\n")], opts);
    expect(r.bead).toBeNull();
    expect(r.errors.join()).toMatch(/feat-x/);
  });
});

describe("buildState — o conjunto", () => {
  const inputs = (...xs: Array<[string, string, string]>): BeadInput[] =>
    xs.map(([bead, branchFile, text]) => ({ bead, branchFile, text }));

  it("bead inválido é pulado; os outros entram", () => {
    const s = buildState(
      inputs(["api-ok", "main", DEF], ["api-ruim", "main", `title: "x"\n`]),
      [],
      opts
    );
    expect(s.beads.map((b) => b.id)).toEqual(["api-ok"]);
    expect(s.invalid.map((b) => b.id)).toEqual(["api-ruim"]);
  });

  it("ids que só diferem em maiúsculas e minúsculas: os dois ficam inválidos", () => {
    const s = buildState(inputs(["api-Login", "main", DEF], ["api-login", "main", DEF]), [], opts);
    expect(s.beads).toEqual([]);
    expect(s.invalid.map((b) => b.id).sort()).toEqual(["api-Login", "api-login"]);
    expect(s.invalid[0]!.errors.join()).toMatch(/maiúsculas/);
  });

  it("blocker que não casa id nenhum gera aviso", () => {
    const s = buildState(
      inputs(["api-a", "main", `${DEF}entries:\n  - at: "2026-10-02T10:00:00Z"\n    status: "blocked"\n    blockers: ["api-fantasma"]\n`]),
      [],
      opts
    );
    expect(s.warnings.join()).toMatch(/api-fantasma/);
  });

  // O post-merge imprime só os avisos que o merge causou — empate entre
  // branches, bead definido duas vezes, bead sem status —, não os de conteúdo
  // (HTML, texto longo), que são do autor e saem no validate:beads.
  it("separa os avisos de combinação dos de conteúdo", () => {
    const s = buildState(
      inputs(
        ["api-a", "main", `${DEF}entries:\n  - at: "2026-10-02T10:00:00Z"\n    status: "in_progress"\n`],
        ["api-a", "feat-x", `title: "Outra definição"\ncreated_at: "2026-10-01T11:00:00Z"\nentries:\n  - at: "2026-10-02T10:00:00Z"\n    status: "blocked"\n`],
        ["api-b", "main", DEF.replace("Formulário de login", "<b>html</b>")]
      ),
      [],
      opts
    );
    expect(s.combination.join("\n")).toMatch(/empate de horário em status/);
    expect(s.combination.join("\n")).toMatch(/definido por feat-x e main/);
    expect(s.combination.join("\n")).toMatch(/api-b.*nenhum status/);
    expect(s.combination.join("\n")).not.toMatch(/HTML/);
    expect(s.warnings.join("\n")).toMatch(/HTML/);
  });

  it("phase que não casa nenhuma key declarada gera aviso", () => {
    const s = buildState(
      inputs(["api-a", "main", `${DEF}phase: "fase-9"\n`]),
      [{ branchFile: "main", text: `created_at: "2026-10-01T00:00:00Z"\nphases:\n  - {key: "fase-1", name: "Fase 1"}\n` }],
      opts
    );
    expect(s.warnings.join()).toMatch(/fase-9/);
  });
});

describe("§6 projeto — fases e foco", () => {
  it("a mais recente vence, entre arquivos e entradas", () => {
    const p = combineProject(
      [
        file("main", `created_at: "2026-10-01T00:00:00Z"\nphases:\n  - {key: "f1", name: "Fase 1"}\nfocus_note: "velho"\n`),
        file("feat-x", `entries:\n  - at: "2026-10-03T00:00:00Z"\n    focus_note: "novo"\n`),
      ],
      opts
    );
    expect(p.errors).toEqual([]);
    expect(p.focus_note).toBe("novo");
    expect(p.phases).toEqual([{ key: "f1", name: "Fase 1" }]);
  });

  it("key de fase duplicada ou vazia é erro", () => {
    const p = combineProject(
      [file("main", `created_at: "2026-10-01T00:00:00Z"\nphases:\n  - {key: "f1", name: "A"}\n  - {key: "f1", name: "B"}\n`)],
      opts
    );
    expect(p.errors.join()).toMatch(/f1/);
  });

  it("campo fora de phases/focus_note é erro", () => {
    const p = combineProject([file("main", `created_at: "2026-10-01T00:00:00Z"\nbudget_usd: 5\n`)], opts);
    expect(p.errors.join()).toMatch(/budget_usd/);
  });
});

const STATE_INPUTS: BeadInput[] = [
  {
    bead: "api-login",
    branchFile: "main",
    text: `${DEF}impl_model: "opus"\ntags: ["auth"]\nentries:\n  - at: "2026-10-02T10:00:00Z"\n    status: "in_progress"\n    stage: "implement"\n`,
  },
  {
    bead: "ui-form",
    branchFile: "feat-x",
    text: `title: "Form"\ncreated_at: "2026-09-30T10:00:00Z"\nphase: "f1"\ntrello: "97e1Chex"\nsquad: {nome: "pagamentos"}\nentries:\n  - at: "2026-10-04T10:00:00Z"\n    status: "blocked"\n    blockers: ["api-login"]\n`,
  },
  {
    bead: "orch-velho",
    branchFile: "main",
    text: `title: "Velho"\ncreated_at: "2026-07-01T10:00:00Z"\neffort: "S"\nentries:\n  - at: "2026-07-02T10:00:00Z"\n    status: "completed"\n    context_summary: "Feito."\n`,
  },
  {
    bead: "spec-pendente",
    branchFile: "main",
    text: `description: "Só descrição"\ncreated_at: "2026-10-01T10:00:00Z"\n`,
  },
];
const PROJECT = [
  { branchFile: "main", text: `created_at: "2026-09-01T00:00:00Z"\nphases:\n  - {key: "f1", name: "Fase 1", subtitle: "base"}\nfocus_note: "Fechar a fase 1."\n` },
];
const META = { project: "demo", budgetUsd: 2, costUsd: 0.42 };

describe("§7.1 visão active.yaml", () => {
  const state = buildState(STATE_INPUTS, PROJECT, opts);
  const text = renderActiveView(state, META);
  const doc = load(text) as any;

  it("cabeçalho GERADO e hash que confere", () => {
    expect(text.startsWith("# GERADO por aiteam/scripts/beads-views.mjs")).toBe(true);
    expect(text).toMatch(/^# fonte: 4 beads · sha256:[0-9a-f]{64}$/m);
    expect(viewIntegrity(text)).toBe("intact");
  });

  it("só beads vivos, por created_at e depois id", () => {
    expect(doc.tasks.map((t: any) => t.id)).toEqual(["ui-form", "api-login", "spec-pendente"]);
  });

  it("sessão, fases e arquivo vêm calculados", () => {
    expect(doc.version).toBe("2");
    expect(doc.project).toBe("demo");
    expect(doc.session).toEqual({
      budget_usd: 2,
      cost_accumulated_usd: 0.42,
      current_task_phase: "implement",
      focus_note: "Fechar a fase 1.",
    });
    expect(doc.phases).toEqual([{ key: "f1", name: "Fase 1", subtitle: "base" }]);
    expect(doc.archive).toEqual({ count: 1, index: ".beads/index.yaml", last_archived_at: "2026-07-02T10:00:00Z" });
  });

  it("o nó traz campos combinados, desconhecidos e o diagnóstico de branches", () => {
    const form = doc.tasks.find((t: any) => t.id === "ui-form");
    expect(form).toMatchObject({
      status: "blocked",
      blockers: ["api-login"],
      trello: "97e1Chex",
      squad: { nome: "pagamentos" },
      created_at: "2026-09-30T10:00:00Z",
      updated_at: "2026-10-04T10:00:00Z",
      branches: ["feat-x"],
    });
  });

  it("trello e trello_scope saem depois de tags e antes de blockers, na ordem do contrato", () => {
    const withCard = buildState(
      [
        {
          bead: "api-card",
          branchFile: "main",
          text: `${DEF}trello_scope: "partial"\ntrello: ["0nU0fBM1", "68wGTstW"]\ntags: ["x"]\nsquad: "z"\nentries:\n  - at: "2026-10-02T10:00:00Z"\n    status: "blocked"\n    blockers: ["api-login"]\n    note: "n"\n`,
        },
      ],
      [],
      opts
    );
    const view = renderActiveView(withCard, META);
    const keys = Object.keys((load(view) as any).tasks[0]);
    expect(keys.slice(keys.indexOf("tags"), keys.indexOf("note") + 1)).toEqual(["tags", "trello", "trello_scope", "blockers", "note"]);
    expect(keys.indexOf("squad")).toBeGreaterThan(keys.indexOf("note"));
    expect(validateBeads(view).errors).toEqual([]);
    expect((load(view) as any).tasks[0]).toMatchObject({ trello: ["0nU0fBM1", "68wGTstW"], trello_scope: "partial" });
  });

  it("o contrato zod da visão (beads-schema.ts) aceita sem erro", () => {
    expect(validateBeads(text).errors).toEqual([]);
  });

  it("estado vazio também é uma visão válida", () => {
    const empty = renderActiveView(buildState([], [], opts), META);
    expect(validateBeads(empty).errors).toEqual([]);
    expect((load(empty) as any).tasks).toEqual([]);
  });

  it("é determinística", () => {
    expect(renderActiveView(buildState([...STATE_INPUTS].reverse(), PROJECT, opts), META)).toBe(text);
  });
});

describe("§7.2 visão index.yaml", () => {
  const text = renderIndexView(buildState(STATE_INPUTS, PROJECT, opts));
  const entries = load(text) as any[];

  it("um bead por linha, por última atividade e depois id", () => {
    expect(entries.map((e) => e.id)).toEqual(["orch-velho", "spec-pendente", "api-login", "ui-form"]);
    expect(text.split("\n").filter((l) => l.startsWith("- {")).length).toBe(4);
  });

  it("campos do índice", () => {
    expect(entries[0]).toEqual({ id: "orch-velho", status: "completed", done: "2026-07-02", updated: "2026-07-02", effort: "S", title: "Velho" });
    expect(entries[2]).toEqual({
      id: "api-login",
      status: "in_progress",
      updated: "2026-10-02",
      effort: "M",
      model: "opus",
      tags: ["auth"],
      title: "Login",
    });
    expect(entries[1].title).toBe("Só descrição");
  });

  it("cabeçalho GERADO e hash que confere", () => {
    expect(text.startsWith("# GERADO por aiteam/scripts/beads-views.mjs")).toBe(true);
    expect(viewIntegrity(text)).toBe("intact");
  });
});

describe("§7.4 integridade da visão", () => {
  const text = renderActiveView(buildState(STATE_INPUTS, PROJECT, opts), META);

  it("corpo editado à mão", () => {
    expect(viewIntegrity(text.replace('"in_progress"', '"completed"'))).toBe("edited");
  });

  it("arquivo sem o cabeçalho GERADO (o active.yaml do modelo antigo)", () => {
    expect(viewIntegrity(`version: "1.0"\nbranch: "main"\ntasks: []\n`)).toBe("foreign");
  });

  it("o hash é calculado em LF: a mesma visão em CRLF continua intacta", () => {
    expect(viewIntegrity(text.replace(/\n/g, "\r\n"))).toBe("intact");
  });
});

describe("acréscimo só no fim", () => {
  it("o conteúdo commitado tem de ser prefixo do novo, comparando em LF", () => {
    const base = `${DEF}entries:\n  - at: "2026-10-02T10:00:00Z"\n    status: "in_progress"\n`;
    expect(isAppendOnly(base, `${base}  - at: "2026-10-03T10:00:00Z"\n    status: "completed"\n`)).toBe(true);
    expect(isAppendOnly(base.replace(/\n/g, "\r\n"), `${base}  - at: "2026-10-03T10:00:00Z"\n`)).toBe(true);
    expect(isAppendOnly(base, base.replace('"in_progress"', '"blocked"'))).toBe(false);
    expect(isAppendOnly(base, base.slice(0, -1))).toBe(false);
  });

  // Sem quebra de linha no fim do commitado, "prefixo" deixaria editar a
  // última linha acrescentando caracteres a ela.
  it("sem quebra de linha no fim do commitado, o acréscimo começa numa linha nova", () => {
    const base = `${DEF}entries:\n  - at: "2026-10-02T10:00:00Z"\n    status: "pending"`;
    expect(isAppendOnly(base, `${base}x\n`)).toBe(false);
    expect(isAppendOnly(base, `${base}\n  - at: "2026-10-03T10:00:00Z"\n    status: "completed"\n`)).toBe(true);
    expect(isAppendOnly(base, base)).toBe(true);
  });
});

// R6: o prefixo textual sozinho deixava anexar uma linha à última entrada já
// commitada — ela passava a valer com o `at` antigo. A comparação já parseada
// (topo igual, entradas antigas iguais) fecha esse furo.
describe("acréscimo só no fim — comparação estrutural (R6)", () => {
  const E1 = `  - at: "2026-10-02T10:00:00Z"\n    status: "in_progress"\n`;
  const E2 = `  - at: "2026-10-03T10:00:00Z"\n    status: "blocked"\n`;
  const base = `${DEF}entries:\n${E1}${E2}`;

  it("campo anexado à última entrada já commitada é recusado, dizendo qual campo e qual entrada", () => {
    const after = `${base}    stage: "review"\n`;
    expect(isAppendOnly(base, after)).toBe(false);
    const problem = appendOnlyProblem(base, after) ?? "";
    expect(problem).toMatch(/stage acrescentado à entrada 2/);
    expect(problem).toMatch(/at 2026-10-03T10:00:00Z/);
    expect(problem).toMatch(/comece uma entrada nova com "- at:"/);
    expect(problem).toMatch(/só cresce no fim/);
  });

  it("entrada nova inteira passa, também depois de uma entrada com campos livres", () => {
    expect(appendOnlyProblem(base, `${base}  - at: "2026-10-04T10:00:00Z"\n    status: "completed"\n    context_summary: "ok"\n`)).toBeNull();
    expect(isAppendOnly(base, `${base}  - at: "2026-10-04T10:00:00Z"\n    note: "x"\n`)).toBe(true);
  });

  it("a definição sem entries ganha a chave entries no fim sem mexer no topo", () => {
    expect(appendOnlyProblem(DEF, `${DEF}entries:\n${E1}`)).toBeNull();
  });

  it("campo novo no topo de um arquivo já commitado é recusado: a definição não muda depois do commit", () => {
    const problem = appendOnlyProblem(DEF, `${DEF}tags: ["a"]\n`) ?? "";
    expect(problem).toMatch(/tags acrescentado ao topo/);
    expect(problem).toMatch(/comece uma entrada nova com "- at:"/);
  });

  it("CRLF no commitado e LF no novo (ou o inverso) dão o mesmo veredito", () => {
    const crlf = base.replace(/\n/g, "\r\n");
    expect(appendOnlyProblem(crlf, `${base}    stage: "review"\n`)).toMatch(/stage acrescentado à entrada 2/);
    expect(appendOnlyProblem(base, `${crlf}  - at: "2026-10-04T10:00:00Z"\r\n    note: "x"\r\n`)).toBeNull();
  });

  it("YAML que não parseia fica com a checagem de prefixo: o erro de formato é de quem valida o arquivo", () => {
    expect(appendOnlyProblem(`${DEF}entries:\n${E1}`, `${DEF}entries:\n${E1}  - at: [\n`)).toBeNull();
  });

  it("bomba de aliases no arquivo novo não derruba a comparação", () => {
    const levels = Array.from({ length: 8 }, (_, i) => `x${i + 1}: &a${i + 1} [${Array(10).fill(`*a${i}`).join(",")}]`);
    const bomb = `x0: &a0 ["a","a","a","a","a","a","a","a","a","a"]\n${levels.join("\n")}\n`;
    expect(() => appendOnlyProblem(`${DEF}${bomb}`, `${DEF}${bomb}y: 1\n`)).not.toThrow();
  });

  it("o meio mudado continua sendo a mensagem do prefixo", () => {
    expect(appendOnlyProblem(base, base.replace('"in_progress"', '"completed"'))).toMatch(/só cresce no fim/);
  });
});

// ── Escrita (fase 2): o que o comando beads e a migração usam ────────────────

describe("appendEntry — só acrescenta no fim", () => {
  const def = `${DEF}`;

  it("cria entries quando falta e respeita a indentação da lista existente", () => {
    const a = appendEntry(def, { at: "2026-10-02T00:00:00Z", status: "completed" });
    expect(a.startsWith(def)).toBe(true);
    expect(load(a)).toMatchObject({ entries: [{ at: "2026-10-02T00:00:00Z", status: "completed" }] });

    const compact = `${def}entries:\n- at: "2026-10-02T00:00:00Z"\n  status: "in_progress"`;
    const b = appendEntry(compact, { at: "2026-10-03T00:00:00Z", status: "blocked" });
    expect(b.startsWith(compact)).toBe(true);
    expect((load(b) as any).entries.map((e: any) => e.status)).toEqual(["in_progress", "blocked"]);
  });

  it("arquivo novo (só adendo): começa pela chave entries", () => {
    const a = appendEntry(null, { at: "2026-10-02T00:00:00Z", note: "feito" });
    expect(a).toBe('entries:\n  - at: "2026-10-02T00:00:00Z"\n    note: "feito"\n');
  });

  it("preserva a quebra de linha do arquivo: CRLF fica CRLF, LF fica LF", () => {
    const lf = `${def}entries:\n  - at: "2026-10-02T00:00:00Z"\n    status: "in_progress"\n`;
    const crlf = lf.replace(/\n/g, "\r\n");
    const entry = { at: "2026-10-03T00:00:00Z", status: "completed", context_summary: "Feito." };
    const a = appendEntry(lf, entry);
    const b = appendEntry(crlf, entry);
    expect(a).not.toContain("\r");
    expect(b.startsWith(crlf)).toBe(true);
    expect(b.replace(/\r\n/g, "\n")).toBe(a);
    expect(b).not.toMatch(/[^\r]\n/);
  });

  it("sem quebra de linha no fim, abre linha nova (em LF e em CRLF)", () => {
    const base = `${def}entries:\n  - at: "2026-10-02T00:00:00Z"\n    status: "in_progress"`;
    expect(appendEntry(base, { at: "2026-10-03T00:00:00Z", note: "x" })).toContain('"in_progress"\n  - at:');
    const crlf = base.replace(/\n/g, "\r\n");
    expect(appendEntry(crlf, { at: "2026-10-03T00:00:00Z", note: "x" })).toContain('"in_progress"\r\n  - at:');
  });

  it("o valor entra entre aspas e escapado: texto com YAML dentro não vira estrutura", () => {
    const evil = 'x"\nstatus: "completed"\n  - at: "2099-01-01T00:00:00Z"';
    const out = appendEntry(`${def}entries:\n  - at: "2026-10-02T00:00:00Z"\n    status: "pending"\n`, { at: "2026-10-03T00:00:00Z", note: evil });
    const doc = load(out) as any;
    expect(doc.entries).toHaveLength(2);
    expect(doc.entries[1]).toEqual({ at: "2026-10-03T00:00:00Z", note: evil });
    expect(appendOnlyProblem(`${def}entries:\n  - at: "2026-10-02T00:00:00Z"\n    status: "pending"\n`, out)).toBeNull();
  });
});

describe("renderDefinition — o arquivo de um bead novo", () => {
  const CREATED = Date.parse("2026-10-05T12:00:00Z");

  it("os campos de definição na ordem do contrato e o created_at por último, com aspas", () => {
    const text = renderDefinition(
      { title: "Login", description: "Formulário", effort: "M", impl_model: "opus", tags: ["auth", "ui"], related_files: ["src/a.ts"], phase: "fase-0", estimated_time_m: 45 },
      CREATED
    );
    expect(text).toBe(
      [
        'title: "Login"',
        'description: "Formulário"',
        'phase: "fase-0"',
        'effort: "M"',
        'impl_model: "opus"',
        "estimated_time_m: 45",
        "related_files:",
        '  - "src/a.ts"',
        "tags:",
        '  - "auth"',
        '  - "ui"',
        'created_at: "2026-10-05T12:00:00Z"',
        "",
      ].join("\n")
    );
  });

  it("trello e trello_scope entram depois de tags, na ordem do contrato, e o resultado é válido", () => {
    const text = renderDefinition({ trello_scope: "partial", trello: ["0nU0fBM1", "68wGTstW"], tags: ["auth"], title: "Login", squad: "z" }, CREATED);
    expect(text).toBe(
      [
        'title: "Login"',
        "tags:",
        '  - "auth"',
        "trello:",
        '  - "0nU0fBM1"',
        '  - "68wGTstW"',
        'trello_scope: "partial"',
        'squad: "z"',
        'created_at: "2026-10-05T12:00:00Z"',
        "",
      ].join("\n")
    );
    const r = one(text, "orch-novo", "feat-x");
    expect(r.errors).toEqual([]);
    expect(r.bead?.fields["trello"]).toEqual(["0nU0fBM1", "68wGTstW"]);
  });

  it("omite o que não veio e o resultado é um arquivo válido, que aceita o acréscimo de entradas", () => {
    const def = renderDefinition({ title: "Só o título", tags: [] }, CREATED);
    expect(def).toBe('title: "Só o título"\ncreated_at: "2026-10-05T12:00:00Z"\n');
    const file = appendEntry(def, { at: "2026-10-05T12:00:00Z", status: "in_progress", stage: "plan" });
    const r = one(file, "orch-novo", "feat-x");
    expect(r.errors).toEqual([]);
    expect(r.bead?.status).toBe("in_progress");
    expect(appendOnlyProblem(def, file)).toBeNull();
  });

  it("texto com aspas, dois-pontos, # e chaves não vira estrutura YAML", () => {
    const title = 'a: "b" # c {d} [e]';
    const text = renderDefinition({ title }, CREATED);
    expect(load(text)).toEqual({ title, created_at: "2026-10-05T12:00:00Z" });
  });
});

describe("nextAt — o horário da entrada nova vence as anteriores", () => {
  const now = Date.parse("2026-10-05T12:00:00.789Z");

  it("sem asserção anterior (ou no passado): é o agora, em segundos inteiros", () => {
    expect(nextAt(now)).toEqual({ ms: Date.parse("2026-10-05T12:00:00Z"), at: "2026-10-05T12:00:00Z", aheadMs: 0 });
    expect(nextAt(now, Date.parse("2026-10-01T00:00:00Z")).at).toBe("2026-10-05T12:00:00Z");
  });

  it("com asserção igual ou à frente do agora: passa 1 s dela (relógio atrasado)", () => {
    const asserted = Date.parse("2026-10-05T12:03:00Z");
    const r = nextAt(now, asserted);
    expect(r.at).toBe("2026-10-05T12:03:01Z");
    expect(r.aheadMs).toBe(r.ms - now);
    expect(nextAt(now, now).ms).toBeGreaterThan(now - 1000);
  });

  it("o horário gerado vence a asserção que o gerou, na combinação", () => {
    const base = `${DEF}entries:\n  - at: "2026-10-05T12:03:00Z"\n    status: "in_progress"\n`;
    const state = one(base);
    const { at } = nextAt(Date.parse("2026-10-05T12:00:00Z"), state.bead!.updatedMs);
    const r = one(appendEntry(base, { at, status: "blocked", blockers: ["api-x"] }), "api-login", "main");
    expect(r.bead?.status).toBe("blocked");
  });

  it("AT_AHEAD_WARN_MS é 5 minutos", () => {
    expect(AT_AHEAD_WARN_MS).toBe(5 * 60 * 1000);
  });
});

describe("pickVersions — a versão de cada arquivo entre árvore, refs e worktrees", () => {
  const E = (n: number, status = "in_progress") => `  - at: "2026-10-0${n}T10:00:00Z"\n    status: "${status}"\n`;
  const v1 = `${DEF}entries:\n${E(2)}`;
  const v2 = `${v1}${E(3, "blocked")}`;
  const v3 = `${v2}${E(4, "completed")}`;
  const src = (kind: "tree" | "worktree" | "head" | "remote", branch: string, extra: Record<string, unknown> = {}) => ({ kind, branch, ...extra });
  const ver = (text: string, source: ReturnType<typeof src>, branchFile = "feat-x", bead = "api-a") => ({ bead, branchFile, text, source });

  it("uma versão só: vale, sem aviso", () => {
    const r = pickVersions([ver(v1, src("head", "feat/x"))]);
    expect(r.warnings).toEqual([]);
    expect(r.picked).toHaveLength(1);
    expect(r.picked[0]).toMatchObject({ bead: "api-a", branchFile: "feat-x", text: v1 });
  });

  it("cadeia por prefixo: vence a mais longa, e a cadeia guarda quem concorda", () => {
    const r = pickVersions([
      ver(v1, src("tree", "main")),
      ver(v2, src("head", "feat/x", { sha7: "abc1234" })),
      ver(v3, src("worktree", "feat/x", { dirty: true })),
    ]);
    expect(r.warnings).toEqual([]);
    expect(r.picked[0]!.text).toBe(v3);
    expect(r.picked[0]!.source.kind).toBe("worktree");
    expect(r.picked[0]!.chain.map((c) => c.source.kind).sort()).toEqual(["head", "tree", "worktree"]);
  });

  it("textos iguais de fontes diferentes: vale a de melhor ordem (árvore, worktree, head, remoto)", () => {
    const r = pickVersions([ver(v1, src("remote", "feat/x")), ver(v1, src("head", "feat/x")), ver(v1, src("worktree", "feat/x"))]);
    expect(r.picked[0]!.source.kind).toBe("worktree");
    expect(r.warnings).toEqual([]);
  });

  it("CRLF e LF do mesmo conteúdo contam como cadeia", () => {
    const r = pickVersions([ver(v1.replace(/\n/g, "\r\n"), src("tree", "main")), ver(v2, src("head", "feat/x"))]);
    expect(r.warnings).toEqual([]);
    expect(r.picked[0]!.text).toBe(v2);
  });

  it("não forma cadeia (amend, rebase, edição à mão): aviso de versões divergentes, e vale a do dono", () => {
    const amended = v2.replace('"in_progress"', '"pending"');
    const r = pickVersions([ver(v2, src("tree", "main")), ver(amended, src("head", "feat/x", { sha7: "abc1234" }))]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/versões divergentes/);
    expect(r.warnings[0]).toMatch(/\.beads\/tasks\/api-a\/feat-x\.yaml/);
    // dono do feat-x.yaml é a branch feat/x (a barra vira traço)
    expect(r.picked[0]!.text).toBe(amended);
    expect(r.picked[0]!.source.kind).toBe("head");
  });

  it("campo anexado à última entrada (R6) também diverge: o prefixo textual não basta", () => {
    const r6 = `${v1}    stage: "review"\n`;
    const r = pickVersions([ver(v1, src("tree", "feat/x")), ver(r6, src("remote", "feat/x"))]);
    expect(r.warnings.join("\n")).toMatch(/versões divergentes/);
    expect(r.picked[0]!.text).toBe(v1);
  });

  it("divergência: a ordem de preferência entre donos é worktree, head local, remoto", () => {
    const a = v2.replace('"in_progress"', '"pending"');
    const b = v2.replace('"in_progress"', '"blocked"');
    const c = v2.replace('"in_progress"', '"completed"');
    const r = pickVersions([ver(c, src("remote", "feat/x")), ver(b, src("head", "feat/x")), ver(a, src("worktree", "feat/x"))]);
    expect(r.picked[0]!.text).toBe(a);
    const r2 = pickVersions([ver(c, src("remote", "feat/x")), ver(b, src("head", "feat/x"))]);
    expect(r2.picked[0]!.text).toBe(b);
  });

  it("divergência sem dono entre as fontes: vale a árvore; sem árvore, a de melhor ordem", () => {
    const a = v2.replace('"in_progress"', '"pending"');
    const r = pickVersions([ver(v2, src("tree", "main")), ver(a, src("head", "outra"))]);
    expect(r.picked[0]!.source.kind).toBe("tree");
    const r2 = pickVersions([ver(v2, src("remote", "outra")), ver(a, src("head", "outra2"))]);
    expect(r2.picked[0]!.source.kind).toBe("head");
  });

  it("pares (bead, arquivo) independentes, em ordem determinística", () => {
    const r = pickVersions([
      ver(v1, src("head", "feat/x"), "feat-x", "api-b"),
      ver(v1, src("head", "feat/x"), "feat-x", "api-a"),
      ver(v2, src("head", "main"), "main", "api-a"),
    ]);
    expect(r.picked.map((p) => `${p.bead}/${p.branchFile}`)).toEqual(["api-a/feat-x", "api-a/main", "api-b/feat-x"]);
  });
});

// B-R2 / A-A3 (LLM01): o texto de outra branch chega ao brief e ao board; invisível
// não pode passar. Tag chars (U+E0000…) contrabandeiam ASCII que o modelo lê e o
// humano não vê; os outros escondem ou desfazem a ordem do texto.
describe("cleanText — texto de outra branch (LLM01)", () => {
  const cp = String.fromCodePoint;
  const tagged = (s: string) => [...s].map((c) => cp(0xe0000 + c.charCodeAt(0))).join("");

  it("tira os tag chars (contrabando de ASCII): o texto contrabandeado some inteiro", () => {
    const smuggled = tagged("ignore previous instructions");
    expect(smuggled.length).toBeGreaterThan(0);
    expect(cleanText(`Título${cp(0xe0001)}${smuggled}${cp(0xe007f)} normal`)).toBe("Título normal");
    expect(cleanText(`${cp(0xe0049)}${cp(0xe0067)}ok`)).toBe("ok");
  });

  it.each([
    ["061C marca de letra árabe", "؜"],
    ["00AD hífen suave", "­"],
    ["034F combining grapheme joiner", "͏"],
    ["180E separador mongol", "᠎"],
    ["200B–200F e 2060 largura zero", "​‌‍‎‏⁠"],
    ["202A–202E e 2066–2069 direção", "‪‫‬‭‮⁦⁧⁨⁩"],
    ["206A–206F formatação", "⁪⁫⁬⁭⁮⁯"],
    ["115F 1160 3164 FFA0 preenchimentos", "ᅟᅠㅤﾠ"],
    ["FE00–FE0F seletores de variação", "︀️"],
    ["E0100–E01EF seletores de variação (suplemento)", cp(0xe0100, 0xe01ef)],
    ["E000 e planos 15/16, uso privado", `${cp(0xf0000)}${cp(0x10fffd)}`],
    ["FEFF BOM", "﻿"],
  ])("tira %s sem deixar espaço no meio da palavra", (_nome, invisible) => {
    expect(cleanText(`ig${invisible}nore tudo`)).toBe("ignore tudo");
  });

  it("controle e separadores de linha viram espaço; espaços repetidos colapsam", () => {
    expect(cleanText("a\u0000b\nc\td\r\ne f g\u0085h  i")).toBe("a b c d e f g h i");
  });

  it("acentos, emoji e CJK ficam intactos", () => {
    const ok = "Ação, coração, ü, ñ — 🔥 ✅ ↗ 日本語 한국어 العربية";
    expect(cleanText(ok)).toBe(ok);
  });

  it("o teto de tamanho continua valendo, em pontos de código inteiros", () => {
    expect(cleanText("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
    expect(cleanText("🔥".repeat(20), 5)).toBe(`${"🔥".repeat(4)}…`); // nunca parte um emoji ao meio
    expect(cleanText(null)).toBe("");
  });
});

describe("parseInstant", () => {
  it("aceita Z com e sem milissegundos e recusa o resto", () => {
    expect(parseInstant("2026-10-05T01:49:14Z")).toBe(Date.parse("2026-10-05T01:49:14Z"));
    expect(parseInstant("2026-10-05T01:49:14.123Z")).toBe(Date.parse("2026-10-05T01:49:14.123Z"));
    for (const bad of ["2026-10-05", "2026-10-05T01:49Z", "2026-10-05T24:00:00Z", "2026-02-30T00:00:00Z", 20261005, null]) {
      expect(parseInstant(bad), String(bad)).toBeNull();
    }
  });
});

// Os gates do .beads rodam sem aiteam/node_modules (worktree nova, clone novo):
// o núcleo só pode depender de node:*, de caminhos relativos e do vendor.
describe("dependências — só node:*, caminhos relativos e o vendor", () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const builtins = new Set(builtinModules);

  const importsOf = (file: string): string[] => {
    const src = readFileSync(file, "utf8");
    const out: string[] = [];
    for (const re of [/^\s*import\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gm, /^\s*export\s+[^'"]*?\s+from\s+["']([^"']+)["']/gm, /\bimport\(\s*["']([^"']+)["']\s*\)/g]) {
      for (const m of src.matchAll(re)) out.push(m[1]!);
    }
    return out;
  };

  const violations = (entry: string): string[] => {
    const seen = new Set<string>();
    const bad: string[] = [];
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const spec of importsOf(file)) {
        if (spec.startsWith("node:") || builtins.has(spec)) continue;
        if (spec.startsWith("./") || spec.startsWith("../")) {
          const target = path.resolve(path.dirname(file), spec);
          if (target.endsWith(".mjs")) walk(target);
          else bad.push(`${path.basename(file)} → ${spec} (só .mjs relativo)`);
          continue;
        }
        bad.push(`${path.basename(file)} → ${spec}`);
      }
    };
    walk(entry);
    return bad;
  };

  it.each([
    ["src/beads-core.mjs"],
    ["src/beads-io.mjs"],
    ["src/beads-aggregate.mjs"],
    ["src/beads-cmd.mjs"],
    ["src/beads-migrate.mjs"],
    ["scripts/beads-views.mjs"],
    ["scripts/beads-check.mjs"],
    ["scripts/beads.mjs"],
    ["scripts/migrate-beads.mjs"],
    ["hooks/session-brief.mjs"],
    ["src/session-brief-core.mjs"],
    ["hooks/beads-guard.mjs"],
    ["src/beads-guard-core.mjs"],
    ["src/trello-reconcile.mjs"],
    ["scripts/beads-trello-reconcile.mjs"],
  ])("%s", (rel) => {
    expect(violations(path.join(HERE, "..", ...rel.split("/")))).toEqual([]);
  });
});

// §2: o .beads/.gitignore canônico. O install.mjs e a migração o garantem
// com a mesma função — idempotente, só acrescentando o que falta.
describe("§2 .gitignore canônico — mergeGitignore", () => {
  it("vazio vira o canônico, que ignora as visões, os backups e o estado local", () => {
    expect(mergeGitignore("")).toBe(GITIGNORE);
    expect(mergeGitignore(null)).toBe(GITIGNORE);
    for (const l of ["/active.yaml", "/index.yaml", "/*.editado-*", "/*.tmp-*", "/*.corrupt-*", "/session.local.json", "/cost-log.json", "/session-log.ndjson"]) {
      expect(GITIGNORE.split("\n")).toContain(l);
    }
    expect(GITIGNORE_PATH).toBe(".beads/.gitignore");
  });

  it("acrescenta só o que falta, sem tocar no que o repo já tem, e é idempotente", () => {
    const host = "# do repo\n/session.local.json\nrascunho.txt\n";
    const once = mergeGitignore(host);
    expect(once.startsWith(host)).toBe(true);
    expect(once.split("\n").filter((l) => l === "/session.local.json")).toHaveLength(1);
    expect(once).toContain("/active.yaml\n");
    expect(mergeGitignore(once)).toBe(once);
    expect(mergeGitignore(GITIGNORE)).toBe(GITIGNORE);
  });

  it("respeita CRLF e arquivo sem quebra de linha no fim", () => {
    const crlf = "/active.yaml\r\n/index.yaml";
    const out = mergeGitignore(crlf);
    expect(out.startsWith("/active.yaml\r\n/index.yaml\r\n")).toBe(true);
    expect(out).not.toMatch(/[^\r]\n/);
    expect(out.match(/\/active\.yaml/g)).toHaveLength(1);
    expect(mergeGitignore(out)).toBe(out);
  });
});
