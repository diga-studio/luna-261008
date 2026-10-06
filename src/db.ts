import { DatabaseSync } from 'node:sqlite';

/**
 * 打开（或创建）SQLite 数据库并确保表结构存在。
 * 所有业务状态都在库内，正常关闭重开后状态保持一致。
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS copies (
      barcode TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('on_shelf','in_transit','checked_out')),
      -- on_shelf: 所在分馆；in_transit: 既定目的分馆；checked_out: NULL
      branch TEXT,
      -- 当前关联的未完成预约（可空）
      hold_id INTEGER,
      -- 当前在途调拨凭据（可空）
      transfer_credential TEXT,
      -- 当前借出凭据（可空）
      loan_credential TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_copies_title_status ON copies(title, status);

    CREATE TABLE IF NOT EXISTS holds (
      hold_id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      reader TEXT NOT NULL,
      pickup_branch TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','bound','ready','fulfilled','cancelled')),
      -- 队列顺序：按被接受先后单调递增；取消后重新预约取新值排到队尾
      queue_seq INTEGER NOT NULL,
      barcode TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_holds_title_status ON holds(title, status, queue_seq);

    CREATE TABLE IF NOT EXISTS transfers (
      credential TEXT PRIMARY KEY,
      barcode TEXT NOT NULL,
      dest_branch TEXT NOT NULL,
      hold_id INTEGER,
      status TEXT NOT NULL CHECK (status IN ('open','closed'))
    );

    CREATE TABLE IF NOT EXISTS loans (
      credential TEXT PRIMARY KEY,
      barcode TEXT NOT NULL,
      reader TEXT NOT NULL,
      hold_id INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open','closed'))
    );

    -- 单调计数器：预约队列序号、调拨凭据序号、借出凭据序号（不复用）
    CREATE TABLE IF NOT EXISTS counters (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
  `);
  return db;
}

/** 取某个命名计数器的下一个值（单调递增，持久化，重启后继续）。 */
export function nextSeq(db: DatabaseSync, name: string): number {
  db.prepare('INSERT OR IGNORE INTO counters(name, value) VALUES (?, 0)').run(name);
  db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run(name);
  const row = db.prepare('SELECT value FROM counters WHERE name = ?').get(name) as { value: number };
  return Number(row.value);
}
