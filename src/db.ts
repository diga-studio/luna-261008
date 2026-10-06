import { DatabaseSync } from 'node:sqlite';

/** 打开数据库并建表。 */
export function openDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  initSchema(db);
  return db;
}

function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS revisions (
      project_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      cta TEXT NOT NULL,
      background_color TEXT NOT NULL,
      font TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, version)
    );
    CREATE TABLE IF NOT EXISTS dedup_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      base_version INTEGER NOT NULL,
      baseline_title TEXT NOT NULL,
      baseline_body TEXT NOT NULL,
      baseline_cta TEXT NOT NULL,
      baseline_background_color TEXT NOT NULL,
      baseline_font TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      cta TEXT NOT NULL,
      background_color TEXT NOT NULL,
      font TEXT NOT NULL,
      result_version INTEGER NOT NULL,
      first_success_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dedup_project_base
      ON dedup_records (project_id, base_version);
  `);
}
