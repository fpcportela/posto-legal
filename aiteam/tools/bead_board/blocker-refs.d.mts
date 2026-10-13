export interface DanglingBlocker {
  taskId: string;
  blockerId: string;
}
export declare function findDanglingBlockers(
  tasks: ReadonlyArray<{ id: string; blockers?: readonly string[] | undefined }>
): DanglingBlocker[];
