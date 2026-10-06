import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cycles (
  employee_id TEXT PRIMARY KEY,
  exercises TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS commits (
  employee_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  commit_id TEXT NOT NULL UNIQUE,
  batch_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (employee_id, seq),
  UNIQUE (employee_id, batch_id)
);
CREATE TABLE IF NOT EXISTS current_sets (
  employee_id TEXT NOT NULL,
  exercise_id TEXT NOT NULL,
  week INTEGER NOT NULL,
  session INTEGER NOT NULL,
  set_no INTEGER NOT NULL,
  version INTEGER NOT NULL,
  weight REAL,
  reps INTEGER,
  withdrawn INTEGER NOT NULL,
  PRIMARY KEY (employee_id, exercise_id, week, session, set_no)
);
CREATE TABLE IF NOT EXISTS set_changes (
  employee_id TEXT NOT NULL,
  exercise_id TEXT NOT NULL,
  week INTEGER NOT NULL,
  session INTEGER NOT NULL,
  set_no INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  version INTEGER NOT NULL,
  weight REAL,
  reps INTEGER,
  withdrawn INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_set_changes_lookup
  ON set_changes (employee_id, exercise_id, week, session, set_no, seq);
CREATE INDEX IF NOT EXISTS idx_set_changes_seq
  ON set_changes (employee_id, seq);
`;

/** 打开（或创建）SQLite 数据库并确保表结构存在。 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
