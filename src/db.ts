import { DatabaseSync } from 'node:sqlite';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS copies (
  barcode TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  branch TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('on_shelf','in_transit','checked_out'))
);
CREATE INDEX IF NOT EXISTS idx_copies_title_status ON copies(title, status, branch);

CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  reader TEXT NOT NULL,
  pickup_branch TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','ready','cancelled','completed')),
  copy_barcode TEXT
);
CREATE INDEX IF NOT EXISTS idx_res_title_status ON reservations(title, status, id);
CREATE INDEX IF NOT EXISTS idx_res_copy ON reservations(copy_barcode);

CREATE TABLE IF NOT EXISTS transfers (
  credential TEXT PRIMARY KEY,
  barcode TEXT NOT NULL,
  from_branch TEXT NOT NULL,
  to_branch TEXT NOT NULL,
  arrived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_transfers_barcode ON transfers(barcode, arrived);

CREATE TABLE IF NOT EXISTS loans (
  credential TEXT PRIMARY KEY,
  barcode TEXT NOT NULL,
  reader TEXT NOT NULL,
  returned INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_loans_barcode ON loans(barcode, returned);
`;

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}
