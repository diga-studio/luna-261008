import { DatabaseSync } from "node:sqlite";

/**
 * SQLite layer: online records, the never-reused id counter, and the
 * committed-segment manifest. Bodies of archived records are deleted from
 * the online table; the manifest only records segment file names.
 *
 * Durability: WAL + synchronous=FULL; every append commits its own
 * transaction, so a returned append survives any later process exit.
 */
export class Database {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS online_records (
        id INTEGER PRIMARY KEY,
        event_time_ms INTEGER NOT NULL,
        body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_online_event_time ON online_records(event_time_ms);
      CREATE TABLE IF NOT EXISTS segments (
        seq INTEGER PRIMARY KEY,
        file TEXT NOT NULL UNIQUE
      );
    `);
    this.db
      .prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('next_id', 1)")
      .run();
  }

  /** Append a record body; returns the assigned strictly-increasing id. */
  append(eventTimeMs: number, bodyJson: string): number {
    // Counter bump and insert commit in one transaction: a returned id is
    // durable and never reused, even if every online row is later archived.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT value FROM meta WHERE key = 'next_id'")
        .get() as { value: number };
      const id = Number(row.value);
      this.db
        .prepare("INSERT INTO online_records(id, event_time_ms, body) VALUES (?, ?, ?)")
        .run(id, eventTimeMs, bodyJson);
      this.db
        .prepare("UPDATE meta SET value = ? WHERE key = 'next_id'")
        .run(id + 1);
      this.db.exec("COMMIT");
      return id;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** All online records with eventTimeMs strictly before cutoff, ascending by id. */
  selectArchivable(cutoffMs: number): Array<{ id: number; eventTimeMs: number; bodyJson: string }> {
    const rows = this.db
      .prepare(
        "SELECT id, event_time_ms AS eventTimeMs, body AS bodyJson FROM online_records WHERE event_time_ms < ? ORDER BY id ASC",
      )
      .all(cutoffMs) as Array<{ id: number | bigint; eventTimeMs: number | bigint; bodyJson: string }>;
    return rows.map((r) => ({ id: Number(r.id), eventTimeMs: Number(r.eventTimeMs), bodyJson: r.bodyJson }));
  }

  /** All online records, ascending by id. */
  selectAllOnline(): Array<{ id: number; eventTimeMs: number; bodyJson: string }> {
    const rows = this.db
      .prepare("SELECT id, event_time_ms AS eventTimeMs, body AS bodyJson FROM online_records ORDER BY id ASC")
      .all() as Array<{ id: number | bigint; eventTimeMs: number | bigint; bodyJson: string }>;
    return rows.map((r) => ({ id: Number(r.id), eventTimeMs: Number(r.eventTimeMs), bodyJson: r.bodyJson }));
  }

  /**
   * Atomically publish a segment in the manifest and delete its records'
   * rows (with bodies) from the online table. One transaction: a crash
   * either publishes everything or nothing.
   */
  commitSegment(segmentFile: string, recordIds: number[]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM segments")
        .get() as { seq: number | bigint };
      this.db
        .prepare("INSERT INTO segments(seq, file) VALUES (?, ?)")
        .run(Number(row.seq), segmentFile);
      const del = this.db.prepare("DELETE FROM online_records WHERE id = ?");
      for (const id of recordIds) {
        del.run(id);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Next segment sequence number (1-based), matching commitSegment's allocation. */
  nextSegmentSeq(): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM segments")
      .get() as { seq: number | bigint };
    return Number(row.seq);
  }

  /** Committed segment file names, in commit order. */
  listSegments(): string[] {
    const rows = this.db
      .prepare("SELECT file FROM segments ORDER BY seq ASC")
      .all() as Array<{ file: string }>;
    return rows.map((r) => r.file);
  }

  close(): void {
    this.db.close();
  }
}
