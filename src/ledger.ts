import type {
  BatchState,
  DeployResult,
  DestroyFn,
  InspectResult,
  Item,
  PrepareFn,
  ResourceHandle,
  Usage,
} from "./types";

type EntryState = "preparing" | "created" | "destroying" | "gone";

interface Entry {
  item: Item;
  state: EntryState;
  handle: ResourceHandle;
}

type Outcome = "success" | "failed" | "cancelled" | null;

interface Batch {
  key: string;
  fingerprint: string;
  entries: Entry[];
  state: BatchState;
  /** Decided at most once; later events never rewrite it. */
  outcome: Outcome;
  /** In-flight prepare/destroy calls. */
  pending: number;
  resultPromise: Promise<DeployResult>;
  resolveResult: (r: DeployResult) => void;
  resultSettled: boolean;
  terminalPromise: Promise<void>;
  resolveTerminal: () => void;
  terminal: boolean;
}

function fingerprintOf(items: Item[]): string {
  return JSON.stringify(
    items.map((it) => [it.node, it.usage.cpuMillicores, it.usage.memoryMiB]),
  );
}

export class ResourceLedger {
  private readonly capacities = new Map<string, Usage>();
  private readonly prepareFn: PrepareFn;
  private readonly destroyFn: DestroyFn;
  private readonly batches = new Map<string, Batch>();
  /** node -> usage currently reserved (entries not yet fully released). */
  private readonly used = new Map<string, Usage>();

  constructor(
    capacities: Record<string, { cpuMillicores: number; memoryMiB: number }>,
    prepare: PrepareFn,
    destroy: DestroyFn,
  ) {
    for (const [node, cap] of Object.entries(capacities)) {
      this.capacities.set(node, {
        cpuMillicores: cap.cpuMillicores,
        memoryMiB: cap.memoryMiB,
      });
      this.used.set(node, { cpuMillicores: 0, memoryMiB: 0 });
    }
    this.prepareFn = prepare;
    this.destroyFn = destroy;
  }

  deploy(key: string, items: Item[]): Promise<DeployResult> {
    const fingerprint = fingerprintOf(items);
    const existing = this.batches.get(key);
    if (existing) {
      if (existing.fingerprint === fingerprint) {
        return existing.resultPromise;
      }
      return Promise.resolve({ ok: false, reason: "conflict" });
    }

    let resolveResult!: (r: DeployResult) => void;
    const resultPromise = new Promise<DeployResult>((res) => {
      resolveResult = res;
    });
    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((res) => {
      resolveTerminal = res;
    });

    const batch: Batch = {
      key,
      fingerprint,
      entries: [],
      state: "creating",
      outcome: null,
      pending: 0,
      resultPromise,
      resolveResult,
      resultSettled: false,
      terminalPromise,
      resolveTerminal,
      terminal: false,
    };
    this.batches.set(key, batch);

    if (!this.hasCapacity(items)) {
      batch.entries = [];
      batch.state = "failed";
      this.finishTerminal(batch, { ok: false, reason: "insufficient-capacity" });
      return resultPromise;
    }

    batch.entries = items.map((item) => {
      this.addUsage(item.node, item.usage, +1);
      return { item, state: "preparing" as EntryState, handle: undefined };
    });

    for (const entry of batch.entries) {
      batch.pending++;
      this.prepareFn(entry.item).then(
        (handle) => this.onPrepareSuccess(batch, entry, handle),
        () => this.onPrepareFailure(batch, entry),
      );
    }
    return resultPromise;
  }

  async cancel(key: string): Promise<void> {
    const batch = this.batches.get(key);
    if (!batch) return;
    if (!batch.terminal) {
      if (batch.outcome === null) {
        batch.outcome = "cancelled";
      }
      if (batch.state === "running") {
        batch.state = "destroying";
      }
      this.reconcile(batch);
      if (!batch.terminal) {
        await batch.terminalPromise;
      }
    }
  }

