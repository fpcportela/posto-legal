// Declaração de tipos para gate-files-core.mjs, na convenção src/*.d.mts (ver tier-core.d.mts).

export type GateKind = "spec" | "tier-rules" | "settings" | "mcp" | "guard-code";

/** O que o `guardCodeMatcher` precisa do disco (síncrono, injetado: o módulo não faz I/O). */
export interface GuardFs {
  exists: (path: string) => boolean;
  read: (path: string) => string | null;
  list: (dir: string) => string[];
}

/** O matcher do código do gate. `isGuardDirectory` diz se um caminho é um dos diretórios que o guardam (aiteam, aiteam/hooks, aiteam/src): apagar ou mover um deles o desliga. */
export type GuardCodeMatcher = ((fullPath: string) => boolean) & { isGuardDirectory?: (fullPath: string) => boolean };

/**
 * Quais caminhos são o CÓDIGO do próprio gate num consumidor: aiteam/hooks/*.mjs, o fecho dos imports deles em
 * aiteam/src (lido dos fontes) e aiteam/templates/tier-rules.json. Com `upstream: true` devolve false para tudo:
 * é onde o guard é desenvolvido. Quem diz que é o upstream é quem chama, lendo AITEAM_UPSTREAM=1 do ambiente (posto
 * pelo `env` do .claude/settings.json do próprio rb-ai-team): nunca um arquivo que o agente possa criar.
 */
export function guardCodeMatcher(root: string, fsOps: GuardFs, options?: { upstream?: boolean }): GuardCodeMatcher;

export interface GateContext {
  /** Raiz do repo (o cwd do hook): `SPEC.md` só é o gate nela. */
  cwd?: string;
  /** Diz se um diretório é raiz de um repo do framework (tem `.claude/` ou `aiteam/`): uma worktree, outro checkout. */
  isFrameworkRoot?: (dir: string) => boolean;
  /** O matcher do código do próprio gate (guardCodeMatcher): só num consumidor. */
  guardCode?: GuardCodeMatcher;
  /** A raiz do repo, quando o `cwd` se move com um `cd`: `SPEC.md` só é o gate nela. */
  root?: string;
}

/**
 * As chaves de topo do `.claude/settings.json` que podem mudar sem perguntar ($schema, model, theme, language,
 * cleanupPeriodDays, worktree). Qualquer outra chave é gate: a lista é de inofensivas, e a chave desconhecida pergunta.
 */
export const SETTINGS_HARMLESS_KEYS: readonly string[];

/** Que arquivo do gate um caminho é, ou null. */
export function gateFileKind(filePath: string, options?: GateContext): GateKind | null;
/** O trecho do SPEC.md que é o gate: o bloco `tier_defaults:` do frontmatter e as linhas que citam `allow_tier3`. */
export function specGateRegion(specText: string | null | undefined): string;
/** Ir de `before` a `after` mexe no gate do SPEC.md (a região mudou, ou o que o guard lê dela mudou)? */
export function touchesSpecGate(before: string, after: string): boolean;
/** A parte do gate de um settings.json, em texto estável; null quando não é um objeto JSON. */
export function settingsGateRegion(text: string | null | undefined): string | null;
/** O texto depois das edições de um Edit/MultiEdit, ou null quando uma delas não se aplica. */
export function applyEdits(
  text: string,
  edits: ReadonlyArray<{ old_string?: unknown; new_string?: unknown; replace_all?: unknown }>
): string | null;

export interface GateEditVerdict {
  kind: GateKind;
  file: string;
  why: string;
}

/** Esta chamada de ferramenta edita o gate? null quando não; senão quem e por quê (o chamador faz o ASK). */
export function gateEditVerdict(call: {
  tool: string;
  input: Record<string, unknown>;
  /** O texto atual do arquivo, ou null quando ele não existe. */
  read: (file: string) => string | null;
  cwd?: string;
  isFrameworkRoot?: (dir: string) => boolean;
  guardCode?: GuardCodeMatcher;
}): GateEditVerdict | null;
/** A mensagem do ASK de uma edição do gate. */
export function gateEditReason(verdict: GateEditVerdict): string;

export interface GateWrite {
  /** O sub-comando que grava. */
  sub: string;
  kind: GateKind;
  file: string;
  why: string;
}

/** O primeiro sub-comando de `command` que grava num arquivo do gate, ou null. `split` é o splitSubCommands do tier-core. */
export function gateWriteInCommand(
  command: string,
  options: {
    split: (command: string) => string[];
    /** Resolve um caminho por symlinks e junctions (null quando não existe). */
    realpath?: (p: string) => string | null;
    /** O texto de um arquivo (o patch de um git apply / patch), ou null quando não dá para ler. */
    read?: (p: string) => string | null;
  } & GateContext
): GateWrite | null;
