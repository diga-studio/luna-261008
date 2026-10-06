import { chainHashOfRecord, contentHash, genesisHash } from "./chain.js";
import { Store } from "./store.js";
import type {
  AuditRecord,
  ExportEntry,
  ExportPackage,
  SealCredential,
  TimeWindow,
} from "./types.js";

function assertValidTimestamp(timestampMs: number): void {
  if (!Number.isSafeInteger(timestampMs)) {
    throw new RangeError("timestampMs must be an integer number of milliseconds");
  }
}

function assertValidWindow(window: TimeWindow): void {
  assertValidTimestamp(window.startMs);
  assertValidTimestamp(window.endMs);
  if (window.startMs > window.endMs) {
    throw new RangeError("window startMs must be <= endMs");
  }
}

/** Append-only audit log with sealing and windowed export. */
export class AuditLog {
  private store: Store;

  constructor(dbPath: string) {
    this.store = new Store(dbPath);
  }

  /** Append a record; timestamps must be non-decreasing. Returns its seq. */
  append(timestampMs: number, prevState: string, nextState: string): number {
    assertValidTimestamp(timestampMs);
    const last = this.store.last();
    if (last && timestampMs < last.timestampMs) {
      throw new RangeError(
        `timestampMs ${timestampMs} is before the last record's timestamp ${last.timestampMs}`,
      );
    }
    const seq = (last?.seq ?? 0) + 1;
    this.store.append({ seq, timestampMs, prevState, nextState });
    return seq;
  }

  /** Credential committing to all records appended so far, in order. */
  seal(): SealCredential {
    const records = this.store.readAll();
    assertContiguous(records);
    return { count: records.length, head: foldChain(records).toString("hex") };
  }

  /**
   * Export records in `window` (half-open) within the prefix sealed by
   * `credential`. Throws if the database no longer matches the credential.
   */
  export(window: TimeWindow, credential: SealCredential): ExportPackage {
    assertValidWindow(window);
    const records = this.store.readAll();
    assertContiguous(records);
    if (records.length < credential.count) {
      throw new Error("database holds fewer records than the sealed prefix");
    }
    const prefix = records.slice(0, credential.count);
    const head = foldChain(prefix).toString("hex");
    if (head !== credential.head) {
      throw new Error("database does not match the seal credential (tampered?)");
    }
    const entries: ExportEntry[] = prefix.map((record) =>
      record.timestampMs >= window.startMs && record.timestampMs < window.endMs
        ? { kind: "record", record }
        : {
            kind: "sealed",
            seq: record.seq,
            timestampMs: record.timestampMs,
            contentHash: contentHash(record).toString("hex"),
          },
    );
    return { count: credential.count, entries };
  }

  close(): void {
    this.store.close();
  }
}

function assertContiguous(records: AuditRecord[]): void {
  for (let i = 0; i < records.length; i++) {
    if (records[i].seq !== i + 1) {
      throw new Error(`database corrupted: expected seq ${i + 1}, found ${records[i].seq}`);
    }
  }
}

function foldChain(records: AuditRecord[]): Buffer {
  let head = genesisHash();
  for (const record of records) {
    head = chainHashOfRecord(head, record);
  }
  return head;
}
