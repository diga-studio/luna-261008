import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger (
  tag TEXT PRIMARY KEY,
  area TEXT NOT NULL,
  custodian TEXT NOT NULL,
  mark TEXT NOT NULL CHECK (mark IN ('found','pending'))
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  areas TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','submitted','approved')),
  baseline_seq INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS baselines (
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  tag TEXT NOT NULL,
  area TEXT NOT NULL,
  custodian TEXT NOT NULL,
  mark TEXT NOT NULL,
  PRIMARY KEY (task_id, tag)
);
CREATE TABLE IF NOT EXISTS submissions (
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  tag TEXT NOT NULL,
  area TEXT NOT NULL,
  custodian TEXT NOT NULL,
  PRIMARY KEY (task_id, tag)
);
CREATE TABLE IF NOT EXISTS op_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tag TEXT NOT NULL,
  field TEXT NOT NULL CHECK (field IN ('area','custodian','mark')),
  old_value TEXT NOT NULL,
  new_value TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('transfer','approval')),
  task_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_op_log_tag ON op_log (tag, field, seq);
CREATE TABLE IF NOT EXISTS adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL UNIQUE REFERENCES tasks(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS adjustment_items (
  adjustment_id INTEGER NOT NULL REFERENCES adjustments(id),
  tag TEXT NOT NULL,
  field TEXT NOT NULL,
  from_value TEXT NOT NULL,
  to_value TEXT NOT NULL
);
`;

/** 打开（或创建）SQLite 数据库并初始化表结构 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}

/** 在 IMMEDIATE 事务中执行 fn，保证整体可见、失败回滚 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
