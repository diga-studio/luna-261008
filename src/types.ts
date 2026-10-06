/** 租户内唯一的账号编号。 */
export type AccountId = string;

/** 租户内唯一的历史记录编号。 */
export type RecordId = string;

/** 一条不可变的历史记录（同意凭证或审计事件）。 */
export interface HistoryRecord {
  /** 租户内唯一的记录编号。 */
  recordId: RecordId;
  /** 记录时间（ISO 8601 字符串）。 */
  recordedAt: string;
  /** 提交时使用的来源账号编号，不随后续合并改变。 */
  sourceAccountId: AccountId;
  /** 正文。 */
  body: string;
}

/** 分页读取结果。 */
export interface HistoryPage {
  records: HistoryRecord[];
  /** 还有更多页时返回的游标；否则为 null。 */
  nextCursor: string | null;
}
