export const ZERO_SHA: string;

export interface RefUpdate {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

export interface ClassifyOpts {
  isAncestor: (ancestorSha: string, descendantSha: string) => boolean;
  protectedBranches?: string[];
}

export function parseRefUpdates(stdinText: string | undefined): RefUpdate[];
export function isProtectedRef(remoteRef: string, protectedBranches?: string[]): boolean;
export function classifyRefUpdate(update: RefUpdate, opts: ClassifyOpts): 1 | 3;
export function classifyPush(
  stdinText: string | undefined,
  opts: ClassifyOpts
): Array<{ update: RefUpdate; tier: 1 | 3 }>;
