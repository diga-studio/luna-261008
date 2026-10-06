import { DatabaseSync } from "node:sqlite";

/**
 * 打开（或创建）SQLite 数据库并初始化 schema。
 *
 * 表结构：
 * - pools：成本池，一个产品一个 UTC 自然月（month 格式 YYYY-MM），固定成本录入后不改。
 * - revenues：收入。month 冗余自 biz_date（YYYY-MM），用于按池取数。
 *   allocated 列为当前所属成本池统一分摊后的归属固定成本，
 *   只由完整成本池决定，与任何查询区间无关。
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS pools (
      product_id INTEGER NOT NULL,
      month TEXT NOT NULL,
      fixed_cost INTEGER NOT NULL,
      PRIMARY KEY (product_id, month)
    );
    CREATE TABLE IF NOT EXISTS revenues (
      id INTEGER PRIMARY KEY,
      contract_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      biz_date TEXT NOT NULL,
      month TEXT NOT NULL,
      amount INTEGER NOT NULL,
      direct_cost INTEGER NOT NULL,
      allocated INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_revenues_pool
      ON revenues (product_id, month);
    CREATE INDEX IF NOT EXISTS idx_revenues_query
      ON revenues (biz_date, contract_id, amount, direct_cost, allocated);
  `);
  return db;
}
