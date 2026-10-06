import { DatabaseSync } from "node:sqlite";

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS experiments (
      id TEXT PRIMARY KEY,
      seed INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS seed_rows (
      experiment_id TEXT NOT NULL,
      row_id INTEGER NOT NULL,
      features TEXT NOT NULL,
      label INTEGER NOT NULL,
      PRIMARY KEY (experiment_id, row_id)
    );
    CREATE TABLE IF NOT EXISTS pool_rows (
      experiment_id TEXT NOT NULL,
      strategy TEXT NOT NULL,
      row_id INTEGER NOT NULL,
      features TEXT NOT NULL,
      truth INTEGER NOT NULL,
      available INTEGER NOT NULL,
      PRIMARY KEY (experiment_id, strategy, row_id)
    );
    CREATE TABLE IF NOT EXISTS validation_rows (
      experiment_id TEXT NOT NULL,
      row_id INTEGER NOT NULL,
      features TEXT NOT NULL,
      label INTEGER NOT NULL,
      PRIMARY KEY (experiment_id, row_id)
    );
    CREATE TABLE IF NOT EXISTS rounds (
      experiment_id TEXT NOT NULL,
      strategy TEXT NOT NULL,
      round_no INTEGER NOT NULL,
      status TEXT NOT NULL,
      selected_ids TEXT NOT NULL,
      model TEXT NOT NULL,
      train_version INTEGER NOT NULL,
      validation_accuracy REAL,
      cumulative_budget INTEGER,
      PRIMARY KEY (experiment_id, strategy, round_no)
    );
    CREATE TABLE IF NOT EXISTS round_labels (
      experiment_id TEXT NOT NULL,
      strategy TEXT NOT NULL,
      round_no INTEGER NOT NULL,
      row_id INTEGER NOT NULL,
      label INTEGER NOT NULL,
      fetch_order INTEGER NOT NULL,
      PRIMARY KEY (experiment_id, strategy, round_no, row_id)
    );
  `);
  return db;
}
