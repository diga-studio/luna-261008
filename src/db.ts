import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS challenge_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS challenge_questions (
  version_id INTEGER NOT NULL REFERENCES challenge_versions(id),
  day INTEGER NOT NULL,
  question_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  options_json TEXT NOT NULL,
  correct_index INTEGER NOT NULL,
  PRIMARY KEY (version_id, day, question_index)
);

CREATE TABLE IF NOT EXISTS completions (
  learner_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  version_id INTEGER NOT NULL REFERENCES challenge_versions(id),
  score INTEGER NOT NULL,
  total_questions INTEGER NOT NULL,
  base_xp INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  active_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (learner_id, day)
);

CREATE TABLE IF NOT EXISTS active_days (
  learner_id TEXT NOT NULL,
  active_date TEXT NOT NULL,
  PRIMARY KEY (learner_id, active_date)
);

CREATE TABLE IF NOT EXISTS xp_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  learner_id TEXT NOT NULL,
  kind TEXT NOT NULL, -- 'base' | 'streak'
  amount INTEGER NOT NULL,
  day INTEGER,        -- 仅 base 事件关联挑战日
  created_at TEXT NOT NULL
);
`;

/** 打开（或创建）数据库并初始化表结构 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}
