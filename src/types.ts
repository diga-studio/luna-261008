/** CPU in millicores, memory in MiB. All integers. */
export interface Usage {
  cpuMillicores: number;
  memoryMiB: number;
}

export interface Item {
  node: string;
  usage: Usage;
}

/** Opaque handle returned by a successful prepare(). */
export type ResourceHandle = unknown;

export type PrepareFn = (item: Item) => Promise<ResourceHandle>;
export type DestroyFn = (handle: ResourceHandle) => Promise<void>;

export interface NodeOccupancy {
  node: string;
  capacity: Usage;
  used: Usage;
}

export type BatchState =
  | "creating"
  | "running"
  | "compensating"
  | "destroying"
  | "failed"
  | "cancelled";

export interface BatchInfo {
  key: string;
  state: BatchState;
}

export interface InspectResult {
  nodes: NodeOccupancy[];
  batches: BatchInfo[];
}

export type DeployFailureReason =
  | "insufficient-capacity"
  | "prepare-failed"
  | "cancelled"
  | "conflict";

export type DeployResult = { ok: true } | { ok: false; reason: DeployFailureReason };
