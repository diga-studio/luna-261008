/** 破坏性操作类型。 */
export type OperationType = 'DROP_TABLE' | 'TRUNCATE' | 'DROP_COLUMN';

/** 一条命中记录。 */
export interface Hit {
  /** 操作类型。 */
  readonly operation: OperationType;
  /** 规范化后的表名（层级以 `.` 连接）。 */
  readonly table: string;
  /** 规范化后的表名层级（引号标识符内的点不拆分）。 */
  readonly tableParts: readonly string[];
  /** 删列命中时的列名。 */
  readonly column?: string;
  /** 破坏性关键字在事件内的原始 UTF-8 字节偏移（从 0 开始）。 */
  readonly offset: number;
}

/** 单个事件的处理结果。 */
export interface ScanResult {
  /** 所有确定命中，按出现顺序排列。 */
  readonly hits: Hit[];
  /**
   * 事件是否完整可判定。
   * 为 false 表示事件结束时字符串、引用标识符或块注释尚未闭合，
   * 此时未完成的语句不产生命中，已完整结束的语句命中仍有效。
   */
  readonly complete: boolean;
}
