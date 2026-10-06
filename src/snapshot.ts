import type { DatabaseSync } from 'node:sqlite';
import type { EventKind, TimelineEvent, TimelinePage } from './types.js';

/** 快照元信息。 */
export interface SnapshotInfo {
  id: number;
  /** 标签过滤；null 表示不过滤。 */
  tag: string | null;
  pageSize: number;
  /** 已读取的事件数（游标）。 */
  offset: number;
  /** 快照内事件总数。 */
  total: number;
  closed: boolean;
}

interface SnapshotRow {
  id: number;
  tag: string | null;
  page_size: number;
  offset: number;
  total: number;
  closed: number;
}

/**
 * 快照持久化：首屏时把筛选后的完整事件序列物化到表中，
 * 续页只按游标读取，因此后续修订不影响快照结果。
 */
export class SnapshotStore {
  constructor(private readonly db: DatabaseSync) {}

  initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tag TEXT,
        page_size INTEGER NOT NULL,
        offset INTEGER NOT NULL,
        total INTEGER NOT NULL,
        closed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS snapshot_events (
        snapshot_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        artifact_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        ts INTEGER NOT NULL,
        PRIMARY KEY (snapshot_id, seq)
      );
    `);
  }

  /** 创建快照并物化事件序列，返回快照 id。 */
  create(tag: string | null, pageSize: number, events: TimelineEvent[]): number {
    const insertSnapshot = this.db.prepare(
      `INSERT INTO snapshots (tag, page_size, offset, total, closed) VALUES (?, ?, 0, ?, 0)`
    );
    const insertEvent = this.db.prepare(
      `INSERT INTO snapshot_events (snapshot_id, seq, artifact_id, kind, ts) VALUES (?, ?, ?, ?, ?)`
    );
    this.db.exec('BEGIN');
    try {
      const result = insertSnapshot.run(tag, pageSize, events.length);
      const snapshotId = Number(result.lastInsertRowid);
      events.forEach((event, seq) => {
        insertEvent.run(snapshotId, seq, event.artifactId, event.kind, event.timestamp);
      });
      this.db.exec('COMMIT');
      return snapshotId;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private requireOpen(snapshotId: number): SnapshotRow {
    const stmt = this.db.prepare(
      `SELECT id, tag, page_size, offset, total, closed FROM snapshots WHERE id = ?`
    );
    const row = stmt.get(snapshotId) as unknown as SnapshotRow | undefined;
    if (!row) throw new Error(`snapshot ${snapshotId} does not exist`);
    if (row.closed) throw new Error(`snapshot ${snapshotId} is closed`);
    return row;
  }

  /** 读取快照的下一页并推进游标。 */
  nextPage(snapshotId: number): TimelinePage {
    const snapshot = this.requireOpen(snapshotId);
    const stmt = this.db.prepare(
      `SELECT artifact_id, kind, ts FROM snapshot_events
       WHERE snapshot_id = ? AND seq >= ? AND seq < ?
       ORDER BY seq`
    );
    const rows = stmt.all(
      snapshotId,
      snapshot.offset,
      snapshot.offset + snapshot.page_size
    ) as unknown as Array<{ artifact_id: number; kind: string; ts: number }>;
    const events: TimelineEvent[] = rows.map((row) => ({
      artifactId: row.artifact_id,
      kind: row.kind as EventKind,
      timestamp: row.ts,
    }));
    const newOffset = snapshot.offset + events.length;
    this.db.prepare(`UPDATE snapshots SET offset = ? WHERE id = ?`).run(newOffset, snapshotId);
    return { events, hasMore: newOffset < snapshot.total };
  }

  /** 结束快照，删除其物化数据。 */
  close(snapshotId: number): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`DELETE FROM snapshot_events WHERE snapshot_id = ?`).run(snapshotId);
      this.db.prepare(`UPDATE snapshots SET closed = 1 WHERE id = ?`).run(snapshotId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getInfo(snapshotId: number): SnapshotInfo | null {
    const stmt = this.db.prepare(
      `SELECT id, tag, page_size, offset, total, closed FROM snapshots WHERE id = ?`
    );
    const row = stmt.get(snapshotId) as unknown as SnapshotRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      tag: row.tag,
      pageSize: row.page_size,
      offset: row.offset,
      total: row.total,
      closed: row.closed !== 0,
    };
  }
}
