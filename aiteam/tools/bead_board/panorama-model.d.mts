export interface PhaseGroup {
  key: string | null;
  name: string;
  subtitle?: string | undefined;
  total: number;
  completed: number;
  pending: number;
  in_progress: number;
  blocked: number;
  taskIds: string[];
}

export interface ReadinessPartition {
  ready: string[];
  blocked: string[];
}

export interface DependencyNode {
  id: string;
  status: string;
  blockers?: readonly string[] | undefined;
  [key: string]: unknown;
}

export interface DependencyEdge {
  from: string;
  to: string;
}

export interface MissingRef {
  to: string;
  blockerId: string;
}

export interface DependencyGraph {
  nodes: Map<string, DependencyNode>;
  edges: DependencyEdge[];
  missing: MissingRef[];
}

export interface DanglingBlocker {
  taskId: string;
  blockerId: string;
}

export interface CriticalPath {
  bottleneck: string | null;
  chain: string[];
  unblocks: number;
}

export declare function rollupPhases(doc: {
  phases?: readonly { key: string; name: string; subtitle?: string | undefined }[] | undefined;
  tasks?: readonly { id: string; status: string; phase?: string | number | undefined }[] | undefined;
}): PhaseGroup[];

export declare function partitionReadiness(doc: {
  tasks?: readonly { id: string; status: string; blockers?: readonly string[] | undefined }[] | undefined;
}): ReadinessPartition;

export declare function buildDependencyGraph(doc: {
  tasks?: readonly DependencyNode[] | undefined;
}): DependencyGraph;

export declare function danglingBlockers(doc: {
  tasks?: readonly { id: string; blockers?: readonly string[] | undefined }[] | undefined;
}): DanglingBlocker[];

export declare function computeCriticalPath(graph: DependencyGraph): CriticalPath;
