import { DatabaseSync } from "node:sqlite";
import { EventBody, ReceiveResult, ThreatEvent } from "./types";

const CONFIRMED_KEY = "confirmed";

/**
 * Agent-side store: receives threat events locally, keeps unconfirmed
 * events for retransmission, and applies confirmation watermarks.
 * All state is persisted in its own SQLite database file.
 */
export class AgentSide {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        body BLOB
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
    `);
  }

  /** Idempotently receive an event; assigns a stable per-agent seq. */
  receiveEvent(eventId: string, body: EventBody): ReceiveResult {
    this.db.exec("SAVEPOINT receive_event");
    try {
      const existing = this.db
        .prepare("SELECT seq FROM events WHERE event_id = ?")
        .get(eventId) as { seq: number } | undefined;
      if (existing) {
        this.db.exec("RELEASE receive_event");
        return { seq: existing.seq, created: false };
      }
      const next = this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events")
        .get() as { seq: number };
      this.db
        .prepare("INSERT INTO events (event_id, seq, body) VALUES (?, ?, ?)")
        .run(eventId, next.seq, body);
      this.db.exec("RELEASE receive_event");
      return { seq: next.seq, created: true };
    } catch (err) {
      this.db.exec("ROLLBACK TO receive_event");
      this.db.exec("RELEASE receive_event");
      throw err;
    }
  }

  /** Events not yet covered by the confirmation watermark, in seq order. */
  pendingEvents(): ThreatEvent[] {
    const rows = this.db
      .prepare(
        `SELECT seq, event_id AS eventId, body FROM events
         WHERE seq > ? AND body IS NOT NULL
         ORDER BY seq ASC`,
      )
      .all(this.confirmedWatermark()) as unknown as ThreatEvent[];
    return rows;
  }

  /**
   * Apply a confirmation watermark from the summary side.
   * Monotonic: stale/lower watermarks never regress progress.
   * Bodies of confirmed events are released; id->seq mapping is kept.
   */
  applyAck(watermark: number): void {
    if (!Number.isInteger(watermark) || watermark < 0) {
      throw new RangeError("watermark must be a non-negative integer");
    }
    this.db.exec("SAVEPOINT apply_ack");
    try {
      this.db
        .prepare(
          `INSERT INTO meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = MAX(value, excluded.value)`,
        )
        .run(CONFIRMED_KEY, watermark);
      this.db
        .prepare(
          `UPDATE events SET body = NULL
           WHERE seq <= (SELECT value FROM meta WHERE key = ?)`,
        )
        .run(CONFIRMED_KEY);
      this.db.exec("RELEASE apply_ack");
    } catch (err) {
      this.db.exec("ROLLBACK TO apply_ack");
      this.db.exec("RELEASE apply_ack");
      throw err;
    }
  }

  /** Current confirmed watermark (highest confirmed contiguous seq). */
  confirmedWatermark(): number {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(CONFIRMED_KEY) as { value: number } | undefined;
    return row ? row.value : 0;
  }

  close(): void {
    this.db.close();
  }
}
