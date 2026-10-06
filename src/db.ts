import { DatabaseSync } from 'node:sqlite';

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS releases (
      release_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'Planning',
      gate_version INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS release_components (
      release_id TEXT NOT NULL,
      component_id TEXT NOT NULL,
      PRIMARY KEY (release_id, component_id)
    );
    CREATE TABLE IF NOT EXISTS release_checklist (
      release_id TEXT NOT NULL,
      item TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (release_id, item)
    );
    CREATE TABLE IF NOT EXISTS expected_states (
      release_id TEXT NOT NULL,
      component_id TEXT NOT NULL,
      state TEXT NOT NULL,
      PRIMARY KEY (release_id, component_id)
    );
    CREATE TABLE IF NOT EXISTS bugs (
      bug_id TEXT PRIMARY KEY,
      component_id TEXT NOT NULL,
      severity TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      release_id TEXT NOT NULL,
      component_id TEXT NOT NULL,
      test_id TEXT NOT NULL,
      completed_at INTEGER NOT NULL,
      passed INTEGER NOT NULL,
      total INTEGER NOT NULL,
      skipped INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS release_records (
      release_id TEXT PRIMARY KEY,
      confirmed_at INTEGER NOT NULL,
      basis_json TEXT NOT NULL
    );
  `);
}
