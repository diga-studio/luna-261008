/** A single source record. `seq` is strictly increasing and immutable once appended. */
export interface SourceRecord {
  seq: number;
  objectId: string;
  delta: number;
}

/** A batch of source records fixed at round start. Identity, members and order never change. */
export interface Batch {
  batchId: string;
  round: number;
  index: number;
  records: SourceRecord[];
}

/** Acknowledgement returned by the receiver once a whole batch is fully applied. */
export interface BatchAck {
  batchId: string;
  appliedCount: number;
}

/** Receiver abstraction: the engine submits a batch; ack means the whole batch is applied. */
export interface Receiver {
  submitBatch(batch: Batch): BatchAck | null;
}

export type AdvanceStatus =
  | "completed" // round finished (all batches confirmed) or nothing to do
  | "incomplete"; // a batch remained unconfirmed after the max attempts

export interface AdvanceResult {
  status: AdvanceStatus;
  /** High watermark: seq up to which the source prefix is fully confirmed. */
  watermark: number;
  /** Number of batches confirmed during this call. */
  confirmedBatches: number;
  /** Batch currently awaiting confirmation, if any. */
  pendingBatchId: string | null;
}

export interface SyncProgress {
  watermark: number;
  round: number;
  roundActive: boolean;
  /** Watermark at the start of the active round; batches are seq windows above it. */
  roundBase: number;
  roundUpperBound: number;
  totalBatches: number;
  nextBatchIndex: number;
  pendingBatchId: string | null;
}
