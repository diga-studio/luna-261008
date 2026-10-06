import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS applications (
  channel_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'watching', 'queued', 'ended')),
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_applications_channel_status
  ON applications (channel_id, status);
`;

/** 打开数据库并确保表结构存在。 */
export function openDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
}
