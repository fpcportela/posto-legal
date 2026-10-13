import { describe, it, expect } from "vitest";
import { load as yamlLoad } from "js-yaml";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readPointer,
  diagnosePointer,
  extract,
  nextFreePort,
  formatExtract,
  matchesInfraPath,
  buildInfraKbLine,
  claimPort,
} from "./infra-kb-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const README = readFileSync(path.join(HERE, "__fixtures__", "infra-kb-readme.md"), "utf8");

// Mesmo invariante de session-brief/tier-core: o módulo testado não pode ter
// shebang (o strip do vite-node deixa um CR órfão em checkout CRLF).
describe("infra-kb split — o módulo testado fica sem shebang", () => {
  it("o core não tem shebang", () => {
    const core = readFileSync(path.join(HERE, "infra-kb-core.mjs"), "utf8");
    expect(core.startsWith("#!")).toBe(false);
  });
});

const SPEC_COM_KB = `---
project: "demo"
budget_usd: 2.00
infra_kb:
  remote: vps-infra
  url: git@github.com:thiagoriosbraz/vps-infra.git
  ref: main
  entry: README.md
---

# Project Specification
`;

const SPEC_SEM_KB = `---
project: "demo"
budget_usd: 2.00
---

# Project Specification
`;

describe("readPointer", () => {
  it("lê o ponteiro completo do frontmatter", () => {
    const p = readPointer(SPEC_COM_KB, yamlLoad);
    expect(p).toEqual({
      remote: "vps-infra",
      url: "git@github.com:thiagoriosbraz/vps-infra.git",
      ref: "main",
      entry: "README.md",
    });
  });

  it("aplica os defaults de ref e entry", () => {
    const spec = `---
infra_kb:
  remote: kb
---
`;
    const p = readPointer(spec, yamlLoad);
    expect(p?.ref).toBe("main");
    expect(p?.entry).toBe("README.md");
    expect(p?.url).toBeNull();
  });

  it("devolve null quando o slot não existe — a invariante de silêncio", () => {
    expect(readPointer(SPEC_SEM_KB, yamlLoad)).toBeNull();
  });

  it("devolve null quando o slot existe mas está vazio", () => {
    expect(readPointer("---\ninfra_kb:\n---\n", yamlLoad)).toBeNull();
  });

  it("devolve null quando falta o remote — sem remote não há como ler nada", () => {
    expect(readPointer("---\ninfra_kb:\n  ref: main\n---\n", yamlLoad)).toBeNull();
  });

  it("devolve null sem frontmatter, com YAML inválido, ou com texto nulo", () => {
    expect(readPointer("# só markdown", yamlLoad)).toBeNull();
    expect(readPointer("---\n::: not yaml :::\n---\n", yamlLoad)).toBeNull();
    expect(readPointer(null, yamlLoad)).toBeNull();
  });

  // Checkout Windows com core.autocrlf=true: o SPEC.md chega em CRLF. Este
  // leitor já era tolerante; o caso trava isso agora que ele usa o leitor
  // compartilhado de frontmatter.mjs.
  // F9: com um BOM no início o infra_kb ficava mudo e o doctor dizia "sem host
  // compartilhado, ok", porque o leitor ignorava o arquivo inteiro.
  it("lê o mesmo ponteiro com um BOM no início do SPEC.md", () => {
    const esperado = {
      remote: "vps-infra",
      url: "git@github.com:thiagoriosbraz/vps-infra.git",
      ref: "main",
      entry: "README.md",
    };
    expect(readPointer(`\uFEFF${SPEC_COM_KB}`, yamlLoad)).toEqual(esperado);
    expect(readPointer(`\uFEFF${SPEC_COM_KB.replace(/\n/g, "\r\n")}`, yamlLoad)).toEqual(esperado);
  });

  it("lê o mesmo ponteiro com o SPEC.md em CRLF", () => {
    expect(readPointer(SPEC_COM_KB.replace(/\n/g, "\r\n"), yamlLoad)).toEqual({
      remote: "vps-infra",
      url: "git@github.com:thiagoriosbraz/vps-infra.git",
      ref: "main",
      entry: "README.md",
    });
    expect(readPointer(SPEC_SEM_KB.replace(/\n/g, "\r\n"), yamlLoad)).toBeNull();
  });
});

