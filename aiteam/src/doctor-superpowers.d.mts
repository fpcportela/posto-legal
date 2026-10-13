import type { CheckResult } from "./doctor-core.mjs";

/** A versão do superpowers com que o framework foi validado (a que o marketplace oficial serve). */
export const SUPERPOWERS_VALIDATED: string;

/** `major.minor.patch` de um texto de versão, ou null quando não começa por três números. */
export function parseVersion(text: unknown): [number, number, number] | null;

/**
 * A versão como pode ser impressa: major.minor.patch com sufixo opcional de [0-9A-Za-z.+-], até 32 caracteres, sem o `v`
 * e sem o espaço das pontas. Null para qualquer outro texto (o que vem de arquivo de fora não chega cru à tela).
 */
export function cleanVersion(text: unknown): string | null;

export function compareVersions(a: readonly [number, number, number], b: readonly [number, number, number]): number;

/** Uma linha do doctor que nunca reprova: INFO por padrão, WARN para o hook do Windows antes da 6.2.0. */
export interface SuperpowersCheckResult extends CheckResult {
  pass: true;
  /** Só informa; o doctor a mostra como INFO. */
  info?: true;
}

/**
 * A versão instalada do superpowers e se ele está ligado, mais a versão com que o framework foi validado.
 * Null (sem linha) quando não há versão nem estado.
 */
export function checkSuperpowers(facts: {
  /** O estado efetivo em enabledPlugins (usuário, projeto, local); null quando nenhum settings o declara. */
  enabled: boolean | null;
  version: string | null;
  /** Havia uma versão no registro, mas não era uma versão (cleanVersion): a linha diz "versão ilegível". */
  versionUnreadable?: boolean;
  /** process.platform */
  platform: string;
}): SuperpowersCheckResult | null;

/**
 * Lê o estado de enabledPlugins (settings.json do diretório de configuração do usuário e .claude/settings*.json do repo)
 * e a versão (registro de instalação em plugins/, senão o cache de plugins), da mesma chave superpowers@<marketplace>.
 * O diretório de configuração é o CLAUDE_CONFIG_DIR, quando definido, ou ~/.claude. Só lê dentro dessas duas árvores,
 * depois de resolver symlink e junction; nunca lança.
 */
export function readSuperpowersFacts(where: {
  /** A raiz do repo. */
  root: string;
  /** O diretório do usuário; sem ele, `homedir()` — chamado só se faz falta e dentro do try. */
  home?: string;
  /** O ambiente (padrão process.env): o CLAUDE_CONFIG_DIR, quando definido, é o diretório de configuração do usuário. */
  env?: Record<string, string | undefined>;
  /** Só os testes trocam. */
  homedir?: () => string;
}): {
  enabled: boolean | null;
  version: string | null;
  /** Havia versão no registro, mas nenhuma passou no cleanVersion. */
  versionUnreadable: boolean;
};
