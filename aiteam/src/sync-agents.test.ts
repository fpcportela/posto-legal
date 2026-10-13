import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./repo-root.js";
import {
  GENERATED_MARKER,
  isDrift,
  isGenerated,
  parsePersona,
  planSync,
  renderBinding,
} from "./sync-agents.js";

const persona = (over: Partial<Record<string, string>> = {}): string => {
  const fm = {
    name: "Backend Architect",
    description: "Use when the task touches APIs, business logic or the data layer.",
    model: "sonnet",
    ...over,
  };
  const linhas = Object.entries(fm)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${linhas}\n---\n\n# Agent Persona: Backend Architect\n\n## Role\nYou are a Senior Backend Architect.\n`;
};

describe("parsePersona", () => {
  it("extrai os campos do frontmatter e devolve o corpo sem ele", () => {
    const p = parsePersona(persona(), "backend-architect.md");
    expect(p.name).toBe("Backend Architect");
    expect(p.model).toBe("sonnet");
    expect(p.body).toMatch(/^# Agent Persona/);
    expect(p.body).not.toMatch(/---/);
  });

  // O `name` nativo é slug; o canônico é humano ("SRE / FinOps"). Derivar do
  // arquivo mantém o 1:1 sem um segundo campo para sair de sincronia.
  it("deriva o slug do nome do arquivo, não do campo name", () => {
    expect(parsePersona(persona({ name: "SRE / FinOps" }), "sre-finops.md").slug).toBe("sre-finops");
  });

  it("exige description — é o campo de que o dispatcher nativo depende", () => {
    expect(() => parsePersona(persona({ description: undefined }), "x.md")).toThrow(/description/);
  });

  it("rejeita model fora do enum do .beads/SCHEMA.md", () => {
    expect(() => parsePersona(persona({ model: "gpt-4" }), "x.md")).toThrow(/model/);
  });

  // Aprendido do jeito caro nos .eval.yaml desta mesma branch: `chave: valor:
  // com dois-pontos` num escalar plano o YAML lê como mapping aninhado. O
  // frontmatter gerado é parseado como YAML de verdade pelo harness, então uma
  // description com ": " derruba o binding inteiro em runtime, longe daqui.
  it("rejeita description com dois-pontos — quebraria o YAML do binding gerado", () => {
    const comDoisPontos = "Use when a builder is blocked: failing build or stack trace.";
    expect(() => parsePersona(persona({ description: comDoisPontos }), "x.md")).toThrow(/dois-pontos/);
  });

  // `.md` não está no eol=lf do .gitattributes, então a persona vem CRLF num
  // checkout Windows e LF num Linux. Sem normalizar, o mesmo commit gera
  // bindings diferentes por plataforma e o drift check acusa divergência
  // fantasma no CI — o binding está certo, só nasceu com outra quebra de linha.
  it("normaliza CRLF do corpo para gerar sempre o mesmo binding", () => {
    const crlf = persona().replace(/\n/g, "\r\n");
    const p = parsePersona(crlf, "backend-architect.md");
    expect(p.body).not.toMatch(/\r/);
    expect(renderBinding(p)).not.toMatch(/\r/);
    expect(p.body).toBe(parsePersona(persona(), "backend-architect.md").body);
  });

  it("um persona-file sem frontmatter falha com o arquivo no erro", () => {
    expect(() => parsePersona("# Agent Persona: X\n", "deep-debugger.md")).toThrow(/deep-debugger\.md/);
  });

  // O orquestrador é a persona do loop principal: quem despacha, não quem é
  // despachado. Marcá-lo no dado evita uma lista de exclusão no script.
  it("dispatch: session marca a persona como não-despachável", () => {
    expect(parsePersona(persona({ dispatch: "session" }), "orchestrator.md").dispatchable).toBe(false);
    expect(parsePersona(persona(), "backend-architect.md").dispatchable).toBe(true);
  });
});

describe("renderBinding", () => {
  const p = parsePersona(persona({ name: "SRE / FinOps" }), "sre-finops.md");
  const out = renderBinding(p);

  it("o name do binding é o slug, não a forma humana", () => {
    expect(out).toMatch(/^---\nname: sre-finops\n/);
    expect(out).not.toMatch(/name: SRE \/ FinOps/);
  });

  it("carrega description e model no frontmatter nativo", () => {
    expect(out).toMatch(/description: Use when/);
    expect(out).toMatch(/model: sonnet/);
  });

  it("preserva o corpo da persona como system prompt", () => {
    expect(out).toContain(p.body.trim());
  });

  it("marca proveniência e aponta a fonte canônica", () => {
    expect(isGenerated(out)).toBe(true);
    expect(out).toContain("aiteam/agents/sre-finops.md");
  });

  it("não considera gerado um arquivo escrito à mão", () => {
    expect(isGenerated("---\nname: custom\n---\n\nMinha persona propria.\n")).toBe(false);
  });
});

describe("planSync", () => {
  const backend = parsePersona(persona(), "backend-architect.md");
  const orquestrador = parsePersona(persona({ dispatch: "session" }), "orchestrator.md");

  it("gera o que falta", () => {
    const [acao] = planSync([backend], new Map());
    expect(acao).toMatchObject({ slug: "backend-architect", action: "create" });
  });

  it("não mexe no que já está em dia", () => {
    const plano = planSync([backend], new Map([["backend-architect", renderBinding(backend)]]));
    expect(plano[0]?.action).toBe("up-to-date");
  });

  it("marca como stale quando a fonte mudou", () => {
    const velho = renderBinding(backend).replace("Senior Backend Architect", "Junior");
    expect(planSync([backend], new Map([["backend-architect", velho]]))[0]?.action).toBe("update");
  });

  // Invariante de não-interferência do vendoring: o consumidor pode ter um
  // agente próprio com o mesmo nome. Sobrescrever seria clobber de config do
  // host — o mesmo pecado que o install.mjs evita no settings.json.
  it("nunca sobrescreve um agente escrito pelo host", () => {
    const doHost = "---\nname: backend-architect\n---\n\nRegras proprias do consumidor.\n";
    expect(planSync([backend], new Map([["backend-architect", doHost]]))[0]?.action).toBe("host-owned");
  });

  it("não gera binding para persona de sessão", () => {
    expect(planSync([orquestrador], new Map()).map((a) => a.slug)).not.toContain("orchestrator");
  });

  // Renomear/remover uma persona não pode deixar um subagente fantasma
  // despachável no harness.
  it("sinaliza binding gerado cuja fonte sumiu", () => {
    const orfao = renderBinding(parsePersona(persona(), "removida.md"));
    const plano = planSync([backend], new Map([["removida", orfao]]));
    expect(plano.find((a) => a.slug === "removida")?.action).toBe("orphan");
  });

  it("um arquivo do host sem persona correspondente é deixado em paz", () => {
    const plano = planSync([backend], new Map([["meu-agente", "---\nname: meu-agente\n---\n\nx\n"]]));
    expect(plano.find((a) => a.slug === "meu-agente")?.action).toBe("host-owned");
  });
});

describe("GENERATED_MARKER", () => {
  it("aponta o comando que regenera, para quem abrir o arquivo gerado", () => {
    expect(GENERATED_MARKER).toMatch(/sync:agents/);
  });
});

// Os testes acima usam personas sintéticas. Estes olham os arquivos reais do
// repo — é onde uma persona nova sem frontmatter, ou um binding commitado
// desatualizado, aparecem.
describe("as personas e bindings deste repo", () => {
  const sourceDir = path.resolve(repoRoot(), "aiteam", "agents");
  const targetDir = path.resolve(repoRoot(), ".claude", "agents");

  const personas = fs
    .readdirSync(sourceDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ file: f, raw: fs.readFileSync(path.join(sourceDir, f), "utf8") }));

  it("toda persona canônica tem o frontmatter que o binding exige", () => {
    expect(personas.length).toBeGreaterThan(0);
    for (const { file, raw } of personas) {
      expect(() => parsePersona(raw, file), file).not.toThrow();
    }
  });

  it("o orquestrador é a única persona de sessão", () => {
    const sessao = personas
      .map(({ file, raw }) => parsePersona(raw, file))
      .filter((p) => !p.dispatchable)
      .map((p) => p.slug);
    expect(sessao).toEqual(["orchestrator"]);
  });

  it("os bindings commitados estão em dia com as personas", () => {
    const existing = new Map<string, string>();
    for (const f of fs.readdirSync(targetDir).filter((f) => f.endsWith(".md"))) {
      existing.set(f.replace(/\.md$/, ""), fs.readFileSync(path.join(targetDir, f), "utf8"));
    }
    const drift = planSync(
      personas.map(({ file, raw }) => parsePersona(raw, file)),
      existing,
    ).filter((e) => isDrift(e.action));
    expect(drift.map((e) => `${e.slug}:${e.action}`)).toEqual([]);
  });

  // O guard de dois-pontos existe para este arquivo aqui: o harness lê este
  // frontmatter como YAML de verdade, não com o parser tolerante do sync.
  it("o frontmatter de cada binding é YAML válido e tipado", () => {
    const bindings = fs.readdirSync(targetDir).filter((f) => f.endsWith(".md"));
    expect(bindings.length).toBeGreaterThan(0);
    for (const f of bindings) {
      const raw = fs.readFileSync(path.join(targetDir, f), "utf8");
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1];
      expect(fm, f).toBeDefined();
      const parsed = yaml.load(fm!) as Record<string, unknown>;
      for (const campo of ["name", "description", "model"]) {
        expect(typeof parsed[campo], `${f} → ${campo}`).toBe("string");
      }
      expect(parsed["name"], f).toBe(f.replace(/\.md$/, ""));
    }
  });
});
