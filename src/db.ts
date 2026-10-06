import { DatabaseSync } from 'node:sqlite';

/** 打开（必要时创建）数据库并确保表结构存在。 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS interfaces (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS tunnels (
      id TEXT PRIMARY KEY,
      site_a TEXT NOT NULL,
      site_b TEXT NOT NULL,
      iface_a TEXT NOT NULL,
      iface_b TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS records (
      record_id TEXT PRIMARY KEY,
      object_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      biz_time INTEGER NOT NULL,
      state TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_records_object
      ON records (object_type, object_id, biz_time, seq);
  `);
  return db;
}