  inspect(): InspectResult {
    const nodes = [...this.capacities.keys()].map((node) => {
      const cap = this.capacities.get(node)!;
      const used = this.used.get(node)!;
      return {
        node,
        capacity: { ...cap },
        used: { ...used },
      };
    });
    const batches = [...this.batches.values()].map((b) => ({
      key: b.key,
      state: b.state,
    }));
    return { nodes, batches };
  }

  private hasCapacity(items: Item[]): boolean {
    const delta = new Map<string, Usage>();
    for (const it of items) {
      const cap = this.capacities.get(it.node);
      if (!cap) return false;
      const d = delta.get(it.node) ?? { cpuMillicores: 0, memoryMiB: 0 };
      d.cpuMillicores += it.usage.cpuMillicores;
      d.memoryMiB += it.usage.memoryMiB;
      delta.set(it.node, d);
    }
    for (const [node, d] of delta) {
      const cap = this.capacities.get(node)!;
      const used = this.used.get(node)!;
      if (
        used.cpuMillicores + d.cpuMillicores > cap.cpuMillicores ||
        used.memoryMiB + d.memoryMiB > cap.memoryMiB
      ) {
        return false;
      }
    }
    return true;
  }

  private addUsage(node: string, usage: Usage, sign: 1 | -1): void {
    const used = this.used.get(node)!;
    used.cpuMillicores += sign * usage.cpuMillicores;
    used.memoryMiB += sign * usage.memoryMiB;
  }

  private onPrepareSuccess(batch: Batch, entry: Entry, handle: ResourceHandle): void {
    batch.pending--;
    entry.handle = handle;
    entry.state = "created";
    this.reconcile(batch);
  }

  private onPrepareFailure(batch: Batch, entry: Entry): void {
    batch.pending--;
    entry.state = "gone";
    this.addUsage(entry.item.node, entry.item.usage, -1);
    if (batch.outcome === null) {
      batch.outcome = "failed";
    }
    this.reconcile(batch);
  }

  private onDestroyDone(batch: Batch, entry: Entry): void {
    batch.pending--;
    entry.state = "gone";
    this.addUsage(entry.item.node, entry.item.usage, -1);
    this.reconcile(batch);
  }

  private reconcile(batch: Batch): void {
    if (batch.terminal) return;

    if (batch.state === "creating") {
      if (batch.outcome === "failed") {
        batch.state = "compensating";
      } else if (batch.outcome === "cancelled") {
        batch.state = "destroying";
      } else if (batch.entries.every((e) => e.state === "created")) {
        batch.state = "running";
        batch.outcome = "success";
        this.settleResult(batch, { ok: true });
        return;
      } else {
        return;
      }
    }

    if (batch.state === "compensating" || batch.state === "destroying") {
      for (const entry of batch.entries) {
        if (entry.state === "created") {
          entry.state = "destroying";
          batch.pending++;
          this.destroyFn(entry.handle).then(() => this.onDestroyDone(batch, entry));
        }
      }
      if (batch.pending === 0 && batch.entries.every((e) => e.state === "gone")) {
        if (batch.state === "compensating") {
          batch.state = "failed";
          this.finishTerminal(batch, { ok: false, reason: "prepare-failed" });
        } else {
          batch.state = "cancelled";
          if (batch.outcome === "cancelled") {
            this.finishTerminal(batch, { ok: false, reason: "cancelled" });
          } else {
            // Cancel after success: deploy result already settled as ok.
            this.finishTerminal(batch, { ok: true });
          }
        }
      }
    }
  }

  private settleResult(batch: Batch, result: DeployResult): void {
    if (batch.resultSettled) return;
    batch.resultSettled = true;
    batch.resolveResult(result);
  }

  private finishTerminal(batch: Batch, result: DeployResult): void {
    batch.terminal = true;
    this.settleResult(batch, result);
    batch.resolveTerminal();
  }
}
