import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.js";
import type { AppendHistoryInput, HistoryPage, HistoryRecord } from "./types.js";

export interface AccountMergeStoreOptions {
  /** SQLite 文件路径。 */
  filename: string;
}

export class UnknownAccountError extends Error {}
export class DuplicateRecordError extends Error {}

interface Cursor {
  recordedAt: string;
  recordId: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string): Cursor {
  const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Cursor).recordedAt !== "string" ||
    typeof (parsed as Cursor).recordId !== "string"
  ) {
    throw new Error("invalid cursor");
  }
  return parsed as Cursor;
}

/**
 * 客户账号合并库。账号、合并关系与历史记录持久化到 SQLite。
 */
export class AccountMergeStore {
  private readonly db: DatabaseSync;

  constructor(options: AccountMergeStoreOptions) {
    this.db = openDatabase(options.filename);
  }

  /** 在租户内建立账号；已存在则无效果成功。 */
  createAccount(tenantId: string, accountId: string): void {
    const existing = this.findGroupId(tenantId, accountId);
    if (existing !== null) {
      return;
    }
    this.db
      .prepare("INSERT INTO groups (tenant_id, group_id) VALUES (?, ?)")
      .run(tenantId, accountId);
    this.db
      .prepare("INSERT INTO accounts (tenant_id, account_id, group_id) VALUES (?, ?, ?)")
      .run(tenantId, accountId, accountId);
  }

  /** 向账号（可为旧编号）追加一条历史记录。 */
  appendHistory(input: AppendHistoryInput): HistoryRecord {
    const groupId = this.requireGroupId(input.tenantId, input.accountId);
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO history
           (tenant_id, record_id, recorded_at, source_account_id, group_id, body)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.tenantId,
        input.recordId,
        input.recordedAt,
        input.accountId,
        groupId,
        input.body,
      );
    if (Number(result.changes) === 0) {
      throw new DuplicateRecordError(
        `record ${input.recordId} already exists in tenant ${input.tenantId}`,
      );
    }
    return {
      recordId: input.recordId,
      recordedAt: input.recordedAt,
      sourceAccountId: input.accountId,
      body: input.body,
    };
  }

  /**
   * 合并账号：次方整组归入主方，保留主方当前主账号。
   * 已同组则无效果成功。
   */
  mergeAccounts(
    tenantId: string,
    primaryAccountId: string,
    secondaryAccountId: string,
  ): void {
    const primaryGroupId = this.requireGroupId(tenantId, primaryAccountId);
    const secondaryGroupId = this.requireGroupId(tenantId, secondaryAccountId);
    if (primaryGroupId === secondaryGroupId) {
      return;
    }
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "UPDATE accounts SET group_id = ? WHERE tenant_id = ? AND group_id = ?",
        )
        .run(primaryGroupId, tenantId, secondaryGroupId);
      this.db
        .prepare(
          "UPDATE history SET group_id = ? WHERE tenant_id = ? AND group_id = ?",
        )
        .run(primaryGroupId, tenantId, secondaryGroupId);
      this.db
        .prepare("DELETE FROM groups WHERE tenant_id = ? AND group_id = ?")
        .run(tenantId, secondaryGroupId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 解析编号当前归属的主账号。 */
  resolveAccount(tenantId: string, accountId: string): string {
    return this.requireGroupId(tenantId, accountId);
  }

  /** 分页读取账号组全部历史，按记录时间升序、同时刻按记录编号字典序。 */
  readHistory(
    tenantId: string,
    accountId: string,
    options?: { cursor?: string; limit?: number },
  ): HistoryPage {
    const groupId = this.requireGroupId(tenantId, accountId);
    const limit = options?.limit ?? 100;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("limit must be a positive integer");
    }
    const cursor = options?.cursor !== undefined ? decodeCursor(options.cursor) : null;
    const rows = cursor === null
      ? this.db
          .prepare(
            `SELECT record_id, recorded_at, source_account_id, body
               FROM history
              WHERE tenant_id = ? AND group_id = ?
              ORDER BY recorded_at ASC, record_id ASC
              LIMIT ?`,
          )
          .all(tenantId, groupId, limit + 1)
      : this.db
          .prepare(
            `SELECT record_id, recorded_at, source_account_id, body
               FROM history
              WHERE tenant_id = ? AND group_id = ?
                AND (recorded_at > ? OR (recorded_at = ? AND record_id > ?))
              ORDER BY recorded_at ASC, record_id ASC
              LIMIT ?`,
          )
          .all(tenantId, groupId, cursor.recordedAt, cursor.recordedAt, cursor.recordId, limit + 1);
    const records: HistoryRecord[] = rows.slice(0, limit).map((row) => ({
      recordId: row["record_id"] as string,
      recordedAt: row["recorded_at"] as string,
      sourceAccountId: row["source_account_id"] as string,
      body: row["body"] as string,
    }));
    let nextCursor: string | null = null;
    if (rows.length > limit) {
      const last = records[records.length - 1];
      if (last !== undefined) {
        nextCursor = encodeCursor({ recordedAt: last.recordedAt, recordId: last.recordId });
      }
    }
    return { records, nextCursor };
  }

  /** 关闭数据库连接。 */
  close(): void {
    this.db.close();
  }

  private findGroupId(tenantId: string, accountId: string): string | null {
    const row = this.db
      .prepare("SELECT group_id FROM accounts WHERE tenant_id = ? AND account_id = ?")
      .get(tenantId, accountId);
    return row === undefined ? null : (row["group_id"] as string);
  }

  private requireGroupId(tenantId: string, accountId: string): string {
    const groupId = this.findGroupId(tenantId, accountId);
    if (groupId === null) {
      throw new UnknownAccountError(
        `unknown account ${accountId} in tenant ${tenantId}`,
      );
    }
    return groupId;
  }
}
