import type { DatabaseSync } from "node:sqlite";
import type { LedgerEntry, Mark, Transfer } from "./types.js";
import { withTransaction } from "./db.js";

interface LedgerRow {
  tag: string;
  area: string;
  custodian: string;
  mark: string;
}

function rowToEntry(row: LedgerRow): LedgerEntry {
  return { tag: row.tag, area: row.area, custodian: row.custodian, mark: row.mark as Mark };
}

/** 用调用方提供的初始账册替换当前账册（清空后写入） */
export function loadInitialLedger(db: DatabaseSync, entries: LedgerEntry[]): void {
  withTransaction(db, () => {
    db.exec("DELETE FROM ledger");
    const insert = db.prepare(
      "INSERT INTO ledger (tag, area, custodian, mark) VALUES (?, ?, ?, ?)",
    );
    for (const entry of entries) {
      insert.run(entry.tag, entry.area, entry.custodian, entry.mark);
    }
  });
}

/** 登记一次日常调拨：可同时改区域与保管人，盘点标记不变 */
export function registerTransfer(db: DatabaseSync, transfer: Transfer): void {
  if (transfer.area === undefined && transfer.custodian === undefined) {
    throw new Error("调拨必须至少包含区域或保管人之一");
  }
  withTransaction(db, () => {
    const row = db
      .prepare("SELECT tag, area, custodian, mark FROM ledger WHERE tag = ?")
      .get(transfer.tag) as LedgerRow | undefined;
    if (!row) {
      throw new Error(`设备未登记: ${transfer.tag}`);
    }
    const log = db.prepare(
      "INSERT INTO op_log (tag, field, old_value, new_value, source, task_id) VALUES (?, ?, ?, ?, 'transfer', NULL)",
    );
    if (transfer.area !== undefined && transfer.area !== row.area) {
      db.prepare("UPDATE ledger SET area = ? WHERE tag = ?").run(transfer.area, transfer.tag);
      log.run(transfer.tag, "area", row.area, transfer.area);
    }
    if (transfer.custodian !== undefined && transfer.custodian !== row.custodian) {
      db.prepare("UPDATE ledger SET custodian = ? WHERE tag = ?").run(
        transfer.custodian,
        transfer.tag,
      );
      log.run(transfer.tag, "custodian", row.custodian, transfer.custodian);
    }
  });
}

/** 读取整份账册（按标签排序） */
export function getLedger(db: DatabaseSync): LedgerEntry[] {
  const rows = db
    .prepare("SELECT tag, area, custodian, mark FROM ledger ORDER BY tag")
    .all() as unknown as LedgerRow[];
  return rows.map(rowToEntry);
}
