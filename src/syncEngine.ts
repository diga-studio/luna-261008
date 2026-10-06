import { ProgressStore } from "./progressStore.js";
import { SourceStore } from "./sourceStore.js";
import type { AdvanceResult, Batch, BatchAck, Receiver, SyncProgress } from "./types.js";

export const BATCH_SIZE = 1000;
export const MAX_ATTEMPTS_PER_ADVANCE = 4;

/** Orchestrates round-based incremental sync from source to receiver. */
export class SyncEngine {
  private readonly source: SourceStore;
  private readonly progressStore: ProgressStore;
  private readonly receiver: Receiver;

  constructor(source: SourceStore, progress: ProgressStore, receiver: Receiver) {
    this.source = source;
    this.progressStore = progress;
    this.receiver = receiver;
  }

  /**
   * Advance synchronization. Starts a new round when none is active and new
   * records exist; otherwise continues the pending round. Submits the pending
   * batch at most MAX_ATTEMPTS_PER_ADVANCE times per call.
   */
  advance(): AdvanceResult {
    let progress = this.progressStore.load();
    let confirmedBatches = 0;

    for (;;) {
      if (!progress.roundActive) {
        const upper = this.source.maxSeq();
        if (upper <= progress.watermark) {
          return {
            status: "completed",
            watermark: progress.watermark,
            confirmedBatches,
            pendingBatchId: null,
          };
        }
        // Start a new round: fix the source upper bound now. Records appended
        // later are left for the next round.
        progress = {
          ...progress,
          round: progress.round + 1,
          roundActive: true,
          roundBase: progress.watermark,
          roundUpperBound: upper,
          totalBatches: Math.ceil((upper - progress.watermark) / BATCH_SIZE),
          nextBatchIndex: 0,
          pendingBatchId: null,
        };
        this.progressStore.save(progress);
      }

      while (progress.nextBatchIndex < progress.totalBatches) {
        const batch = this.buildBatch(progress, progress.nextBatchIndex);
        const ack = this.submitWithRetries(batch);
        if (ack === null) {
          // Keep the pending batch identity; a later advance() or a restart
          // resumes the same round and the same batch.
          progress = { ...progress, pendingBatchId: batch.batchId };
          this.progressStore.save(progress);
          return {
            status: "incomplete",
            watermark: progress.watermark,
            confirmedBatches,
            pendingBatchId: batch.batchId,
          };
        }
        const last = batch.records[batch.records.length - 1];
        progress = {
          ...progress,
          watermark: last === undefined ? progress.watermark : last.seq,
          nextBatchIndex: progress.nextBatchIndex + 1,
          pendingBatchId: null,
        };
        this.progressStore.save(progress);
        confirmedBatches += 1;
      }

      // Round fully confirmed; close it and look for newly appended records.
      progress = { ...progress, roundActive: false, pendingBatchId: null };
      this.progressStore.save(progress);
    }
  }

  /** Current sync progress snapshot. */
  getProgress(): SyncProgress {
    return this.progressStore.load();
  }

  /** Batch identity, members and order are fixed once the round has started. */
  private buildBatch(progress: SyncProgress, index: number): Batch {
    const from = progress.roundBase + index * BATCH_SIZE;
    const to = Math.min(from + BATCH_SIZE, progress.roundUpperBound);
    return {
      batchId: "r" + String(progress.round) + "-b" + String(index),
      round: progress.round,
      index,
      records: this.source.range(from, to),
    };
  }

  /** Submit one batch at most MAX_ATTEMPTS_PER_ADVANCE times; null means unconfirmed. */
  private submitWithRetries(batch: Batch): BatchAck | null {
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_ADVANCE; attempt += 1) {
      try {
        const ack = this.receiver.submitBatch(batch);
        if (ack !== null) {
          return ack;
        }
      } catch {
        // Receiver interrupted mid-batch: the applied prefix is already
        // persisted by the target; retrying resumes from it.
      }
    }
    return null;
  }
}
