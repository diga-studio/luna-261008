import { DatabaseSync } from 'node:sqlite';
import type { StoredReview, ValidRecord } from './types.js';

/** SQLite 持久化层。 */
export class ReviewStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reviews (
        merchant_id   TEXT NOT NULL,
        channel_key   TEXT NOT NULL,
        reviewer_key  TEXT NOT NULL,
        timestamp_ms  INTEGER NOT NULL,
        channel       TEXT NOT NULL,
        reviewer_name TEXT NOT NULL,
        text          TEXT NOT NULL,
        timestamp     TEXT NOT NULL,
        PRIMARY KEY (merchant_id, channel_key, reviewer_key, timestamp_ms)
      )
    `);
  }

  /** 在一个事务内按键替换/插入一批有效记录；任一失败则整体回滚。 */
  upsertBatch(merchantId: string, records: ValidRecord[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO reviews (
        merchant_id, channel_key, reviewer_key, timestamp_ms,
        channel, reviewer_name, text, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (merchant_id, channel_key, reviewer_key, timestamp_ms)
      DO UPDATE SET
        channel = excluded.channel,
        reviewer_name = excluded.reviewer_name,
        text = excluded.text,
        timestamp = excluded.timestamp
    `);
    this.db.exec('BEGIN');
    try {
      for (const record of records) {
        stmt.run(
          merchantId,
          record.key.channel,
          record.key.reviewerName,
          record.key.timestampMs,
          record.raw.channel,
          record.raw.reviewerName,
          record.raw.text,
          record.raw.timestamp,
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 读取某商家的全部评论（按时间升序），返回完整原始字段。 */
  listReviews(merchantId: string): StoredReview[] {
    const stmt = this.db.prepare(`
      SELECT channel, reviewer_name, text, timestamp, timestamp_ms
      FROM reviews
      WHERE merchant_id = ?
      ORDER BY timestamp_ms ASC, rowid ASC
    `);
    const rows = stmt.all(merchantId) as unknown as Array<{
      channel: string;
      reviewer_name: string;
      text: string;
      timestamp: string;
      timestamp_ms: number;
    }>;
    return rows.map((row) => ({
      channel: row.channel,
      reviewerName: row.reviewer_name,
      text: row.text,
      timestamp: row.timestamp,
      timestampMs: row.timestamp_ms,
    }));
  }

  close(): void {
    this.db.close();
  }
}
