import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fixed_cost_pool (
  product      TEXT    NOT NULL,
  month        TEXT    NOT NULL,  -- UTC 自然月，YYYY-MM
  amount_cents INTEGER NOT NULL,  -- 固定成本，分
  PRIMARY KEY (product, month)
);

CREATE TABLE IF NOT EXISTS revenue (
  id                 INTEGER PRIMARY KEY,  -- 全局唯一正整数编号
  contract_id        TEXT    NOT NULL,
  product            TEXT    NOT NULL,
  biz_date           TEXT    NOT NULL,     -- UTC 业务日期，YYYY-MM-DD
  month              TEXT    NOT NULL,     -- 冗余的所属成本池月份，YYYY-MM
  amount_cents       INTEGER NOT NULL,
  direct_cost_cents  INTEGER NOT NULL,
  allocated_cents    INTEGER NOT NULL DEFAULT 0  -- 已分摊固定成本，分
);

-- 池重算用覆盖索引（rowid 隐式包含，无需回表）
CREATE INDEX IF NOT EXISTS idx_revenue_pool ON revenue (product, month, amount_cents);
-- 利润查询用覆盖索引：contract_id 有序避免 GROUP BY 排序，全部列覆盖避免回表
CREATE INDEX IF NOT EXISTS idx_revenue_query ON revenue
  (contract_id, biz_date, amount_cents, direct_cost_cents, allocated_cents);
`;

/** 打开（或创建）数据库并确保表结构存在。 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(SCHEMA);
  return db;
}
