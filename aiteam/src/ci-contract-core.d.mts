// Declaração de tipos para ci-contract-core.mjs, na convenção src/*.d.mts (ver
// tier-core.d.mts), para os .ts compilarem sob `tsc --noEmit` sem `allowJs`.

/** O diretório do framework vendorizado, relativo à raiz do repo. */
export const FRAMEWORK_DIR: string;

/** Nome de arquivo da raiz que marca uma app (package.json, deno.json(c), pyproject.toml, requirements.txt, setup.py, setup.cfg, Pipfile, go.mod, Cargo.toml, Gemfile, composer.json, pom.xml, build.gradle*, build.sbt, *.csproj, *.fsproj, *.sln, mix.exs, pubspec.yaml). */
export function isAppManifest(name: string): boolean;

/** O bloco `ci:` declarado. Chave ausente vem null; `workdir` vazio é a raiz do repo. */
export interface CiDeclared {
  workdir: string;
  test: string | null;
  /** O portão local do TDD (opcional, só local; o CI roda o `test`). `""` quando a chave está declarada sem comando. */
  local_test: string | null;
  typecheck: string | null;
  lint: string | null;
  reason: string | null;
}

export type CiBlock =
  | { state: "absent" }
  | { state: "malformed"; reason: string }
  | { state: "ok"; ci: CiDeclared };

/** Lê o bloco `ci:` do frontmatter do SPEC.md, sem parser YAML. */
export function readCiBlock(specText: string | null | undefined): CiBlock;

/** Um comando de um script de shell e o diretório em que roda (null quando não dá para resolver). */
export interface ShellSegment {
  dir: string | null;
  argv: string[];
}

export function shellSegments(script: string, baseDir: string | null): ShellSegment[];

export type CiCommandKey = "test" | "typecheck" | "lint";

export interface CiFinding {
  /** `fail` reprova; `warn` passa com ressalva. */
  level: "fail" | "warn";
  key: "spec" | "ci" | "workflows" | "local_test" | CiCommandKey;
  message: string;
}

/** Onde um comando declarado roda: o passo de workflow que o executa. */
export interface CiStepRef {
  file: string;
  job: string;
  step: string;
  /** A cadeia de chamadas quando o passo vem de um workflow reutilizável (`ci.yml › app`). */
  via: string[];
  dir: string | null;
  pathFiltered: boolean;
  nonBlocking: boolean;
  /** Por que esse acerto não basta sozinho (gatilho, if:, continue-on-error, falha engolida pelo shell); vazio quando é limpo. */
  cautions: string[];
}

export interface CiLocated {
  key: CiCommandKey;
  command: string;
  workdir: string;
  where: CiStepRef[];
}

export interface CiEvaluation {
  block: CiBlock;
  findings: CiFinding[];
  located: CiLocated[];
}

/** Um arquivo de .github/workflows: o documento já parseado, ou o erro de parse. */
export interface WorkflowEntry {
  file: string;
  doc?: unknown;
  error?: string;
}

export function evaluateCiContract(input: {
  specText: string | null | undefined;
  /** null quando não há parser YAML para lê-los: o bloco e a delegação ainda são julgados. */
  workflows: readonly WorkflowEntry[] | null;
  /** O `scripts` do package.json em <dir> (relativo à raiz), ou null quando não há. */
  readScripts?: (dir: string) => Record<string, unknown> | null | undefined;
  /** Os manifestos de app achados na raiz (isAppManifest); com algum, ci.workdir dentro de aiteam/ reprova. */
  rootManifests?: readonly string[];
}): CiEvaluation;