// Finding 2 do review final: readPointer colapsa "sem slot" e "slot
// malformado" no mesmo `null` — de propósito, é o que os hooks (que nunca
// podem quebrar) precisam. Mas isso deixa checkInfraKb (doctor) incapaz de
// reclamar de um ponteiro quebrado, como o spec §7 promete. diagnosePointer é
// a segunda leitura, só para o doctor, que NÃO muda o que os hooks recebem
// (eles continuam usando readPointer, intocado).
describe("diagnosePointer — só o doctor precisa distinguir ausente de malformado", () => {
  it("é 'absent' sem SPEC.md, sem frontmatter, ou sem o bloco infra_kb", () => {
    expect(diagnosePointer(null, yamlLoad)).toEqual({ state: "absent" });
    expect(diagnosePointer("# só markdown", yamlLoad)).toEqual({ state: "absent" });
    expect(diagnosePointer(SPEC_SEM_KB, yamlLoad)).toEqual({ state: "absent" });
  });

  // O TESTE QUE PROTEGE O TEMPLATE DESTE REPO: o SPEC.md da raiz declara
  // infra_kb com remote/url em branco de propósito ("o rb-ai-team não roda em
  // infra compartilhada"). Isso TEM que continuar batendo com "absent" (PASS
  // silencioso) — não pode virar "malformed" só porque os campos existem e
  // estão vazios.
  it("é 'absent' quando o bloco existe mas remote e url estão os dois em branco (o template)", () => {
    const spec = `---
infra_kb:
  remote: ""
  url: ""
  ref: "main"
  entry: "README.md"
---
`;
    expect(diagnosePointer(spec, yamlLoad)).toEqual({ state: "absent" });
  });

  it("é 'absent' quando o bloco existe mas está vazio (infra_kb: ~)", () => {
    expect(diagnosePointer("---\ninfra_kb:\n---\n", yamlLoad)).toEqual({ state: "absent" });
  });

  it("é 'ok' e devolve o ponteiro completo quando remote está preenchido", () => {
    const d = diagnosePointer(SPEC_COM_KB, yamlLoad);
    expect(d).toEqual({
      state: "ok",
      pointer: {
        remote: "vps-infra",
        url: "git@github.com:thiagoriosbraz/vps-infra.git",
        ref: "main",
        entry: "README.md",
      },
    });
  });

  it("é 'malformed' quando infra_kb não é um mapeamento", () => {
    const d = diagnosePointer("---\ninfra_kb: vps-infra\n---\n", yamlLoad);
    expect(d.state).toBe("malformed");
    if (d.state !== "malformed") return;
    expect(d.reason).toMatch(/mapeamento/i);
  });

  // O caso "mis-nesting" do finding: nenhum campo reconhecido (remote/url/
  // ref/entry) aparece direto sob infra_kb — tudo foi aninhado um nível a
  // mais por engano. Sem essa checagem, remote/url ficam os dois
  // "indefinidos" e o bloco cairia (erradamente) no mesmo balde do template
  // vazio.
  it("é 'malformed' quando o bloco está aninhado errado (nenhum campo reconhecido direto)", () => {
    const spec = `---
infra_kb:
  config:
    remote: vps-infra
    url: git@github.com:thiagoriosbraz/vps-infra.git
---
`;
    const d = diagnosePointer(spec, yamlLoad);
    expect(d.state).toBe("malformed");
    if (d.state !== "malformed") return;
    expect(d.reason).toMatch(/aninhado/i);
  });

  it("é 'malformed' quando url está preenchida mas remote ficou em branco", () => {
    const spec = `---
infra_kb:
  remote: ""
  url: git@github.com:thiagoriosbraz/vps-infra.git
---
`;
    const d = diagnosePointer(spec, yamlLoad);
    expect(d.state).toBe("malformed");
    if (d.state !== "malformed") return;
    expect(d.reason).toMatch(/remote/i);
  });

  // O Minor adiado: um `remote` que não é string (ex.: um objeto aninhado)
  // não pode virar silenciosamente a string "[object Object]" — precisa ser
  // sinalizado como malformado.
  it("é 'malformed' quando remote não é um texto", () => {
    const spec = `---
infra_kb:
  remote: 12345
---
`;
    const d = diagnosePointer(spec, yamlLoad);
    expect(d.state).toBe("malformed");
    if (d.state !== "malformed") return;
    expect(d.reason).toMatch(/remote/i);
  });

  it("é 'malformed' quando o frontmatter não é YAML válido", () => {
    const d = diagnosePointer("---\n::: not yaml :::\n---\n", yamlLoad);
    expect(d.state).toBe("malformed");
    if (d.state !== "malformed") return;
    expect(d.reason).toMatch(/yaml/i);
  });

  it("diagnostica igual com o SPEC.md em CRLF", () => {
    expect(diagnosePointer(SPEC_COM_KB.replace(/\n/g, "\r\n"), yamlLoad)).toEqual({
      state: "ok",
      pointer: {
        remote: "vps-infra",
        url: "git@github.com:thiagoriosbraz/vps-infra.git",
        ref: "main",
        entry: "README.md",
      },
    });
    expect(diagnosePointer(SPEC_SEM_KB.replace(/\n/g, "\r\n"), yamlLoad)).toEqual({ state: "absent" });
  });
});

