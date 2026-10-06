import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ops (
  op_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_lines (
  order_id TEXT NOT NULL,
  line_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  qty TEXT NOT NULL,
  price_cents TEXT NOT NULL,
  PRIMARY KEY (order_id, line_id)
);
CREATE TABLE IF NOT EXISTS receipts (
  receipt_id TEXT PRIMARY KEY,
  lines TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invoices (
  invoice_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  voided INTEGER NOT NULL DEFAULT 0,
  settled INTEGER NOT NULL DEFAULT 0,
  lines TEXT NOT NULL
);
`;

/** 打开（或创建）SQLite 库并确保表结构存在。 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}
