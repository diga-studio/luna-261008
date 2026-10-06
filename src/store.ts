/**
 * SQLite persistence for the append-only record table.
 */
import { DatabaseSync } from "node:sqlite";
import { leafHash, type RecordPayload } from "./hash.js";

interface RecordRow {
  seq: number;
  ts: number;
  before: string;
  after: string;
}

function toPayload(row: RecordRow): RecordPayload {
  return {
    seq: row.seq,
    timestampMs: row.ts,
    before: row.before,
    after: row.after,
  };
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS records (
        seq INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        before TEXT NOT NULL,
        after TEXT NOT NULL
      )
    `);
  }

  /** Number of records stored. */
  count(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM records")
      .get() as { n: number };
    return row.n;
  }

  /** Timestamp of the last record, or null when empty. */
  lastTimestamp(): number | null {
    const row = this.db
      .prepare("SELECT ts FROM records ORDER BY seq DESC LIMIT 1")
      .get() as { ts: number } | undefined;
    return row === undefined ? null : row.ts;
  }

  /** Append a record; returns its assigned sequence number. */
  append(record: Omit<RecordPayload, "seq">): number {
    const seq = this.count() + 1;
    this.db
      .prepare("INSERT INTO records (seq, ts, before, after) VALUES (?, ?, ?, ?)")
      .run(seq, record.timestampMs, record.before, record.after);
    return seq;
  }

  /** Fetch the full record at a 1-based sequence number. */
  recordAt(seq: number): RecordPayload {
    const row = this.db
      .prepare("SELECT seq, ts, before, after FROM records WHERE seq = ?")
      .get(seq) as RecordRow | undefined;
    if (row === undefined) {
      throw new RangeError(`no record at seq ${seq}`);
    }
    return toPayload(row);
  }

  /** Fetch records with seq in [fromSeq, toSeq] inclusive, ordered by seq. */
  recordsInRange(fromSeq: number, toSeq: number): RecordPayload[] {
    if (fromSeq > toSeq) {
      return [];
    }
    const rows = this.db
      .prepare(
        "SELECT seq, ts, before, after FROM records WHERE seq BETWEEN ? AND ? ORDER BY seq",
      )
      .all(fromSeq, toSeq) as unknown as RecordRow[];
    return rows.map(toPayload);
  }

  /** Leaf hash of the record at a 1-based position. */
  leafHashAt(seq: number): Buffer {
    return leafHash(this.recordAt(seq));
  }

  /** All leaf hashes in sequence order. */
  allLeafHashes(): Buffer[] {
    const rows = this.db
      .prepare("SELECT seq, ts, before, after FROM records ORDER BY seq")
      .all() as unknown as RecordRow[];
    return rows.map((row) => leafHash(toPayload(row)));
  }

  close(): void {
    this.db.close();
  }
}