describe("nextFreePort", () => {
  it("devolve a semente quando ela está livre", () => {
    expect(nextFreePort([3000, 3100], 3214)).toBe(3214);
  });

  it("avança enquanto a porta estiver ocupada", () => {
    expect(nextFreePort([3212, 3213, 3214], 3212)).toBe(3215);
  });

  it("ignora portas fora da vizinhança da semente", () => {
    expect(nextFreePort([80, 443, 8090], 3212)).toBe(3212);
  });
});

describe("extract", () => {
  it("lê todas as linhas do registro de portas", () => {
    const r = extract(README);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ports).toHaveLength(6);
    const riosbraz = r.ports.find((p) => p.app === "riosbraz.com.br");
    expect(riosbraz?.port).toBe(3212);
    expect(riosbraz?.service).toContain("nginx static");
  });

  it("preserva a linha não-numérica sem inventar um número", () => {
    const r = extract(README);
    if (!r.ok) throw new Error("extract falhou");
    const edge = r.ports.find((p) => p.raw.includes("443"));
    expect(edge?.port).toBeNull();
    expect(edge?.app).toBe("omniform");
  });

  // O TESTE DE REGRESSÃO DO §1.2 DO SPEC. A fixture diz "3212+" na frase e
  // lista 3212 e 3213 na tabela. Um agente que confia na frase recomenda uma
  // porta ocupada — foi o que o levantamento encontrou em riosbraz.com.br.
  // A faixa livre TEM que sair das linhas, semeada pela frase.
  it("deriva a faixa livre das linhas, não da frase desatualizada", () => {
    const r = extract(README);
    if (!r.ok) throw new Error("extract falhou");
    expect(r.freeRanges).toEqual([3214, 8100]);
    expect(r.freeRanges).not.toContain(3212);
  });

  it("captura as seções de regras e de limites para o extrato", () => {
    const r = extract(README);
    if (!r.ok) throw new Error("extract falhou");
    expect(r.sections.rules).toContain("172.17.0.1");
    expect(r.sections.limits).toContain("Static/nginx");
  });

  // Falhar barulhento, nunca vazio: uma tabela vazia seria lida como
  // "nenhuma porta ocupada" e é pior que não ter KB nenhuma.
  it("falha explicitamente quando a tabela de portas some", () => {
    const semTabela = "# vps-infra\n\n## 5. Rules & hazards\n\n- alguma regra\n";
    const r = extract(semTabela);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/registro de portas/i);
  });

  it("falha explicitamente com texto nulo ou vazio", () => {
    expect(extract(null).ok).toBe(false);
    expect(extract("").ok).toBe(false);
  });

  it("tolera a ausência das seções advisory sem falhar", () => {
    const soTabela = [
      "| Port | App | Service | Notes |",
      "|------|-----|---------|-------|",
      "| 3300 | x | `web` | nota |",
    ].join("\n");
    const r = extract(soTabela);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sections.rules).toBe("");
    expect(r.sections.limits).toBe("");
  });

  // ADENDO Task 4: cabeçalho encontrado mas zero linhas de dado (ex.: uma
  // linha em branco entre o cabeçalho e as linhas) é a mesma "lista vazia
  // disfarçada de sucesso" do bug de riosbraz.com.br — com ok:true e
  // ports:[], a faixa livre derivada colapsa de volta pra frase desatualizada,
  // que é exatamente o que este módulo existe pra evitar.
  it("falha explicitamente quando o cabeçalho existe mas nenhuma linha de dado o segue", () => {
    const cabecalhoOrfao = [
      "| Port | App | Service | Notes |",
      "|------|-----|---------|-------|",
      "",
      "| 3300 | app | `web` | nota |",
    ].join("\n");
    const r = extract(cabecalhoOrfao);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/nenhuma linha/i);
  });
});

