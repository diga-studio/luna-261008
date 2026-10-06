import { DatabaseSync } from 'node:sqlite';

/**
 * Open (or create) the SQLite database and ensure the schema exists.
 *
 * History-first design: every committed change appends one row per touched
 * set to `set_history`, tagged with the global commit id. The current state
 * of a set is its latest history row; a read view pinned to commit S reads
 * the latest rows with commit_id <= S, so old views never observe newer
 * commits. Withdrawn sets keep a tombstone row (withdrawn = 1) so the
 * version bump survives and later submissions based on the old version are
 * rejected.
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS cycles (
      employee_id TEXT PRIMARY KEY,
      exercise_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS commits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      credential TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (employee_id, batch_id)
    );
    CREATE TABLE IF NOT EXISTS set_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      commit_id INTEGER NOT NULL REFERENCES commits(id),
      employee_id TEXT NOT NULL,
      exercise_index INTEGER NOT NULL,
      week INTEGER NOT NULL,
      session INTEGER NOT NULL,
      set_index INTEGER NOT NULL,
      weight_lbs REAL,
      reps INTEGER,
      withdrawn INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_set_history_key
      ON set_history (employee_id, exercise_index, week, session, set_index, commit_id);
    CREATE INDEX IF NOT EXISTS idx_commits_employee
      ON commits (employee_id, id);
  `);
  return db;
}
