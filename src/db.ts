import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS releases (
  release_id TEXT PRIMARY KEY,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'Planning',
  fact_version INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT NOT NULL DEFAULT '',
  released_basis TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS release_components (
  release_id TEXT NOT NULL REFERENCES releases(release_id),
  component_id TEXT NOT NULL,
  PRIMARY KEY (release_id, component_id)
);
CREATE TABLE IF NOT EXISTS release_checklist (
  release_id TEXT NOT NULL REFERENCES releases(release_id),
  item_id TEXT NOT NULL,
  label TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (release_id, item_id)
);
CREATE TABLE IF NOT EXISTS expectations (
  release_id TEXT NOT NULL REFERENCES releases(release_id),
  component_id TEXT NOT NULL,
  expected TEXT NOT NULL DEFAULT 'Not Started',
  PRIMARY KEY (release_id, component_id)
);
CREATE TABLE IF NOT EXISTS bugs (
  component_id TEXT NOT NULL,
  bug_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (component_id, bug_id)
);
CREATE TABLE IF NOT EXISTS tests (
  release_id TEXT NOT NULL REFERENCES releases(release_id),
  component_id TEXT NOT NULL,
  test_id TEXT NOT NULL,
  passed INTEGER NOT NULL,
  total INTEGER NOT NULL,
  skipped INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (release_id, component_id, test_id)
);
`;

/** 打开（必要时创建）SQLite 数据库并初始化 schema。 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
