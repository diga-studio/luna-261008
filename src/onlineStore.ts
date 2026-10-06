import { DatabaseSync } from "node:sqlite";
import type { AuditRecord } from "./types.js";

interface RecordRow {
  id: number;
  event_time_ms: number;
  body: string;
}

/**
 * SQLite-backed store for online (not yet archived) records.
 * Also owns the archive manifest table used for crash recovery.
 *
 * Durability: WAL + synchronous=FULL. A committed append survives any
 * later process exit; an append interrupted before commit leaves no trace.
 */
export class OnlineStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_time_ms INTEGER NOT NULL,
        body TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS archives (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        file_name TEXT NOT NULL UNIQUE
      )
    `);
  }

  /** Append a record; returns its newly assigned strictly-increasing id. */
  append(eventTimeMs: number, body: string): number {
    const stmt = this.db.prepare(
      "INSERT INTO records (event_time_ms, body) VALUES (?, ?)",
    );
    const result = stmt.run(eventTimeMs, body);
    return Number(result.lastInsertRowid);
  }

  /** All online records with eventTimeMs strictly before cutoff, any id order. */
  selectOlderThan(cutoffMs: number): AuditRecord[] {
    const stmt = this.db.prepare(
      "SELECT id, event_time_ms, body FROM records WHERE event_time_ms < ?",
    );
    return (stmt.all(cutoffMs) as unknown as RecordRow[]).map(toRecord);
  }

  /** All online records, unsorted. */
  all(): AuditRecord[] {
    const stmt = this.db.prepare(
      "SELECT id, event_time_ms, body FROM records",
    );
    return (stmt.all() as unknown as RecordRow[]).map(toRecord);
  }

  /** Registered archive file names, in creation order. */
  listArchives(): string[] {
    const stmt = this.db.prepare(
      "SELECT file_name FROM archives ORDER BY seq",
    );
    return (stmt.all() as unknown as { file_name: string }[]).map(
      (row) => row.file_name,
    );
  }

  /**
   * Atomically: register `fileName` as a committed archive and delete
   * `ids` from the online table.
   */
  commitArchive(fileName: string, ids: number[]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO archives (file_name) VALUES (?)")
        .run(fileName);
      const del = this.db.prepare("DELETE FROM records WHERE id = ?");
      for (const id of ids) {
        del.run(id);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

function toRecord(row: RecordRow): AuditRecord {
  return { id: row.id, eventTimeMs: row.event_time_ms, body: row.body };
}
