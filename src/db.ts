import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS payments (
  merchant_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  total_amount INTEGER NOT NULL,
  orig_merchant INTEGER NOT NULL,
  orig_platform INTEGER NOT NULL,
  orig_partner INTEGER NOT NULL,
  refunded_total INTEGER NOT NULL DEFAULT 0,
  reserved_total INTEGER NOT NULL DEFAULT 0,
  share_merchant INTEGER NOT NULL DEFAULT 0,
  share_platform INTEGER NOT NULL DEFAULT 0,
  share_partner INTEGER NOT NULL DEFAULT 0,
  clearing_received INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (merchant_id, payment_id)
);

CREATE TABLE IF NOT EXISTS refunds (
  merchant_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  PRIMARY KEY (merchant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS entries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  debit_account TEXT NOT NULL,
  credit_account TEXT NOT NULL,
  amount INTEGER NOT NULL,
  refund_key TEXT,
  memo TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entries_payment ON entries (merchant_id, payment_id);
CREATE INDEX IF NOT EXISTS idx_refunds_payment ON refunds (merchant_id, payment_id);
`;

function isBusyError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('database is locked');
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('PRAGMA foreign_keys = ON');
  for (let attempt = 0; ; attempt += 1) {
    try {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec(SCHEMA);
      break;
    } catch (err) {
      if (!isBusyError(err) || attempt >= 100) throw err;
      sleepSync(20);
    }
  }
  return db;
}
