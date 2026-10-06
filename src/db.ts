import { DatabaseSync } from 'node:sqlite';

export type Database = DatabaseSync;

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS segments (
      call_id TEXT NOT NULL,
      segment_index INTEGER NOT NULL,
      score REAL NOT NULL,
      registered_at INTEGER NOT NULL,
      PRIMARY KEY (call_id, segment_index)
    );
    CREATE TABLE IF NOT EXISTS call_state (
      call_id TEXT PRIMARY KEY,
      last_segment_index INTEGER NOT NULL,
      negative_streak INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      call_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      level TEXT NOT NULL,
      confirmed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      alert_id TEXT NOT NULL,
      call_id TEXT NOT NULL,
      level TEXT NOT NULL,
      published_at INTEGER NOT NULL,
      UNIQUE (alert_id, level)
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
  `);
  return db;
}
