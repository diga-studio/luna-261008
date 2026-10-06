/** 一条解析出的 CSV 数据记录（原始字段，未归一）。 */
export interface CsvRecord {
  /** 从 1 开始的数据记录序号（不含表头）。 */
  index: number;
  fields: string[];
}

/** 可继续处理的记录级错误。 */
export interface RecordError {
  /** 从 1 开始的数据记录序号（不含表头）。 */
  recordIndex: number;
  reason: string;
}

export type ImportStatus = 'ok' | 'rejected' | 'failed';

export interface ImportResult {
  status: ImportStatus;
  /** 数据记录总数（含错误记录与重复记录，不含表头）。 */
  totalRecords: number;
  /** 错误记录数。 */
  errorRecords: number;
  /** 实际写入（新增或替换）的记录数；失败/拒绝时为 0。 */
  imported: number;
  errors: RecordError[];
  /** 整批失败时的原因。 */
  failureReason?: string;
}

/** 读取出来的一条评论（完整原始字段）。 */
export interface Review {
  channel: string;
  reviewerName: string;
  text: string;
  /** 原始 timestamp 字符串。 */
  timestamp: string;
}
