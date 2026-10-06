import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ops (
  op_id TEXT PRIMARY KEY,
  op_type TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS purchase_orders (
  po_id TEXT PRIMARY KEY,
  currency TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS po_lines (
  po_id TEXT NOT NULL,
  line_id TEXT NOT NULL,
  ordered_qty TEXT NOT NULL,
  unit_price TEXT NOT NULL,
  PRIMARY KEY (po_id, line_id)
);
CREATE TABLE IF NOT EXISTS receipts (
  receipt_id TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS receipt_lines (
  receipt_id TEXT NOT NULL,
  po_id TEXT NOT NULL,
  po_line_id TEXT NOT NULL,
  qty_qualified TEXT NOT NULL,
  qty_pending TEXT NOT NULL,
  qty_rejected TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receipt_lines_po ON receipt_lines (po_id, po_line_id);
CREATE TABLE IF NOT EXISTS invoices (
  invoice_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  currency TEXT NOT NULL,
  voided INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS invoice_lines (
  invoice_id TEXT NOT NULL,
  po_id TEXT NOT NULL,
  po_line_id TEXT NOT NULL,
  qty TEXT NOT NULL,
  amount TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invoice_state (
  invoice_id TEXT PRIMARY KEY,
  state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS line_allocation (
  po_id TEXT NOT NULL,
  po_line_id TEXT NOT NULL,
  matched_qty TEXT NOT NULL,
  matched_amount TEXT NOT NULL,
  PRIMARY KEY (po_id, po_line_id)
);
`;

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}
