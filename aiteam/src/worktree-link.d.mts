// Tipos de worktree-link.mjs, na convenção src/*.d.mts (ver tier-core.d.mts).

export const SHARED_MODULES: "aiteam/node_modules";

export interface Checkout {
  path: string;
  bare: boolean;
}

export function checkoutRoot(cwd: string): string | null;
export function listCheckouts(cwd: string): Checkout[];
export function mainCheckout(cwd: string): string | null;

export type LinkResult =
  | { status: "linked"; link: string; source: string; message: string }
  | { status: "skipped"; reason: string }
  | { status: "error"; message: string };
export function linkSharedModules(cwd?: string): LinkResult;

/** Removes a link without following it; tries rmdir/unlink in the platform's order and never throws. */
export function removeLink(
  link: string,
  ops?: Pick<typeof import("node:fs"), "rmdirSync" | "unlinkSync">,
  platform?: NodeJS.Platform,
): { ok: true } | { ok: false; message: string };

export type UnlinkResult =
  | { status: "unlinked"; link: string; target: string }
  | { status: "absent" }
  | { status: "not-a-link"; link: string }
  | { status: "main-checkout"; link: string }
  | { status: "error"; link: string; message: string };
export function unlinkSharedModules(dir?: string): UnlinkResult;

export type RemoveResult = { status: "removed"; path: string } | { status: "refused"; message: string };
export function removeWorktree(target: string, opts?: { force?: boolean }): RemoveResult;
