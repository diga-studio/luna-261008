import type { DatabaseSync } from 'node:sqlite';
import type { StateRecord } from './types.js';

/**
 * 追加一条状态记录。记录可能乱序、重复到达；
 * 相同 recordId 的记录只生效一次（内容保证相同，直接忽略重复）。
 */
export function appendRecord(db: DatabaseSync, record: StateRecord): void {
  if (!Number.isInteger(record.bizTime)) {
    throw new RangeError('bizTime must be an integer number of milliseconds');
  }
  if (!Number.isInteger(record.seq)) {
    throw new RangeError('seq must be an integer');
  }
  db.prepare(
    `INSERT OR IGNORE INTO records (record_id, object_type, object_id, seq, biz_time, state)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(record.recordId, record.objectType, record.objectId, record.seq, record.bizTime, record.state);
}
