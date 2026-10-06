import { DatabaseSync } from 'node:sqlite';
import type { BillingRecord } from './types.js';

export interface BillingKey {
  accountId: string;
  resourceId: string;
  usageDate: string;
}

interface BillingRow {
  account_id: string;
  resource_id: string;
  usage_date: string;
  usage_quantity: string;
  unit_cost: string;
  total_cost: string;
}

/**
 * SQLite persistence. Amounts are stored as TEXT exactly as they appeared
 * in the source CSV so reads are bit-exact. Deduplication is enforced by
 * the primary key plus a per-import TEMP table of batch keys, so memory
 * stays flat regardless of input size.
 */
export class BillingStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS billing (
        account_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        usage_date TEXT NOT NULL,
        usage_quantity TEXT NOT NULL,
        unit_cost TEXT NOT NULL,
        total_cost TEXT NOT NULL,
        PRIMARY KEY (account_id, resource_id, usage_date)
      );
      CREATE TEMP TABLE IF NOT EXISTS batch_keys (
        account_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        usage_date TEXT NOT NULL,
        PRIMARY KEY (account_id, resource_id, usage_date)
      );
    `);
  }

  beginImport(): void {
    this.db.exec('DELETE FROM batch_keys');
    this.db.exec('BEGIN IMMEDIATE');
  }

  /** Key already committed or seen earlier in this batch. */
  hasKey(key: BillingKey): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS found FROM billing
           WHERE account_id = ? AND resource_id = ? AND usage_date = ?
         UNION ALL
         SELECT 1 FROM batch_keys
           WHERE account_id = ? AND resource_id = ? AND usage_date = ?
         LIMIT 1`,
      )
      .get(key.accountId, key.resourceId, key.usageDate,
           key.accountId, key.resourceId, key.usageDate);
    return row !== undefined;
  }

  /** Register a batch key (valid key, regardless of other row errors). */
  addBatchKey(key: BillingKey): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO batch_keys (account_id, resource_id, usage_date) VALUES (?, ?, ?)',
      )
      .run(key.accountId, key.resourceId, key.usageDate);
  }

  insertBilling(key: BillingKey, record: BillingRecord): void {
    this.db
      .prepare(
        `INSERT INTO billing
           (account_id, resource_id, usage_date, usage_quantity, unit_cost, total_cost)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        key.accountId,
        key.resourceId,
        key.usageDate,
        record.usageQuantity,
        record.unitCost,
        record.totalCost,
      );
  }

  commitImport(): void {
    this.db.exec('COMMIT');
    this.db.exec('DELETE FROM batch_keys');
  }

  rollbackImport(): void {
    this.db.exec('ROLLBACK');
    this.db.exec('DELETE FROM batch_keys');
  }

  async *readBilling(accountId: string): AsyncIterable<BillingRecord> {
    const stmt = this.db.prepare(
      `SELECT resource_id, usage_date, usage_quantity, unit_cost, total_cost
         FROM billing WHERE account_id = ? ORDER BY rowid`,
    );
    for (const raw of stmt.iterate(accountId)) {
      const row = raw as Omit<BillingRow, 'account_id'>;
      yield {
        resourceId: row.resource_id,
        usageDate: row.usage_date,
        usageQuantity: row.usage_quantity,
        unitCost: row.unit_cost,
        totalCost: row.total_cost,
      };
    }
  }

  close(): void {
    this.db.close();
  }
}
