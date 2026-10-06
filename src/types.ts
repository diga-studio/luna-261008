/** 一条关键词规则：id 唯一，needle 非空，weight 为正整数。 */
export interface Rule {
  id: string;
  needle: string;
  weight: number;
}

/** finish() 的返回结果。 */
export interface ScanResult {
  hitIds: string[];
  score: number;
  quarantined: boolean;
}

/** 单封邮件的流式扫描器。 */
export interface Scanner {
  /** 输入任意大小的字节块，返回本次新命中的规则 id。 */
  write(bytes: Uint8Array): string[];
  /** 结束输入，返回汇总结果；未闭合的 multipart 会抛错。 */
  finish(): ScanResult;
}
