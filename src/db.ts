import { DatabaseSync } from 'node:sqlite';

export function openDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS objects (
      id TEXT PRIMARY KEY,
      tier TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      tier TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      object_id TEXT,
      temp_path TEXT,
      final_path TEXT
    );
  `);
  return db;
}
