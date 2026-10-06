import { DatabaseSync } from "node:sqlite";

/**
 * 数据模型：
 * - groups: 账号组，group_id 即该组当前主账号编号（主账号一经确定不再改变）。
 * - accounts: 所有出现过的账号编号（含被合并的旧编号）到所属组的映射。
 * - history: 不可变历史记录，归属某个组；source_account_id 保留提交时编号。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS groups (
  tenant_id TEXT NOT NULL,
  group_id  TEXT NOT NULL,
  PRIMARY KEY (tenant_id, group_id)
);

CREATE TABLE IF NOT EXISTS accounts (
  tenant_id  TEXT NOT NULL,
  account_id TEXT NOT NULL,
  group_id   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, account_id)
);

CREATE TABLE IF NOT EXISTS history (
  tenant_id         TEXT NOT NULL,
  record_id         TEXT NOT NULL,
  recorded_at       TEXT NOT NULL,
  source_account_id TEXT NOT NULL,
  group_id          TEXT NOT NULL,
  body              TEXT NOT NULL,
  PRIMARY KEY (tenant_id, record_id)
);

CREATE INDEX IF NOT EXISTS idx_history_group_order
  ON history (tenant_id, group_id, recorded_at, record_id);

CREATE INDEX IF NOT EXISTS idx_accounts_group
  ON accounts (tenant_id, group_id);
`;

export function openDatabase(filename: string): DatabaseSync {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}
