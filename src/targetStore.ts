import { readJsonFile, writeJsonFile } from "./jsonFile.js";
import type { SourceRecord } from "./types.js";

interface BatchLedger {
  appliedSeqs: number[];
}

interface TargetFileShape {
  objects: Record<string, number>;
  batches: Record<string, BatchLedger>;
}

/** Persistent target state: per-object cumulative values and per-batch dedup ledger. */
export class TargetStore {
  private readonly filePath: string;
  private objects: Map<string, number>;
  private batches: Map<string, Set<number>>;

  constructor(filePath: string) {
    this.filePath = filePath;
    const shape = readJsonFile<TargetFileShape>(filePath, () => ({ objects: {}, batches: {} }));
    this.objects = new Map(Object.entries(shape.objects));
    this.batches = new Map(
      Object.entries(shape.batches).map(([id, ledger]) => [id, new Set(ledger.appliedSeqs)]),
    );
  }

  /** Cumulative value of one object (0 when unseen). */
  getValue(objectId: string): number {
    return this.objects.get(objectId) ?? 0;
  }

  /** All cumulative values. */
  getAllValues(): Map<string, number> {
    return new Map(this.objects);
  }

  /** Whether every record of the batch has been applied. */
  isBatchComplete(batchId: string, expectedCount: number): boolean {
    const ledger = this.batches.get(batchId);
    const appliedCount = ledger === undefined ? 0 : ledger.size;
    return appliedCount >= expectedCount;
  }

  /**
   * Apply the not-yet-applied records of a batch, persisting after each record.
   * Already-applied records (same batchId + seq) are skipped. Returns the number
   * of newly applied records. Throws may leave a persisted applied prefix.
   */
  applyBatch(batchId: string, records: SourceRecord[]): number {
    let ledger = this.batches.get(batchId);
    if (ledger === undefined) {
      ledger = new Set<number>();
      this.batches.set(batchId, ledger);
    }
    let newlyApplied = 0;
    for (const record of records) {
      if (ledger.has(record.seq)) {
        continue;
      }
      this.objects.set(record.objectId, (this.objects.get(record.objectId) ?? 0) + record.delta);
      ledger.add(record.seq);
      newlyApplied += 1;
      // Persist after every record so a crash leaves a consistent applied prefix.
      this.persist();
    }
    return newlyApplied;
  }

  private persist(): void {
    const objects: Record<string, number> = {};
    for (const [id, value] of this.objects) {
      objects[id] = value;
    }
    const batches: Record<string, BatchLedger> = {};
    for (const [id, ledger] of this.batches) {
      batches[id] = { appliedSeqs: [...ledger].sort((a, b) => a - b) };
    }
    const shape: TargetFileShape = { objects, batches };
    writeJsonFile(this.filePath, shape);
  }
}
