/** 一条不可变历史记录（同意凭证或审计事件）。 */
export interface HistoryRecord {
  /** 租户内唯一的记录编号。 */
  recordId: string;
  /** 记录时间（ISO 8601 字符串，按字典序可比较）。 */
  recordedAt: string;
  /** 提交时使用的来源账号编号，合并后保持不变。 */
  sourceAccountId: string;
  /** 正文内容。 */
  body: string;
}

/** 追加历史时的输入。 */
export interface AppendHistoryInput {
  tenantId: string;
  accountId: string;
  recordId: string;
  recordedAt: string;
  body: string;
}

/** 分页读取结果。 */
export interface HistoryPage {
  records: HistoryRecord[];
  /** 还有更多页时返回的游标，否则为 null。 */
  nextCursor: string | null;
}
