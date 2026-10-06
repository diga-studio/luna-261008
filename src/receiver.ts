import { TargetStore } from "./targetStore.js";
import type { Batch, BatchAck, Receiver } from "./types.js";

/**
 * Real local receiver backed by a TargetStore. Applies the batch with per-batch
 * dedup and returns an ack only when the whole batch is applied. Repeated
 * submissions of a completed batch return the existing ack without re-applying.
 */
export class LocalReceiver implements Receiver {
  private readonly target: TargetStore;

  constructor(target: TargetStore) {
    this.target = target;
  }

  submitBatch(batch: Batch): BatchAck | null {
    // Repeated delivery of a completed batch: return the existing ack, apply nothing.
    if (!this.target.isBatchComplete(batch.batchId, batch.records.length)) {
      this.target.applyBatch(batch.batchId, batch.records);
    }
    return { batchId: batch.batchId, appliedCount: batch.records.length };
  }
}
