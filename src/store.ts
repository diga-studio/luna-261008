import { DatabaseSync } from "node:sqlite";
import { CheckinStatus, CheckinSubmission } from "./types";

interface SubmissionRow {
  event_id: number;
  worker_id: number;
  occurred_at: number;
  status: string;
  zone_id: string;
  revision: number;
}

/** SQLite 持久化层：保存全部签到修订记录。 */
export class CheckinStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkin_submissions (
        event_id INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        worker_id INTEGER NOT NULL,
        occurred_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        zone_id TEXT NOT NULL,
        PRIMARY KEY (event_id, revision)
      );
    `);
  }

  /**
   * 提交一个签到修订。
   * 同一 (eventId, revision) 内容保证一致，重复提交用 INSERT OR IGNORE 忽略；
   * 较旧修订照常落盘（无害），解释语义由计算层取最大修订号保证。
   */
  submit(submission: CheckinSubmission): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO checkin_submissions
         (event_id, revision, worker_id, occurred_at, status, zone_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        submission.eventId,
        submission.revision,
        submission.workerId,
        submission.occurredAt,
        submission.status,
        submission.zoneId,
      );
  }

  /** 读取全部已提交的修订记录。 */
  allSubmissions(): CheckinSubmission[] {
    const rows = this.db
      .prepare(
        `SELECT event_id, revision, worker_id, occurred_at, status, zone_id
         FROM checkin_submissions`,
      )
      .all() as unknown as SubmissionRow[];
    return rows.map((row) => ({
      eventId: row.event_id,
      revision: row.revision,
      workerId: row.worker_id,
      occurredAt: row.occurred_at,
      status: row.status as CheckinStatus,
      zoneId: row.zone_id,
    }));
  }

  close(): void {
    this.db.close();
  }
}
