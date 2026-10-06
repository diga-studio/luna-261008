import { DatabaseSync } from "node:sqlite";
import type { BillingRecord } from "./types.js";

const READ_PAGE_SIZE = 1000;

interface BillingRow {
  resource_id: string;
  usage_date: string;
  quantity: string;
  unit_cost: string;
  total_cost: string;
  seq: number;
}

/** SQLite-backed persistence for committed billing records. */
export class BillingStore {
  private db: DatabaseSync | null = null;

  constructor(private readonly dbPath: string) {}

  open(): void {
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS billing (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        usage_date TEXT NOT NULL,
        quantity TEXT NOT NULL,
        unit_cost TEXT NOT NULL,
        total_cost TEXT NOT NULL,
        UNIQUE (account_id, resource_id, usage_date)
      );
      CREATE TEMP TABLE IF NOT EXISTS batch_keys (
        account_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        usage_date TEXT NOT NULL,
        PRIMARY KEY (account_id, resource_id, usage_date)
      );
    `);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private get conn(): DatabaseSync {
    if (!this.db) throw new Error("store is not open");
    return this.db;
  }

  begin(): void {
    this.conn.exec("BEGIN IMMEDIATE");
    this.conn.exec("DELETE FROM batch_keys");
  }

  commit(): void {
    this.conn.exec("COMMIT");
  }

  rollback(): void {
    this.conn.exec("ROLLBACK");
  }

  /** True when the key already exists in committed data. */
  hasKey(accountId: string, resourceId: string, usageDate: string): boolean {
    const stmt = this.conn.prepare(
      "SELECT 1 AS x FROM billing WHERE account_id = ? AND resource_id = ? AND usage_date = ? LIMIT 1",
    );
    return stmt.get(accountId, resourceId, usageDate) !== undefined;
  }

  /** Track a batch key; returns false when already seen this batch. */
  trackBatchKey(accountId: string, resourceId: string, usageDate: string): boolean {
    const stmt = this.conn.prepare(
      "INSERT OR IGNORE INTO batch_keys (account_id, resource_id, usage_date) VALUES (?, ?, ?)",
    );
    const result = stmt.run(accountId, resourceId, usageDate);
    return Number(result.changes) === 1;
  }

  /** Insert one committed record (inside the current transaction). */
  insert(
    accountId: string,
    row: {
      resourceId: string;
      usageDate: string;
      quantity: string;
      unitCost: string;
      totalCost: string;
    },
  ): void {
    const stmt = this.conn.prepare(
      "INSERT INTO billing (account_id, resource_id, usage_date, quantity, unit_cost, total_cost) VALUES (?, ?, ?, ?, ?, ?)",
    );
    stmt.run(accountId, row.resourceId, row.usageDate, row.quantity, row.unitCost, row.totalCost);
  }

  /** Iterate committed records for an account in insertion order. */
  *readAll(accountId: string): Generator<BillingRecord> {
    const stmt = this.conn.prepare(
      "SELECT resource_id, usage_date, quantity, unit_cost, total_cost, seq FROM billing WHERE account_id = ? AND seq > ? ORDER BY seq LIMIT ?",
    );
    let lastSeq = 0;
    for (;;) {
      const page = stmt.all(accountId, lastSeq, READ_PAGE_SIZE) as unknown as BillingRow[];
      if (page.length === 0) return;
      for (const row of page) {
        lastSeq = row.seq;
        yield {
          resourceId: row.resource_id,
          usageDate: row.usage_date,
          quantity: row.quantity,
          unitCost: row.unit_cost,
          totalCost: row.total_cost,
        };
      }
    }
  }
}
