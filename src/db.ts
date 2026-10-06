import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  seed INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS seed_rows (
  exp_id TEXT NOT NULL,
  row_id INTEGER NOT NULL,
  features TEXT NOT NULL,
  label INTEGER NOT NULL,
  PRIMARY KEY (exp_id, row_id)
);
CREATE TABLE IF NOT EXISTS pool_rows (
  exp_id TEXT NOT NULL,
  row_id INTEGER NOT NULL,
  features TEXT NOT NULL,
  label INTEGER NOT NULL,
  PRIMARY KEY (exp_id, row_id)
);
CREATE TABLE IF NOT EXISTS val_rows (
  exp_id TEXT NOT NULL,
  row_id INTEGER NOT NULL,
  features TEXT NOT NULL,
  label INTEGER NOT NULL,
  PRIMARY KEY (exp_id, row_id)
);
CREATE TABLE IF NOT EXISTS strategy_state (
  exp_id TEXT NOT NULL,
  strategy TEXT NOT NULL,
  committed_rounds INTEGER NOT NULL,
  budget INTEGER NOT NULL,
  train_ids TEXT NOT NULL,
  pool_ids TEXT NOT NULL,
  PRIMARY KEY (exp_id, strategy)
);
CREATE TABLE IF NOT EXISTS rounds (
  exp_id TEXT NOT NULL,
  strategy TEXT NOT NULL,
  round_no INTEGER NOT NULL,
  status TEXT NOT NULL,
  selection TEXT NOT NULL,
  train_version TEXT NOT NULL,
  labels TEXT NOT NULL,
  accuracy REAL,
  budget INTEGER,
  PRIMARY KEY (exp_id, strategy, round_no)
);
`;

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec(SCHEMA);
  return db;
}
