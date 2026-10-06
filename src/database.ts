import { DatabaseSync } from "node:sqlite";

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS versions (
      version INTEGER PRIMARY KEY,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS seen_events (
      source_ap TEXT NOT NULL,
      source_seq INTEGER NOT NULL,
      PRIMARY KEY (source_ap, source_seq)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('value', 'deleted')),
      source_ap TEXT NOT NULL,
      source_seq INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      value_json TEXT
    );

    CREATE TABLE IF NOT EXISTS session_history (
      session_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('value', 'deleted', 'absent')),
      source_ap TEXT,
      source_seq INTEGER,
      updated_at INTEGER,
      value_json TEXT,
      PRIMARY KEY (session_id, version)
    );
  `);
}
