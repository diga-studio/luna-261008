import { DatabaseSync } from 'node:sqlite';
import type { ArtifactRecord } from './types.js';

/**
 * SQLite 持久化层的薄封装。
 * 负责 schema 初始化、批次写入（事务）与读取。
 */
export class TimelineStore {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS artifacts (
        id INTEGER PRIMARY KEY,
        tags TEXT NOT NULL,
        mtime INTEGER,
        atime INTEGER,
        ctime INTEGER,
        btime INTEGER
        );
    `);
  }

  /** 在一个事务中提交一个批次：同编号记录整体替换。 */
  applyBatch(records: ArtifactRecord[]): void {
    if (records.length === 0) return;
    const upsert = this.db.prepare(
      `INSERT INTO artifacts (id, tags, mtime, atime, ctime, btime)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         tags = excluded.tags,
         mtime = excluded.mtime,
         atime = excluded.atime,
         ctime = excluded.ctime,
         btime = excluded.btime`
    );
    this.db.exec('BEGIN');
    try {
      for (const record of records) {
        upsert.run(
          record.id,
          JSON.stringify(record.tags),
          record.mtime,
          record.atime,
          record.ctime,
          record.btime
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 读取当前全部制品记录（用于构建快照）。 */
  loadAllRecords(): ArtifactRecord[] {
    const stmt = this.db.prepare(
      `SELECT id, tags, mtime, atime, ctime, btime FROM artifacts ORDER BY id`
    );
    const rows = stmt.all() as unknown as Array<{
      id: number;
      tags: string;
      mtime: number | null;
      atime: number | null;
      ctime: number | null;
      btime: number | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      tags: JSON.parse(row.tags) as string[],
      mtime: row.mtime,
      atime: row.atime,
      ctime: row.ctime,
      btime: row.btime,
    }));
  }

  close(): void {
    this.db.close();
  }
}
