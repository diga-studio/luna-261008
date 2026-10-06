/** 一条解析出的原始 CSV 记录（未校验）。 */
export interface RawRecord {
  /** 数据记录序号，从 1 开始（不含表头）。 */
  recordIndex: number;
  fields: string[];
}

/** 校验并归一化后的有效记录。 */
export interface ValidRecord {
  /** 原始字段，原样保存（未做 trim/NFC）。 */
  raw: { channel: string; reviewerName: string; text: string; timestamp: string };
  /** 归一化后的去重键组成部分。 */
  key: { channel: string; reviewerName: string; timestampMs: number };
}

/** 可继续处理的记录级错误。 */
export interface RecordError {
  recordIndex: number;
  reason: string;
}

export type ImportStatus =
  | 'imported' // 成功提交（可能跳过了 <=15% 的错误记录）
  | 'rejected' // 错误率超过 15%，整批拒绝，数据不变
  | 'failed'; // 整批失败（非法 UTF-8 / 表头不符 / 引号结构错误），数据不变

export interface ImportResult {
  status: ImportStatus;
  /** 全部数据记录数（含错误与重复）。 */
  totalRecords: number;
  errorRecords: number;
  errors: RecordError[];
  /** 实际写入（新增或替换）的记录数；failed/rejected 时为 0。 */
  upserted: number;
  /** 整批失败时的原因。 */
  fatalError?: string;
}

/** 读取评论时返回的记录（完整原始字段）。 */
export interface StoredReview {
  channel: string;
  reviewerName: string;
  text: string;
  timestamp: string;
  timestampMs: number;
}
