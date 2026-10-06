import { DatabaseSync } from "node:sqlite";
import { SummaryRecord, ThreatEvent } from "./types";

/**
 * Summary-side store: ingests events from many agents, keeps
 * out-of-order arrivals, and exposes only the gap-free prefix
 * starting at seq 1 per agent. Persisted in its own SQLite file.
 */
export class SummarySide {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        agent_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        body BLOB NOT NULL,
        PRIMARY KEY (agent_id, seq)
      );
      CREATE TABLE IF NOT EXISTS watermarks (
        agent_id TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
    `);
  }

  /**
   * Ingest a batch of events from one agent. Duplicates are ignored.
   * Returns the agent's current contiguous confirmed watermark,
   * which the caller may send back to the agent as a receipt.
   */
  ingest(agentId: string, events: ThreatEvent[]): number {
    this.db.exec("SAVEPOINT ingest");
    try {
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO events (agent_id, seq, event_id, body)
         VALUES (?, ?, ?, ?)`,
      );
      for (const ev of events) {
        insert.run(agentId, ev.seq, ev.eventId, ev.body);
      }
      const hasNext = this.db.prepare(
        "SELECT 1 FROM events WHERE agent_id = ? AND seq = ?",
      );
      let watermark = this.watermark(agentId);
      while (hasNext.get(agentId, watermark + 1) !== undefined) {
        watermark += 1;
      }
      this.db
        .prepare(
          `INSERT INTO watermarks (agent_id, value) VALUES (?, ?)
           ON CONFLICT(agent_id) DO UPDATE SET value = MAX(value, excluded.value)`,
        )
        .run(agentId, watermark);
      this.db.exec("RELEASE ingest");
      return this.watermark(agentId);
    } catch (err) {
      this.db.exec("ROLLBACK TO ingest");
      this.db.exec("RELEASE ingest");
      throw err;
    }
  }

  /** Publicly visible gap-free prefix for an agent, from seq 1. */
  records(agentId: string): SummaryRecord[] {
    return this.db
      .prepare(
        `SELECT seq, event_id AS eventId, body FROM events
         WHERE agent_id = ? AND seq <= ?
         ORDER BY seq ASC`,
      )
      .all(agentId, this.watermark(agentId)) as unknown as SummaryRecord[];
  }

  /** Current contiguous watermark for an agent (0 if none). */
  watermark(agentId: string): number {
    const row = this.db
      .prepare("SELECT value FROM watermarks WHERE agent_id = ?")
      .get(agentId) as { value: number } | undefined;
    return row ? row.value : 0;
  }

  close(): void {
    this.db.close();
  }
}
