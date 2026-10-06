/**
 * The audit log module: append, seal, and time-window export.
 */
import { merkleTreeHash, type RecordPayload } from "./hash.js";
import { inclusionProof } from "./merkle.js";
import type { SealCredential } from "./seal.js";
import type { BoundaryRecord, ExportPackage, HitRecord, TimeWindow } from "./export.js";
import { Store } from "./store.js";

function assertWindow(window: TimeWindow): void {
  if (
    !Number.isSafeInteger(window.startMs) ||
    !Number.isSafeInteger(window.endMs) ||
    window.startMs > window.endMs
  ) {
    throw new RangeError("window must satisfy startMs <= endMs as safe integers");
  }
}

export class AuditLog {
  private readonly store: Store;

  /** Open (or create) the audit database at `dbPath`. */
  constructor(dbPath: string) {
    this.store = new Store(dbPath);
  }

  /** Number of records appended so far. */
  count(): number {
    return this.store.count();
  }

  /**
   * Append a record. Timestamps must be non-decreasing; the module
   * assigns the next consecutive sequence number (starting at 1).
   */
  append(timestampMs: number, before: string, after: string): RecordPayload {
    if (!Number.isSafeInteger(timestampMs)) {
      throw new RangeError("timestampMs must be a safe integer");
    }
    if (typeof before !== "string" || typeof after !== "string") {
      throw new TypeError("before and after must be strings");
    }
    const last = this.store.lastTimestamp();
    if (last !== null && timestampMs < last) {
      throw new RangeError(
        `timestampMs ${timestampMs} is before the last appended timestamp ${last}`,
      );
    }
    const seq = this.store.append({ timestampMs, before, after });
    return { seq, timestampMs, before, after };
  }

  /**
   * Seal the current record sequence and return a credential committing
   * to all records and their order, including the total count. The
   * caller must keep this credential safe outside the module.
   */
  seal(): SealCredential {
    const leaves = this.store.allLeafHashes();
    return {
      count: leaves.length,
      root: merkleTreeHash(leaves).toString("hex"),
    };
  }

  /**
   * Export the records of the sealed prefix (first `credential.count`
   * records) whose timestamps fall in `window` = [startMs, endMs),
   * together with a proof covering content, order, and window bounds.
   */
  export(window: TimeWindow, credential: SealCredential): ExportPackage {
    assertWindow(window);
    const n = credential.count;
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new RangeError("credential count must be a non-negative integer");
    }
    if (n > this.store.count()) {
      throw new RangeError("credential count exceeds the records in the database");
    }
    // Confirm the sealed prefix still matches the caller's credential.
    const leaves: Buffer[] = [];
    for (let seq = 1; seq <= n; seq += 1) {
      leaves.push(this.store.leafHashAt(seq));
    }
    if (merkleTreeHash(leaves).toString("hex") !== credential.root.toLowerCase()) {
      throw new Error("database does not match the seal credential");
    }

    // Binary search the hit range [first, last] within the sealed prefix.
    // Timestamps are non-decreasing, so hits form a contiguous range.
    const timestampAt = (seq: number): number => this.store.recordAt(seq).timestampMs;
    let first = 1;
    let last = n;
    // first = smallest seq with ts >= window.startMs (or n + 1).
    let lo = 1;
    let hi = n + 1;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (timestampAt(mid) < window.startMs) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    first = lo;
    // last = largest seq with ts < window.endMs (or 0).
    lo = 0;
    hi = n;
    while (lo < hi) {
      const mid = lo + Math.ceil((hi - lo) / 2);
      if (timestampAt(mid) < window.endMs) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    last = lo;

    const leafAt = (seq: number): Buffer => this.store.leafHashAt(seq);
    const hits: HitRecord[] = [];
    if (first <= last) {
      for (const record of this.store.recordsInRange(first, last)) {
        hits.push({ ...record, proof: inclusionProof(record.seq, n, leafAt) });
      }
    }
    const boundary = (seq: number): BoundaryRecord => ({
      seq,
      timestampMs: timestampAt(seq),
      leafHash: leafAt(seq).toString("hex"),
      proof: inclusionProof(seq, n, leafAt),
    });
    return {
      count: n,
      window: { startMs: window.startMs, endMs: window.endMs },
      hits,
      left: first > 1 ? boundary(first - 1) : null,
      right: last < n ? boundary(last + 1) : null,
    };
  }

  close(): void {
    this.store.close();
  }
}
