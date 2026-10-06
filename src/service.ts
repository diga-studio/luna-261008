import { Store } from "./store.js";
import type { AccountId, HistoryPage, HistoryRecord, RecordId } from "./types.js";

export interface AppendHistoryInput {
  tenantId: string;
  /** 提交时使用的账号编号，可以是已合并的旧编号。 */
  accountId: AccountId;
  /** 租户内唯一的记录编号。 */
  recordId: RecordId;
  /** 记录时间，需可被 Date.parse 解析（推荐 ISO 8601）。 */
  recordedAt: string;
  body: string;
}

export interface MergeResult {
  /** 合并后（或已同组时）的主账号。 */
  primaryAccountId: AccountId;
  /** 本次是否发生了实际合并；已同组时为 false。 */
  merged: boolean;
}

/** 客户账号合并服务，由上层业务直接调用。 */
export class AccountMergeService {
  private store: Store;

  constructor(dbPath: string) {
    this.store = new Store(dbPath);
  }

  close(): void {
    this.store.close();
  }

  createAccount(tenantId: string, accountId: AccountId): void {
    this.store.createAccount(tenantId, accountId);
  }

  appendHistory(input: AppendHistoryInput): void {
    const groupId = this.store.getGroupId(input.tenantId, input.accountId);
    if (groupId === null) {
      throw new Error(
        `unknown account: tenant=${input.tenantId} account=${input.accountId}`,
      );
    }
    const sortTs = Date.parse(input.recordedAt);
    if (Number.isNaN(sortTs)) {
      throw new Error(`invalid recordedAt: ${input.recordedAt}`);
    }
    const record: HistoryRecord = {
      recordId: input.recordId,
      recordedAt: input.recordedAt,
      sourceAccountId: input.accountId,
      body: input.body,
    };
    this.store.appendHistory(input.tenantId, groupId, record, sortTs);
  }

  mergeAccounts(
    tenantId: string,
    primaryAccountId: AccountId,
    secondaryAccountId: AccountId,
  ): MergeResult {
    const primaryGroup = this.store.getGroupId(tenantId, primaryAccountId);
    if (primaryGroup === null) {
      throw new Error(
        `unknown account: tenant=${tenantId} account=${primaryAccountId}`,
      );
    }
    const secondaryGroup = this.store.getGroupId(tenantId, secondaryAccountId);
    if (secondaryGroup === null) {
      throw new Error(
        `unknown account: tenant=${tenantId} account=${secondaryAccountId}`,
      );
    }
    if (primaryGroup === secondaryGroup) {
      return { primaryAccountId: primaryGroup, merged: false };
    }
    this.store.reassignGroup(tenantId, secondaryGroup, primaryGroup);
    return { primaryAccountId: primaryGroup, merged: true };
  }

  /** 把任意（含已合并的旧）账号编号解析为当前主账号。 */
  resolveAccount(tenantId: string, accountId: AccountId): AccountId {
    const groupId = this.store.getGroupId(tenantId, accountId);
    if (groupId === null) {
      throw new Error(
        `unknown account: tenant=${tenantId} account=${accountId}`,
      );
    }
    return groupId;
  }

  readHistory(
    tenantId: string,
    accountId: AccountId,
    cursor: string | null,
    limit: number,
  ): HistoryPage {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`limit must be a positive integer, got ${limit}`);
    }
    const groupId = this.store.getGroupId(tenantId, accountId);
    if (groupId === null) {
      throw new Error(
        `unknown account: tenant=${tenantId} account=${accountId}`,
      );
    }
    const after = cursor === null ? null : decodeCursor(cursor);
    const rows = this.store.readHistoryPage(tenantId, groupId, after, limit + 1);
    const pageRows = rows.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      rows.length > limit && last !== undefined
        ? encodeCursor(last.sortTs, last.recordId)
        : null;
    return {
      records: pageRows.map((row) => ({
        recordId: row.recordId,
        recordedAt: row.recordedAt,
        sourceAccountId: row.sourceAccountId,
        body: row.body,
      })),
      nextCursor,
    };
  }
}

interface CursorPayload {
  sortTs: number;
  recordId: RecordId;
}

function encodeCursor(sortTs: number, recordId: RecordId): string {
  const payload: CursorPayload = { sortTs, recordId };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid cursor");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as CursorPayload).sortTs !== "number" ||
    typeof (parsed as CursorPayload).recordId !== "string"
  ) {
    throw new Error("invalid cursor");
  }
  return parsed as CursorPayload;
}
