import { DatabaseSync } from "node:sqlite";
import type { AuditRecord } from "./types.js";

interface Row {
  seq: number;
  ts: number;
  prev: string;
  next: string;
}

/** SQLite-backed append-only persistence for audit records. */
export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS records (
        seq  INTEGER PRIMARY KEY,
        ts   INTEGER NOT NULL,
        prev TEXT    NOT NULL,
        next TEXT    NOT NULL
      )
    `);
  }

  append(record: AuditRecord): void {
    this.db
      .prepare("INSERT INTO records (seq, ts, prev, next) VALUES (?, ?, ?, ?)")
      .run(record.seq, record.timestampMs, record.prevState, record.nextState);
  }

  /** All records in seq order. */
  readAll(): AuditRecord[] {
    const rows = this.db
      .prepare("SELECT seq, ts, prev, next FROM records ORDER BY seq ASC")
      .all() as unknown as Row[];
    return rows.map((r) => ({
      seq: r.seq,
      timestampMs: r.ts,
      prevState: r.prev,
      nextState: r.next,
    }));
  }

  /** Seq and timestamp of the last record, or null when empty. */
  last(): { seq: number; timestampMs: number } | null {
    const row = this.db
      .prepare("SELECT seq, ts FROM records ORDER BY seq DESC LIMIT 1")
      .get() as unknown as { seq: number; ts: number } | undefined;
    return row ? { seq: row.seq, timestampMs: row.ts } : null;
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM records").get() as unknown as {
      n: number;
    };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}
