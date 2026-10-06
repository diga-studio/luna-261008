import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 每个批次一个递增版本号；批次是可见性的原子单位
CREATE TABLE IF NOT EXISTS batches (
  version INTEGER PRIMARY KEY,
  record_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- 制品标签的版本化区间：[version_from, version_to)，version_to 为 NULL 表示当前版本
CREATE TABLE IF NOT EXISTS artifact_tags (
  artifact_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  version_from INTEGER NOT NULL,
  version_to INTEGER,
  PRIMARY KEY (artifact_id, tag, version_from)
);
CREATE INDEX IF NOT EXISTS idx_artifact_tags_visible
  ON artifact_tags (tag, artifact_id, version_from, version_to);

-- 事件的版本化区间；kind_rank 固定 M=0 A=1 C=2 B=3 用于排序
CREATE TABLE IF NOT EXISTS events (
  artifact_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  kind_rank INTEGER NOT NULL,
  time INTEGER NOT NULL,
  version_from INTEGER NOT NULL,
  version_to INTEGER,
  PRIMARY KEY (artifact_id, kind, version_from)
);
CREATE INDEX IF NOT EXISTS idx_events_visible
  ON events (time, artifact_id, kind_rank, version_from, version_to);

-- 持久化的翻页快照：首屏的证据版本、筛选条件与游标
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  tag TEXT,
  page_size INTEGER NOT NULL,
  last_time INTEGER,
  last_artifact_id INTEGER,
  last_kind_rank INTEGER,
  has_more INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`;

/** 打开（必要时创建）案件数据库并建好 schema */
export function openCaseDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec(SCHEMA);
  db.exec(
    "INSERT OR IGNORE INTO meta (key, value) VALUES ('version', '0')"
  );
  return db;
}
