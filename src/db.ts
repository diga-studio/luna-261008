import { DatabaseSync } from 'node:sqlite';

/** 打开（或初始化）SQLite 数据库并建好表结构 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS events (
      event_id   TEXT PRIMARY KEY,
      room_id    TEXT NOT NULL,
      session_id TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      ts         INTEGER NOT NULL,
      action     TEXT NOT NULL CHECK (action IN ('open', 'download', 'other')),
      doc_id     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_session
      ON events (session_id, ts, event_id);
    CREATE INDEX IF NOT EXISTS idx_events_report
      ON events (room_id, doc_id, action, ts);
  `);
  return db;
}