describe("formatExtract", () => {
  it("rende portas ocupadas, faixa livre e as seções advisory", () => {
    const r = extract(README);
    if (!r.ok) throw new Error("extract falhou");
    const out = formatExtract(r);
    expect(out).toContain("3212");
    expect(out).toContain("riosbraz.com.br");
    expect(out).toContain("3214");
    expect(out).toContain("172.17.0.1");
    expect(out).toContain("Static/nginx");
  });

  it("trunca notas longas — o extrato entra em contexto, não o README inteiro", () => {
    const longa = "x".repeat(500);
    const r = extract(
      [
        "| Port | App | Service | Notes |",
        "|------|-----|---------|-------|",
        `| 3300 | app | \`web\` | ${longa} |`,
      ].join("\n")
    );
    if (!r.ok) throw new Error("extract falhou");
    const out = formatExtract(r, { maxNoteChars: 40 });
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(400);
  });
});

describe("matchesInfraPath", () => {
  it("casa os arquivos que definem recursos no host", () => {
    for (const p of [
      "docker-compose.yml",
      "infra/docker-compose.prod.yaml",
      "Dockerfile",
      "apps/api/Dockerfile.prod",
      "infra/aws/main.tf",
      "terraform/s3.tf",
      "nginx/conf.d/site.conf",
    ]) {
      expect(matchesInfraPath(p), p).toBe(true);
    }
  });

  it("NÃO casa arquivos que só falam sobre infra", () => {
    for (const p of [
      "docs/Dockerfile-explained.md",
      "docs/infra/shared-vps-architecture.md",
      "src/nginx-client.ts",
      "src/infrastructure/repository.ts",
      "README.md",
    ]) {
      expect(matchesInfraPath(p), p).toBe(false);
    }
  });

  it("normaliza separador do Windows e tolera entrada nula", () => {
    expect(matchesInfraPath("infra\\docker-compose.yml")).toBe(true);
    expect(matchesInfraPath(null)).toBe(false);
  });
});

const POINTER = { remote: "vps-infra", url: null, ref: "main", entry: "README.md" };

