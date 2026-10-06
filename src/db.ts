import { DatabaseSync } from "node:sqlite";

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      payment_id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      currency TEXT NOT NULL,
      total_amount INTEGER NOT NULL,
      split_merchant INTEGER NOT NULL,
      split_platform INTEGER NOT NULL,
      split_partner INTEGER NOT NULL,
      refunded_amount INTEGER NOT NULL DEFAULT 0,
      held_amount INTEGER NOT NULL DEFAULT 0,
      share_merchant INTEGER NOT NULL DEFAULT 0,
      share_platform INTEGER NOT NULL DEFAULT 0,
      share_partner INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS refunds (
      refund_id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      payment_id TEXT NOT NULL REFERENCES payments(payment_id),
      idempotency_key TEXT NOT NULL,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL,
      UNIQUE (merchant_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS entries (
      entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id TEXT NOT NULL REFERENCES payments(payment_id),
      currency TEXT NOT NULL,
      account TEXT NOT NULL,
      debit INTEGER NOT NULL DEFAULT 0,
      credit INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL,
      refund_id TEXT
    );
  `);
  return db;
}
