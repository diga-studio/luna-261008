export interface ResourceAmount {
  /** integer millicores */
  cpu: number;
  /** integer MiB */
  memory: number;
}

export interface Item extends ResourceAmount {
  node: string;
}

export type Handle = unknown;

export type PrepareFn = (item: Item) => Promise<Handle>;
export type DestroyFn = (handle: Handle) => Promise<void>;

export interface LedgerDeps {
  prepare: PrepareFn;
  destroy: DestroyFn;
}

export type DeployFailureReason =
  | "capacity-exceeded"
  | "prepare-failed"
  | "cancelled";

export type DeployResult =
  | { ok: true }
  | { ok: false; reason: DeployFailureReason };

export type BatchState =
  | "creating"
  | "running"
  | "compensating"
  | "failed"
  | "cancelled";

export interface NodeInspection {
  capacity: ResourceAmount;
  used: ResourceAmount;
}

export interface BatchInspection {
  state: BatchState;
  items: readonly Item[];
}

export interface Inspection {
  nodes: Record<string, NodeInspection>;
  batches: Record<string, BatchInspection>;
}

export class ResourceLedger {
  private readonly used = new Map<string, ResourceAmount>();
  private readonly batches = new Map<string, BatchRecord>();

  constructor(
    private readonly capacities: Record<string, ResourceAmount>,
    private readonly deps: LedgerDeps,
  ) {
    for (const node of Object.keys(capacities)) {
      this.used.set(node, { cpu: 0, memory: 0 });
    }
  }