describe("buildInfraKbLine", () => {
  it("não emite nada sem ponteiro — a invariante de silêncio", () => {
    expect(
      buildInfraKbLine({
        pointer: null,
        fetched: false,
        remoteExists: false,
        refDate: null,
        ageDays: null,
        extracted: null,
      })
    ).toBeNull();
  });

  it("no caminho feliz informa remote, data e faixa livre", () => {
    const line = buildInfraKbLine({
      pointer: POINTER,
      fetched: true,
      remoteExists: true,
      refDate: "2026-08-03",
      ageDays: 0,
      extracted: extract(README),
    });
    expect(line).toContain("vps-infra");
    expect(line).toContain("2026-08-03");
    expect(line).toContain("3214+");
    expect(line).not.toContain("⚠️");
  });

  it("avisa e proíbe reserva quando o fetch falha", () => {
    const line = buildInfraKbLine({
      pointer: POINTER,
      fetched: false,
      remoteExists: true,
      refDate: "2026-07-12",
      ageDays: 22,
      extracted: extract(README),
    });
    expect(line).toContain("⚠️");
    expect(line).toContain("22 dias");
    expect(line).toMatch(/não reserve porta/i);
  });

  it("manda rodar o install quando o remote não existe", () => {
    const line = buildInfraKbLine({
      pointer: POINTER,
      fetched: false,
      remoteExists: false,
      refDate: null,
      ageDays: null,
      extracted: null,
    });
    expect(line).toContain("⚠️");
    expect(line).toContain("install.mjs");
  });

  it("reporta o erro de parsing em vez de fingir que leu", () => {
    const line = buildInfraKbLine({
      pointer: POINTER,
      fetched: true,
      remoteExists: true,
      refDate: "2026-08-03",
      ageDays: 0,
      extracted: extract("# sem tabela nenhuma"),
    });
    expect(line).toContain("⚠️");
    expect(line).toMatch(/registro de portas/i);
  });
});

const CLAIM = { port: 3214, app: "novo-app", service: "`web` (Next.js)", notes: "host-gateway; reservado 2026-08-05" };

// Variantes explícitas do MESMO conteúdo, uma por terminador de linha —
// derivadas da fixture, não lidas dela crua. O checkout local (Windows,
// core.autocrlf=true, sem .gitattributes pra esse path) materializa a
// fixture em disco com CRLF; num runner Linux ela chega em LF. Normalizar
// pra LF e depois reconstruir o CRLF garante que os dois terminadores sejam
// exercitados sempre, nos dois sentidos, não só o que o checkout atual dá.
const README_LF = README.replace(/\r\n/g, "\n");
const README_CRLF = README_LF.replace(/\n/g, "\r\n");

