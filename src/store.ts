import { DatabaseSync } from "node:sqlite";
import type { AccountId, HistoryRecord, RecordId } from "./types.js";

export interface StoredHistoryRow {
  recordId: RecordId;
  recordedAt: string;
  sortTs: number;
  sourceAccountId: AccountId;
  body: string;
}

/**
 * SQLite 持久化层。
 *
 * accounts: 每个曾创建的账号编号永远保留一行，group_id 指向当前所属账号组的主账号。
 * history:  历史记录挂在追加时所属的账号组上；合并时仅改挂 group_id，记录内容不变。
 */
export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        tenant_id  TEXT NOT NULL,
        account_id TEXT NOT NULL,
        group_id   TEXT NOT NULL,
        PRIMARY KEY (tenant_id, account_id)
      );
      CREATE TABLE IF NOT EXISTS history (
        tenant_id         TEXT NOT NULL,
        record_id         TEXT NOT NULL,
        recorded_at       TEXT NOT NULL,
        sort_ts           REAL NOT NULL,
        source_account_id TEXT NOT NULL,
        body              TEXT NOT NULL,
        group_id          TEXT NOT NULL,
        PRIMARY KEY (tenant_id, record_id)
      );
      CREATE INDEX IF NOT EXISTS idx_history_group
        ON history (tenant_id, group_id, sort_ts, record_id);
      CREATE INDEX IF NOT EXISTS idx_accounts_group
        ON accounts (tenant_id, group_id);
    `);
  }

  close(): void {
    this.db.close();
  }

  createAccount(tenantId: string, accountId: AccountId): void {
    try {
      this.db
        .prepare(
          "INSERT INTO accounts (tenant_id, account_id, group_id) VALUES (?, ?, ?)",
        )
        .run(tenantId, accountId, accountId);
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE")) {
        throw new Error(
          `account already exists: tenant=${tenantId} account=${accountId}`,
        );
      }
      throw err;
    }
  }

  /** 返回账号当前所属账号组的主账号；账号不存在时返回 null。 */
  getGroupId(tenantId: string, accountId: AccountId): AccountId | null {
    const row = this.db
      .prepare(
        "SELECT group_id FROM accounts WHERE tenant_id = ? AND account_id = ?",
      )
      .get(tenantId, accountId) as { group_id: string } | undefined;
    return row === undefined ? null : row.group_id;
  }

  /** 把 fromGroup 整组（账号归属 + 历史归属）并入 toGroup。 */
  reassignGroup(tenantId: string, fromGroupId: AccountId, toGroupId: AccountId): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "UPDATE accounts SET group_id = ? WHERE tenant_id = ? AND group_id = ?",
        )
        .run(toGroupId, tenantId, fromGroupId);
      this.db
        .prepare(
          "UPDATE history SET group_id = ? WHERE tenant_id = ? AND group_id = ?",
        )
        .run(toGroupId, tenantId, fromGroupId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  appendHistory(
    tenantId: string,
    groupId: AccountId,
    record: HistoryRecord,
    sortTs: number,
  ): void {
    try {
      this.db
        .prepare(
          `INSERT INTO history
             (tenant_id, record_id, recorded_at, sort_ts, source_account_id, body, group_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          tenantId,
          record.recordId,
          record.recordedAt,
          sortTs,
          record.sourceAccountId,
          record.body,
          groupId,
        );
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE")) {
        throw new Error(
          `history record already exists: tenant=${tenantId} record=${record.recordId}`,
        );
      }
      throw err;
    }
  }

  /**
   * 按 (sort_ts, record_id) 升序读取一页；after 为上一页最后一条的位置。
   */
  readHistoryPage(
    tenantId: string,
    groupId: AccountId,
    after: { sortTs: number; recordId: RecordId } | null,
    limit: number,
  ): StoredHistoryRow[] {
    const rows = (
      after === null
        ? this.db
            .prepare(
              `SELECT record_id, recorded_at, sort_ts, source_account_id, body
                 FROM history
                WHERE tenant_id = ? AND group_id = ?
                ORDER BY sort_ts ASC, record_id ASC
                LIMIT ?`,
            )
            .all(tenantId, groupId, limit)
        : this.db
            .prepare(
              `SELECT record_id, recorded_at, sort_ts, source_account_id, body
                 FROM history
                WHERE tenant_id = ? AND group_id = ?
                  AND (sort_ts > ? OR (sort_ts = ? AND record_id > ?))
                ORDER BY sort_ts ASC, record_id ASC
                LIMIT ?`,
            )
            .all(tenantId, groupId, after.sortTs, after.sortTs, after.recordId, limit)
    ) as Array<{
      record_id: string;
      recorded_at: string;
      sort_ts: number;
      source_account_id: string;
      body: string;
    }>;
    return rows.map((row) => ({
      recordId: row.record_id,
      recordedAt: row.recorded_at,
      sortTs: row.sort_ts,
      sourceAccountId: row.source_account_id,
      body: row.body,
    }));
  }
}