  deploy(key: string, items: readonly Item[]): Promise<DeployResult> {
    const fingerprint = fingerprintOf(items);
    const existing = this.batches.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new Error(`conflicting deploy for key "${key}"`);
      }
      return existing.resultPromise;
    }

    const ownedItems = items.map((item) => ({ ...item }));
    for (const item of ownedItems) {
      if (!this.used.has(item.node)) {
        throw new Error(`unknown node: "${item.node}"`);
      }
    }

    const record = createRecord(key, fingerprint, ownedItems);
    this.batches.set(key, record);

    if (!this.hasCapacity(ownedItems)) {
      record.outcome = "failed";
      record.state = "failed";
      record.settleResult({ ok: false, reason: "capacity-exceeded" });
      record.finishDone();
      return record.resultPromise;
    }

    for (const entry of record.entries) {
      this.reserve(entry);
    }
    if (record.entries.length === 0) {
      record.outcome = "success";
      record.state = "running";
      record.settleResult({ ok: true });
      record.finishDone();
      return record.resultPromise;
    }
    for (const entry of record.entries) {
      this.startPrepare(record, entry);
    }
    return record.resultPromise;
  }

  cancel(key: string): Promise<void> {
    const record = this.batches.get(key);
    if (!record) {
      return Promise.resolve();
    }
    if (record.outcome === null) {
      record.outcome = "cancelled";
      record.state = "compensating";
      this.destroyCreated(record);
    } else if (record.outcome === "success" && record.state === "running") {
      record.state = "compensating";
      this.destroyCreated(record);
    }
    this.checkCompletion(record);
    return record.donePromise;
  }

  inspect(): Inspection {
    const nodes: Record<string, NodeInspection> = {};
    for (const [node, capacity] of Object.entries(this.capacities)) {
      const used = this.used.get(node) ?? { cpu: 0, memory: 0 };
      nodes[node] = {
        capacity: { ...capacity },
        used: { ...used },
      };
    }
    const batches: Record<string, BatchInspection> = {};
    for (const [key, record] of this.batches) {
      batches[key] = {
        state: record.state,
        items: record.items.map((item) => ({ ...item })),
      };
    }
    return { nodes, batches };
  }

  private hasCapacity(items: readonly Item[]): boolean {
    const demand = new Map<string, ResourceAmount>();
    for (const item of items) {
      const acc = demand.get(item.node) ?? { cpu: 0, memory: 0 };
      acc.cpu += item.cpu;
      acc.memory += item.memory;
      demand.set(item.node, acc);
    }
    for (const [node, need] of demand) {
      const used = this.used.get(node)!;
      const capacity = this.capacities[node];
      if (used.cpu + need.cpu > capacity.cpu) return false;
      if (used.memory + need.memory > capacity.memory) return false;
    }
    return true;
  }

  private reserve(entry: EntryRecord): void {
    const used = this.used.get(entry.item.node)!;
    used.cpu += entry.item.cpu;
    used.memory += entry.item.memory;
    entry.reserved = true;
  }

  private release(entry: EntryRecord): void {
    if (!entry.reserved) return;
    const used = this.used.get(entry.item.node)!;
    used.cpu -= entry.item.cpu;
    used.memory -= entry.item.memory;
    entry.reserved = false;
  }

  private startPrepare(record: BatchRecord, entry: EntryRecord): void {
    let prepared: Promise<Handle>;
    try {
      prepared = Promise.resolve(this.deps.prepare({ ...entry.item }));
    } catch {
      prepared = Promise.reject(new Error("prepare threw"));
    }
    prepared.then(
      (handle) => this.onPrepareSuccess(record, entry, handle),
      () => this.onPrepareFailure(record, entry),
    );
  }

  private onPrepareSuccess(
    record: BatchRecord,
    entry: EntryRecord,
    handle: Handle,
  ): void {
    entry.prepared = true;
    entry.handle = handle;
    if (record.outcome === null) {
      if (record.entries.every((e) => e.prepared)) {
        record.outcome = "success";
        record.state = "running";
        record.settleResult({ ok: true });
      }
    } else {
      // Late success after the batch was already failed or cancelled:
      // the resource must be destroyed so the batch cannot revive.
      this.startDestroy(record, entry);
    }
    this.checkCompletion(record);
  }

  private onPrepareFailure(record: BatchRecord, entry: EntryRecord): void {
    entry.failed = true;
    this.release(entry);
    if (record.outcome === null) {
      record.outcome = "failed";
      record.state = "compensating";
      this.destroyCreated(record);
    }
    this.checkCompletion(record);
  }

  private destroyCreated(record: BatchRecord): void {
    for (const entry of record.entries) {
      if (entry.prepared && !entry.failed && !entry.destroyStarted) {
        this.startDestroy(record, entry);
      }
    }
  }

  private startDestroy(record: BatchRecord, entry: EntryRecord): void {
    entry.destroyStarted = true;
    // destroy is guaranteed to succeed eventually.
    Promise.resolve(this.deps.destroy(entry.handle)).then(() => {
      entry.destroyed = true;
      this.release(entry);
      this.checkCompletion(record);
    });
  }

  private checkCompletion(record: BatchRecord): void {
    if (record.outcome === null || record.state === "running") return;
    const settled = record.entries.every((e) => e.failed || e.destroyed);
    if (!settled) return;
    record.state = record.outcome === "failed" ? "failed" : "cancelled";
    if (record.outcome === "failed") {
      record.settleResult({ ok: false, reason: "prepare-failed" });
    } else if (record.outcome === "cancelled") {
      record.settleResult({ ok: false, reason: "cancelled" });
    }
    record.finishDone();
  }
}

interface EntryRecord {
  item: Item;
  reserved: boolean;
  prepared: boolean;
  failed: boolean;
  handle?: Handle;
  destroyStarted: boolean;
  destroyed: boolean;
}

interface BatchRecord {
  key: string;
  fingerprint: string;
  items: Item[];
  entries: EntryRecord[];
  state: BatchState;
  outcome: "success" | "failed" | "cancelled" | null;
  resultPromise: Promise<DeployResult>;
  settleResult: (result: DeployResult) => void;
  donePromise: Promise<void>;
  finishDone: () => void;
}

function fingerprintOf(items: readonly Item[]): string {
  return JSON.stringify(items.map((i) => [i.node, i.cpu, i.memory]));
}

function createRecord(
  key: string,
  fingerprint: string,
  items: Item[],
): BatchRecord {
  let settleResult!: (result: DeployResult) => void;
  let finishDone!: () => void;
  const resultPromise = new Promise<DeployResult>((resolve) => {
    let settled = false;
    settleResult = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
  });
  const donePromise = new Promise<void>((resolve) => {
    finishDone = resolve;
  });
  return {
    key,
    fingerprint,
    items,
    entries: items.map((item) => ({
      item,
      reserved: false,
      prepared: false,
      failed: false,
      destroyStarted: false,
      destroyed: false,
    })),
    state: "creating",
    outcome: null,
    resultPromise,
    settleResult,
    donePromise,
    finishDone,
  };
}
