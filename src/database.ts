import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS devices (
  tag        TEXT PRIMARY KEY,
  area       TEXT NOT NULL,
  custodian  TEXT NOT NULL,
  mark       TEXT NOT NULL CHECK (mark IN ('found','pending'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved')),
  submitted    INTEGER NOT NULL DEFAULT 0,
  baseline_seq INTEGER NOT NULL,
  adjustment_id INTEGER
);

CREATE TABLE IF NOT EXISTS task_scope (
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  area    TEXT NOT NULL,
  PRIMARY KEY (task_id, area)
);

-- 开启任务时冻结的整份账册基线，之后任何变化都不修改它
CREATE TABLE IF NOT EXISTS baselines (
  task_id    INTEGER NOT NULL REFERENCES tasks(id),
  tag        TEXT NOT NULL,
  area       TEXT NOT NULL,
  custodian  TEXT NOT NULL,
  mark       TEXT NOT NULL,
  PRIMARY KEY (task_id, tag)
);

CREATE TABLE IF NOT EXISTS submissions (
  task_id    INTEGER NOT NULL REFERENCES tasks(id),
  tag        TEXT NOT NULL,
  area       TEXT NOT NULL,
  custodian  TEXT NOT NULL,
  PRIMARY KEY (task_id, tag)
);

-- 账册字段级变更流水：调拨与审批落账都记录，只记实际发生的变化
CREATE TABLE IF NOT EXISTS events (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  tag       TEXT NOT NULL,
  field     TEXT NOT NULL CHECK (field IN ('area','custodian','mark')),
  old_value TEXT NOT NULL,
  new_value TEXT NOT NULL,
  source    TEXT NOT NULL CHECK (source IN ('transfer','approval')),
  source_id INTEGER
);

CREATE TABLE IF NOT EXISTS adjustments (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL UNIQUE REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS adjustment_items (
  adjustment_id INTEGER NOT NULL REFERENCES adjustments(id),
  tag       TEXT NOT NULL,
  field     TEXT NOT NULL CHECK (field IN ('area','custodian','mark')),
  old_value TEXT NOT NULL,
  new_value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_tag_seq ON events(tag, seq);
CREATE INDEX IF NOT EXISTS idx_adjustment_items_adj ON adjustment_items(adjustment_id);
`;

/** 打开（必要时创建）SQLite 数据库并建表 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
