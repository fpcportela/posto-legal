// O que o scripts/generate-spec.ts monta em volta da chamada ao LLM: o prompt e
// os dois blocos do frontmatter que o contrato confere, ci: e deploy:.
//
// Os blocos vêm de CÓDIGO, não do modelo. Um LLM chutaria comandos e, pior,
// poderia "resolver" o deploy: com `workflow: none` — um opt-out silencioso que
// o contrato aceita com aviso. Aqui o ci: sai do package.json e o deploy: sai
// com um placeholder que o contrato (aiteam/src/deploy-contract-core.mjs) e o
// doctor reprovam até alguém preencher. O formato é o que
// ci-contract-core.mjs e deploy-contract-core.mjs leem, linha a linha.

export interface ProjectSnapshot {
  packageJson: string | null;
  readmeSnippet: string | null;
  srcTree: string[];
  schemaFiles: string[];
  envExample: string | null;
  recentCommits: string | null;
}

export interface ContractBlocks {
  ci: string;
  deploy: string;
}

// O script test que `npm init` gera: sai sempre com 1, então não é um comando de CI.
const NPM_INIT_TEST = /no test specified/;

function scriptsOf(packageJson: string | null): Record<string, unknown> {
  if (packageJson === null) return {};
  try {
    const parsed: unknown = JSON.parse(packageJson);
    const scripts = (parsed as { scripts?: unknown } | null)?.scripts;
    return scripts !== null && typeof scripts === "object" && !Array.isArray(scripts) ? (scripts as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function hasScript(scripts: Record<string, unknown>, name: string): boolean {
  const body = scripts[name];
  if (typeof body !== "string" || body.trim() === "") return false;
  return !(name === "test" && NPM_INIT_TEST.test(body));
}

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

const RUNNER: Record<PackageManager, string> = { npm: "npm run", pnpm: "pnpm run", yarn: "yarn run", bun: "bun run" };

// Do mais forte para o mais fraco, quando há mais de um lockfile no repo.
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

/**
 * O gerenciador de pacotes do repo, que decide o comando do ci: (`pnpm run test`, não
 * `npm run test` num repo pnpm: o CI roda o que o repo usa, e o contrato confere o
 * comando declarado contra os workflows). O campo `packageManager` do package.json
 * (`pnpm@9.1.0`) vale mais; sem ele, o lockfile (pnpm, yarn, bun, nessa ordem, se houver
 * mais de um); sem nada, npm. Puro: quem chama traz os nomes dos arquivos da raiz.
 */
export function detectPackageManager(packageJson: string | null, rootFiles: readonly string[]): PackageManager {
  if (packageJson !== null) {
    try {
      const declared = (JSON.parse(packageJson) as { packageManager?: unknown } | null)?.packageManager;
      if (typeof declared === "string") {
        const name = /^([a-z]+)@/.exec(declared)?.[1];
        if (name === "pnpm" || name === "yarn" || name === "bun" || name === "npm") return name;
      }
    } catch {
      // package.json ilegível: vale o lockfile.
    }
  }
  const files = new Set(rootFiles);
  for (const [file, manager] of LOCKFILES) if (files.has(file)) return manager;
  return "npm";
}

// Os scripts que rodam só o que a mudança toca, do mais ao menos específico. Um palpite
// de código: serve de portão local do TDD (ci.local_test), nunca de `test`. `test:unit`,
// `test:quick` e afins ficam de fora: são um recorte da suíte, não "o que mudou".
const LOCAL_TEST_SCRIPTS = ["test:changed", "test:affected", "test:related", "test:local"] as const;

/**
 * O bloco `ci:` do rascunho: os scripts `test`, `typecheck` e `lint` do
 * package.json, na raiz (workdir `.`), rodados pelo gerenciador do repo (padrão npm; ver
 * detectPackageManager). `typecheck` e `lint` só entram se o script existe — o contrato
 * os exige só quando declarados. Sem `test` detectado a chave fica vazia, e o contrato
 * reprova ("ci.test é obrigatório") até alguém declarar o comando ou `test: none` com
 * `reason:`. Um script `test:changed` (ou `test:affected`, `test:related`, `test:local`)
 * vira `local_test:`, o portão local do TDD (rb-ai-team#51): opcional, só local — o CI
 * segue rodando o `test` completo e o local_test nunca o substitui.
 */
export function renderCiBlock(packageJson: string | null, manager: PackageManager = "npm"): string {
  const scripts = scriptsOf(packageJson);
  const run = RUNNER[manager];
  const lines = [
    "ci:",
    "  # O que o CI de PR roda para a APP (aiteam/AGENTS.md §CI/CD Mandate, item 1). Detectado do package.json:",
    "  # confira os comandos e o workdir (o diretório da app, a raiz por padrão).",
    "  workdir: .",
  ];
  if (hasScript(scripts, "test")) {
    lines.push(`  test: ${run} test`);
  } else {
    lines.push(
      "  # TODO: o comando que roda os testes da app em PR. Sem suíte automatizada: test: none, com reason: logo abaixo.",
      "  test:",
    );
  }
  const local = LOCAL_TEST_SCRIPTS.find((name) => hasScript(scripts, name));
  if (local !== undefined) {
    lines.push(
      "  # Portão local do TDD, detectado do package.json: os agentes o rodam no lugar do test enquanto trabalham.",
      "  # Opcional e só local: o CI segue rodando o test completo. Apague a linha se não for o comando certo.",
      `  local_test: ${run} ${local}`,
    );
  }
  for (const key of ["typecheck", "lint"]) {
    if (hasScript(scripts, key)) lines.push(`  ${key}: ${run} ${key}`);
  }
  return lines.join("\n");
}

/**
 * O bloco `deploy:` do rascunho: o workflow recomendado, `deploy.yml`, com o
 * `version_url` por preencher. Reprova no contrato e no doctor até alguém copiar
 * o aiteam/templates/deploy.yml.example e declarar o endpoint de versão — de
 * propósito: `workflow: none` é a saída para quem não tem deploy de produção, e
 * essa é uma decisão (com `reason:`) que o rascunho não toma por ninguém.
 */
export function renderDeployBlock(): string {
  return [
    "deploy:",
    "  # TODO: o deploy de produção (aiteam/AGENTS.md §CI/CD Mandate). Copie aiteam/templates/deploy.yml.example para",
    "  # .github/workflows/deploy.yml e preencha version_url com o endpoint sem cache que devolve o SHA servido",
    "  # (ex.: https://<domínio>/api/version). O contrato e o doctor reprovam até lá.",
    "  # Sem deploy de produção: workflow: none, com reason: logo abaixo (um opt-out declarado, que o doctor mostra).",
    "  workflow: deploy.yml",
    "  version_url:",
  ].join("\n");
}

const FENCES = /^---\n([\s\S]*?)\n---/;

// Tira do frontmatter o bloco de topo `key:`, quantas vezes aparecer, delimitado como o
// leitor do contrato o delimita (readCiBlock/readDeployBlock): a chave de coluna 0 e
// tudo até a próxima chave de coluna 0 que não seja comentário nem linha em branco. Um
// comentário na coluna 0 ou uma linha em branco NO MEIO do bloco não o fecham; os que
// vêm DEPOIS da última linha indentada são da chave seguinte e ficam. A chave entre
// aspas (`"ci":`, `'ci':`) é a mesma chave para o YAML — ficar com ela e acrescentar a
// nossa dá chave duplicada —, então também sai (o leitor do contrato não a vê, e é mais
// um motivo para não confiar no que o modelo escreveu).
function dropBlocks(lines: string[], key: string): string[] {
  const header = new RegExp(`^(?:${key}|"${key}"|'${key}')[ \t]*:`);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!header.test(line)) {
      out.push(line);
      continue;
    }
    let last = i;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j] ?? "";
      if (/^[ \t]+\S/.test(l)) last = j; // indentada com conteúdo (inclusive comentário indentado): é do bloco
      else if (/^[ \t]*(?:#.*)?$/.test(l)) continue; // em branco ou comentário de coluna 0: só é do bloco se vier mais indentada depois
      else break; // a próxima chave de topo
    }
    i = last;
  }
  return out;
}

/**
 * Põe no frontmatter do rascunho os blocos `ci:` e `deploy:` gerados por
 * código, no lugar de qualquer coisa que o modelo tenha escrito com esses
 * nomes. Entram antes de `last_updated:` (ou ao fim do frontmatter). O corpo
 * não é tocado. Texto sem frontmatter volta como veio.
 */
export function withContractBlocks(spec: string, blocks: ContractBlocks): string {
  const text = spec.replace(/\r\n/g, "\n");
  const m = FENCES.exec(text);
  if (!m) return spec;

  let lines = (m[1] ?? "").split("\n");
  lines = dropBlocks(dropBlocks(lines, "ci"), "deploy");
  while (lines.length > 0 && (lines[lines.length - 1] ?? "") === "") lines.pop();

  const at = lines.findIndex((l) => /^last_updated[ \t]*:/.test(l));
  const insert = [...blocks.ci.split("\n"), ...blocks.deploy.split("\n")];
  lines = at === -1 ? [...lines, ...insert] : [...lines.slice(0, at), ...insert, ...lines.slice(at)];

  return `---\n${lines.join("\n")}\n---${text.slice(m[0].length)}`;
}

export function buildPrompt(snap: ProjectSnapshot, projectName: string, blocks: ContractBlocks, today: string): string {
  const parts: string[] = [
    `You are a software architect. Analyze this project and produce a filled-in SPEC.md.`,
    `\n## Project: ${projectName}\n`,
  ];

  if (snap.packageJson) {
    parts.push(`### package.json\n\`\`\`json\n${snap.packageJson}\n\`\`\``);
  }
  if (snap.readmeSnippet) {
    parts.push(`### README (excerpt)\n${snap.readmeSnippet}`);
  }
  if (snap.srcTree.length > 0) {
    parts.push(`### Source tree (first 60 files)\n${snap.srcTree.join("\n")}`);
  }
  if (snap.schemaFiles.length > 0) {
    parts.push(`### Schema files\n${snap.schemaFiles.join("\n")}`);
  }
  if (snap.envExample) {
    parts.push(`### .env.example\n\`\`\`\n${snap.envExample}\n\`\`\``);
  }
  if (snap.recentCommits) {
    parts.push(`### Recent git commits\n${snap.recentCommits}`);
  }

  parts.push(`
## Output Instructions

Produce ONLY the contents of a SPEC.md file using this exact template. Fill in every section based on the project analysis. Do NOT add prose outside the template. If you cannot determine a value, write "TODO: <question to ask the developer>".

Se o projeto analisado roda em VPS/host compartilhado (indícios: docker-compose
com portas publicadas, scripts de deploy por ssh, nginx conf), preencha
infra_kb.remote com o nome sugerido do remote e deixe url vazia para o operador
preencher. Caso contrário, emita o bloco com todos os campos vazios.

Os blocos ci: e deploy: do frontmatter já foram montados por código: copie-os
LITERALMENTE, com os comentários, sem completar, trocar ou remover nada.

\`\`\`markdown
---
project: "${projectName}"
version: "0.1.0"
budget_usd: 2.00
tier_defaults:
  allow_tier1: true
  allow_tier2: true
  allow_tier3: false
infra_kb:
  remote: ""
  url: ""
  ref: "main"
  entry: "README.md"
${blocks.ci}
${blocks.deploy}
last_updated: "${today}"
---

# Project Specification

## 1. Project Overview
<one paragraph>

## 2. Architecture
- **Frontend:**
- **Backend:**
- **Database:**
- **AI Layer:**
- **Infrastructure:**

## 3. Domain Model
<core entities and relationships>

## 4. Feature Scope

### In Scope
<bullet list of detected features>

### Out of Scope
<anything clearly absent>

## 5. API Contracts
<key endpoints or function signatures detected>

## 6. Non-Functional Requirements
- **Performance:**
- **Security:**
- **Observability:**

## 7. Open Decisions
<list of TODOs that need developer clarification>

## 8. Change Log
| Date | Change | Author |
|------|--------|--------|
| ${today} | Generated by generate-spec.ts | AI |
\`\`\`
`);

  return parts.join("\n\n");
}
