import { DatabaseSync } from 'node:sqlite';
import type { ApplicationRecord, ApplicationState } from './types.js';

interface Row {
  channel_id: string;
  request_id: string;
  user_id: string;
  state: string;
  expires_at: number | null;
  queue_seq: number | null;
  created_at: number;
  updated_at: number;
}

function toRecord(row: Row): ApplicationRecord {
  return {
    channelId: row.channel_id,
    requestId: row.request_id,
    userId: row.user_id,
    state: row.state as ApplicationState,
    expiresAt: row.expires_at,
    queueSeq: row.queue_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** SQLite 存储层：只负责 schema 与记录读写，不含业务规则。 */
export class AdmissionStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS applications (
        channel_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        state TEXT NOT NULL,
        expires_at INTEGER,
        queue_seq INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (channel_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS idx_applications_channel_state
        ON applications (channel_id, state);
      CREATE INDEX IF NOT EXISTS idx_applications_queue
        ON applications (channel_id, state, queue_seq);
    `);
  }

  close(): void {
    this.db.close();
  }

  get(channelId: string, requestId: string): ApplicationRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM applications WHERE channel_id = ? AND request_id = ?`)
      .get(channelId, requestId) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  insert(record: ApplicationRecord): void {
    this.db
      .prepare(
        `INSERT INTO applications
           (channel_id, request_id, user_id, state, expires_at, queue_seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.channelId,
        record.requestId,
        record.userId,
        record.state,
        record.expiresAt,
        record.queueSeq,
        record.createdAt,
        record.updatedAt,
      );
  }

  update(record: ApplicationRecord): void {
    this.db
      .prepare(
        `UPDATE applications
           SET state = ?, expires_at = ?, queue_seq = ?, updated_at = ?
         WHERE channel_id = ? AND request_id = ?`,
      )
      .run(
        record.state,
        record.expiresAt,
        record.queueSeq,
        record.updatedAt,
        record.channelId,
        record.requestId,
      );
  }

  /** 某频道内某用户当前未结束的申请（最多一条，由业务层保证）。 */
  findActiveByUser(channelId: string, userId: string): ApplicationRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM applications
         WHERE channel_id = ? AND user_id = ? AND state != 'ended'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(channelId, userId) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  /** 占用席位的记录（reserved/watching）。 */
  listSeated(channelId: string): ApplicationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM applications
         WHERE channel_id = ? AND state IN ('reserved', 'watching')
         ORDER BY created_at ASC`,
      )
      .all(channelId) as unknown as Row[];
    return rows.map(toRecord);
  }

  /** 到期的占用记录：expires_at <= now。 */
  listExpiredSeated(channelId: string, now: number): ApplicationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM applications
         WHERE channel_id = ? AND state IN ('reserved', 'watching') AND expires_at <= ?
         ORDER BY expires_at ASC`,
      )
      .all(channelId, now) as unknown as Row[];
    return rows.map(toRecord);
  }

  /** 候补队列，按入队序号升序。 */
  listQueued(channelId: string): ApplicationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM applications
         WHERE channel_id = ? AND state = 'queued'
         ORDER BY queue_seq ASC`,
      )
      .all(channelId) as unknown as Row[];
    return rows.map(toRecord);
  }

  nextQueueSeq(channelId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(queue_seq), 0) + 1 AS next_seq
         FROM applications WHERE channel_id = ?`,
      )
      .get(channelId) as { next_seq: number };
    return row.next_seq;
  }

  /** 在单个事务中执行 fn。 */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