describe("claimPort", () => {
  it("insere a linha na ordem numérica", () => {
    const r = claimPort(README, CLAIM);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const linhas = r.text.split("\n").filter((l) => /^\| \d+ \|/.test(l));
    // Non-null: `linhas` já foi filtrado pelo regex `^\| \d+ \|`, então o
    // índice [1] sempre existe — só o noUncheckedIndexedAccess do tsconfig
    // exige a garantia explícita aqui.
    const portas = linhas.map((l) => Number(l.split("|")[1]!.trim()));
    expect(portas).toEqual([...portas].sort((a, b) => a - b));
    expect(portas).toContain(3214);
  });

  // A salvaguarda que substitui a revisão por PR — mas não é mais "cada linha
  // fica onde estava": a tabela é reordenada por porta, e o registro real não
  // chega ordenado (ver o comentário em claimPort). A garantia que sobra é
  // mais estrita do que parece à primeira vista: nenhuma linha existente tem
  // o CONTEÚDO alterado — terminador de linha incluso —, nenhuma é perdida,
  // nenhuma é duplicada — só a posição pode mudar. Um bug de sort que
  // duplicasse ou apagasse uma linha escaparia de uma comparação por set
  // (`Array.includes`); os asserts de contagem abaixo existem para pegar
  // exatamente isso.
  //
  // Roda contra LF e CRLF explicitamente: a implementação anterior fazia
  // `readmeText.split(/\r?\n/)` e depois `lines.join("\n")` incondicional —
  // aceitava qualquer terminador de entrada mas sempre IMPUNHA LF na saída.
  // Contra um input LF isso não dá pra distinguir de "preservou corretamente"
  // (LF vira LF por coincidência); só o caso CRLF expõe o bug — cada linha
  // perde o `\r`, e o assert de contagem abaixo reporta, corretamente, que
  // nenhuma linha pré-existente sobreviveu intacta. Essa foi a falha real
  // reportada num checkout Windows depois do merge.
  it.each([
    ["LF", README_LF, "\n"],
    ["CRLF", README_CRLF, "\r\n"],
  ] as const)(
    "não altera, não perde e não duplica nenhuma linha existente, e preserva o terminador de linha do input (%s)",
    (_label, readme, eol) => {
      const antes = readme.split(eol);
      const r = claimPort(readme, CLAIM);
      if (!r.ok) throw new Error("claim falhou");

      // O terminador de SAÍDA tem que ser o MESMO do input. Depois de
      // remover todo par "\r\n" do texto, não pode sobrar nenhum "\r" ou
      // "\n" solto — pega tanto "impôs o terminador errado" quanto
      // "misturou os dois".
      if (eol === "\r\n") {
        expect(r.text).toContain("\r\n");
        expect(r.text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
      } else {
        expect(r.text).not.toMatch(/\r/);
      }

      const depois = r.text.split(eol);

      // A única linha que pode sumir do documento inteiro é a frase "Free
      // ranges" — ela é reescrita, não preservada.
      const removidas = antes.filter((l) => !depois.includes(l));
      expect(removidas.every((l) => /Free ranges/.test(l))).toBe(true);

      // O bloco de linhas de tabela (cabeçalho, separador e as linhas de
      // dado — tudo que abre com "|") cresce em exatamente UMA linha: a
      // reserva nova.
      const isRowLine = (l: string) => l.trimStart().startsWith("|");
      const linhasAntes = antes.filter(isRowLine);
      const linhasDepois = depois.filter(isRowLine);
      expect(linhasDepois).toHaveLength(linhasAntes.length + 1);

      // Cada linha de tabela pré-existente sobrevive byte a byte idêntica
      // (terminador já removido pelo split acima) e exatamente uma vez —
      // nem some (perda), nem aparece duas vezes (duplicação por bug de
      // sort), nem vira outra string (mangling, inclusive perder o "\r").
      const contagemDepois = new Map<string, number>();
      for (const l of linhasDepois) contagemDepois.set(l, (contagemDepois.get(l) ?? 0) + 1);
      for (const linha of linhasAntes) {
        expect(contagemDepois.get(linha)).toBe(1);
      }

      expect(depois.filter((l) => l.includes("riosbraz.com.br"))).toHaveLength(1);
      expect(depois.filter((l) => l.includes("trabalhista"))).toHaveLength(1);
    }
  );

  it("atualiza a frase Free ranges quando a porta reservada abria o bloco", () => {
    const r = claimPort(README, CLAIM);
    if (!r.ok) throw new Error("claim falhou");
    expect(r.text).toMatch(/Free ranges[^\n]*`3215\+`/);
    expect(r.text).toMatch(/Free ranges[^\n]*`8100\+`/);
  });

  it("é idempotente quando o mesmo app já reservou a porta", () => {
    const um = claimPort(README, CLAIM);
    if (!um.ok) throw new Error("claim falhou");
    const dois = claimPort(um.text, CLAIM);
    expect(dois.ok).toBe(true);
    if (!dois.ok) return;
    expect(dois.changed).toBe(false);
    expect(dois.text).toBe(um.text);
  });

  it("recusa quando a porta já é de outro app", () => {
    const r = claimPort(README, { ...CLAIM, port: 3212 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("riosbraz.com.br");
  });

  it("recusa quando a KB não tem registro parseável", () => {
    expect(claimPort("# nada aqui", CLAIM).ok).toBe(false);
  });
});
