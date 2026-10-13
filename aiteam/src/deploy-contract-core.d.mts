// Declaração de tipos para deploy-contract-core.mjs, na convenção src/*.d.mts
// (ver ci-contract-core.d.mts), para os .ts compilarem sob `tsc --noEmit` sem `allowJs`.

/** O bloco `deploy:` declarado. Chave ausente vem null; `workflow` é o nome do arquivo em .github/workflows/, ou "none". */
export interface DeployDeclared {
  workflow: string | null;
  version_url: string | null;
  reason: string | null;
}

export type DeployBlock =
  | { state: "absent" }
  | { state: "malformed"; reason: string }
  | { state: "ok"; deploy: DeployDeclared };

/** Lê o bloco `deploy:` do frontmatter do SPEC.md, sem parser YAML. */
export function readDeployBlock(specText: string | null | undefined): DeployBlock;

/** As três peças do rollback-by-rerun que o núcleo procura no workflow declarado. */
export type DeployPieceKey = "ref" | "version" | "tag";

export interface DeployFinding {
  /** `fail` reprova; `warn` passa com ressalva (o opt-out, workflows não conferidos, permissions não declarado). */
  level: "fail" | "warn";
  /**
   * `permissions`: o job da tag sem contents: write (fail) ou sem permissions declarado (warn).
   * `order`: a tag não vem depois da consulta à version_url (fail), ou vem no mesmo passo (warn).
   * `condition`: a comparação só roda sob um if: próprio do passo (warn que o contract test barra).
   * `pinned`: o host pousa num branch fixo — reset --hard origin/<branch>, checkout/switch literal (warn que o contract test barra).
   * `pull`: git pull num passo ou script do workflow (fail).
   * `sha`: github.sha no deploy, no health check ou na tag de um workflow com o input ref (fail).
   * `ref` também sai como warn quando o deploy roda no runner (checkout da ref sem passo remoto).
   */
  key: "spec" | "deploy" | "workflow" | "version_url" | "workflows" | "permissions" | "order" | "condition" | "pinned" | "pull" | "sha" | DeployPieceKey;
  message: string;
}

/** Onde uma peça foi achada: `deploy.yml › deploy › Health check`, com o script quando é um. */
export interface DeployLocated {
  key: DeployPieceKey;
  where: string;
}

export interface DeployEvaluation {
  block: DeployBlock;
  findings: DeployFinding[];
  located: DeployLocated[];
}

/** O que o contract test reprova: toda falha e os avisos de permissions e de ordem. */
export function contractBlockers(evaluation: { findings: readonly DeployFinding[] }): string[];

export function evaluateDeployContract(input: {
  specText: string | null | undefined;
  /** Os arquivos de .github/workflows já parseados; null quando não há parser YAML. */
  workflows: readonly { file: string; doc?: unknown; error?: string }[] | null;
  /** O texto de um arquivo do repo (caminho relativo à raiz), ou null quando não existe. */
  readFile?: (rel: string) => string | null | undefined;
}): DeployEvaluation;
