// Tipos de trello-reconcile.mjs, na convenção src/*.d.mts (ver tier-core.d.mts).

export const TRELLO_API: string;
export const DEFAULT_DONE_LISTS: string;
export const USAGE: string;

export interface ReconcileOptions {
  queue: string[];
  label: RegExp | null;
  ignore: RegExp | null;
  doneLists: RegExp;
}

export type ParsedArgs = { help: true } | ({ help: false; board: string; json: boolean } & ReconcileOptions);

/** Lança um Error (uso errado) para flag desconhecida, valor ausente, regex inválida ou sem --queue/--label. */
export function parseArgs(argv: string[]): ParsedArgs;

export type TrelloClient = (path: string, params?: Record<string, string>) => Promise<any>;
export function makeTrelloClient(key: string, token: string, fetchImpl?: (url: string) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>): TrelloClient;
export function envValue(key: string, env: Record<string, string | undefined>, dotenvText?: string | null): string | null;

export interface LinkedBead {
  id: string;
  status: string;
  links: string[];
  soEmProsa: boolean;
  forasteiros: string[];
  parcial: boolean;
}
export function linkBeads(beads: { id: string; status: string; fields: Record<string, unknown> }[], texts?: Record<string, string>): LinkedBead[];

export interface TrelloCard {
  name: string;
  shortLink: string;
  idList: string;
  labels?: { name?: string }[];
}
export interface CardRow {
  card: string;
  url: string;
  lista: string;
  beads?: LinkedBead[];
}
export interface ReconcileResult {
  cardAdiantado: CardRow[];
  escopoParcial: CardRow[];
  cardAtrasado: CardRow[];
  semBead: CardRow[];
  soEmProsa: LinkedBead[];
  campoIncompleto: LinkedBead[];
  cobertura: { vivasComCard: number; vivas: number; concluidasComCard: number; concluidas: number };
}
export function classify(input: { cards: TrelloCard[]; listName: Map<string, string>; beads: LinkedBead[]; options: ReconcileOptions }): ReconcileResult;
/** Avisos (stderr) de um filtro que não pega nada: id de --queue fora do quadro, --label que nenhuma etiqueta casa. */
export function filterWarnings(options: ReconcileOptions, lists: { id: string; name: string }[], cards: TrelloCard[]): string[];
export function renderReport(result: ReconcileResult, ctx?: { filtro?: string; invalidos?: string[] }): string[];

export interface ReconcileIo {
  cwd: string;
  env?: Record<string, string | undefined>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** O cliente da API (injeção, para os testes). */
  trello?: TrelloClient;
  /** O transporte do cliente real (injeção, para os testes). */
  fetch?: (url: string) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;
}
/** 0 conferiu · 1 falhou (rede, API) · 2 uso errado, credencial ausente ou repo no modelo antigo. */
export function main(argv: string[], io: ReconcileIo): Promise<number>;
