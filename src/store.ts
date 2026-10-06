import { DatabaseSync } from 'node:sqlite';
import type { Review } from './types.ts';

/** 待写入的一条记录：归一键 + 完整原始字段。 */
export interface StoredRecord {
  merchantId: string;
  /** 归一后的 channel（键的一部分）。 */
  normChannel: string;
  /** 归一后的 reviewer_name（键的一部分）。 */
  normReviewerName: string;
  /** 归一为 UTC 毫秒的时间（键的一部分）。 */
  timestampMs: number;
  /** 原始字段，读回时原样返回。 */
  channel: string;
  reviewerName: string;
  text: string;
  timestamp: string;
}

interface ReviewRow {
  channel: string;
  reviewer_name: string;
  text: string;
  timestamp: string;
}

/** SQLite 持久化层。 */
export class ReviewStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reviews (
        merchant_id TEXT NOT NULL,
        norm_channel TEXT NOT NULL,
        norm_reviewer_name TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        channel TEXT NOT NULL,
        reviewer_name TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        PRIMARY KEY (merchant_id, norm_channel, norm_reviewer_name, timestamp_ms)
      )
    `);
  }

  /** 在单个事务中替换式写入一批记录；任一失败整体回滚。 */
  replaceBatch(records: StoredRecord[]): void {
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO reviews
        (merchant_id, norm_channel, norm_reviewer_name, timestamp_ms, channel, reviewer_name, text, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.exec('BEGIN');
    try {
      for (const r of records) {
        insert.run(
          r.merchantId,
          r.normChannel,
          r.normReviewerName,
          r.timestampMs,
          r.channel,
          r.reviewerName,
          r.text,
          r.timestamp,
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 读取某商家的全部评论（原始字段），按时间、channel、reviewer 排序。 */
  listReviews(merchantId: string): Review[] {
    const stmt = this.db.prepare(`
      SELECT channel, reviewer_name, text, timestamp
      FROM reviews
      WHERE merchant_id = ?
      ORDER BY timestamp_ms, norm_channel, norm_reviewer_name
    `);
    const rows = stmt.all(merchantId) as unknown as ReviewRow[];
    return rows.map((row) => ({
      channel: row.channel,
      reviewerName: row.reviewer_name,
      text: row.text,
      timestamp: row.timestamp,
    }));
  }

  close(): void {
    this.db.close();
  }
}
