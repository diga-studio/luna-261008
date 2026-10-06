import { DatabaseSync } from "node:sqlite";
import type { CheckinEvent, CheckinStatus } from "./types.js";

interface CheckinRow {
  event_id: number;
  revision: number;
  worker_id: number;
  occurred_at_ms: number;
  status: string;
  zone: string;
}

/** SQLite 持久层：保存签到事件的全部修订版本。 */
export class CheckinStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkins (
        event_id INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        worker_id INTEGER NOT NULL,
        occurred_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        zone TEXT NOT NULL,
        PRIMARY KEY (event_id, revision)
      );
    `);
  }

  /**
   * 提交一个修订版本。同一 (eventId, revision) 的内容保证一致，
   * 因此重复提交直接忽略；较旧修订即使保存也不会被 loadLatest 选中。
   */
  save(event: CheckinEvent): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO checkins
         (event_id, revision, worker_id, occurred_at_ms, status, zone)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.eventId,
        event.revision,
        event.workerId,
        event.occurredAtMs,
        event.status,
        event.zone,
      );
  }

  /** 读取每个事件的最新修订版本。 */
  loadLatest(): CheckinEvent[] {
    const rows = this.db
      .prepare(
        `SELECT c.event_id, c.revision, c.worker_id, c.occurred_at_ms, c.status, c.zone
         FROM checkins c
         JOIN (
           SELECT event_id, MAX(revision) AS max_revision
           FROM checkins GROUP BY event_id
         ) m ON c.event_id = m.event_id AND c.revision = m.max_revision`,
      )
      .all() as unknown as CheckinRow[];
    return rows.map((row) => ({
      eventId: row.event_id,
      revision: row.revision,
      workerId: row.worker_id,
      occurredAtMs: row.occurred_at_ms,
      status: row.status as CheckinStatus,
      zone: row.zone,
    }));
  }

  close(): void {
    this.db.close();
  }
}
