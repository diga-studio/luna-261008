import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS challenge_versions (
  version_id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS completions (
  learner_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  version_id INTEGER NOT NULL,
  score INTEGER NOT NULL,
  base_xp INTEGER NOT NULL,
  active_date TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (learner_id, day)
);

CREATE INDEX IF NOT EXISTS idx_completions_learner
  ON completions (learner_id, active_date);
`;

export const META_CURRENT_VERSION = "current_version_id";

/** 打开（必要时创建）数据库并保证表结构存在 */
export function openDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}
