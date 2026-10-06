import { DatabaseSync } from "node:sqlite";

/** Open (or create) the SQLite database and ensure the schema exists. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tunnels (
      tunnel_id   TEXT PRIMARY KEY,
      site_a      TEXT NOT NULL,
      site_b      TEXT NOT NULL,
      interface_a TEXT NOT NULL,
      interface_b TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS status_records (
      record_id   TEXT PRIMARY KEY,
      object_id   TEXT NOT NULL,
      object_kind TEXT NOT NULL,
      ts_ms       INTEGER NOT NULL,
      seq         INTEGER NOT NULL,
      state       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_status_records_object_ts
      ON status_records (object_id, ts_ms, seq);
  `);
  return db;
}
