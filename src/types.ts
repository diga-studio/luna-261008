/**
 * 投递函数，由调用方注入。
 * 返回 Promise；可能长时间不结束、失败，或在返回 Promise 前同步重入库的其他操作。
 * deliver 完成不代表接收方确认，只有 acknowledge 能确认。
 */
export type DeliverFn = (
  conversationId: string,
  seq: number,
  messageId: string,
  text: string
) => Promise<unknown>;

/** 单条持久化消息的内部记录。 */
export interface MessageRow {
  conversationId: string;
  seq: number;
  messageId: string;
  text: string;
  acked: boolean;
  /** 当前在线期间内已发起的尝试次数（首次投递 + 重试）。 */
  attempts: number;
  /** 下一次允许发起重试的时间（毫秒），null 表示当前没有排定的重试。 */
  nextAttemptAt: number | null;
}

export const MAX_ATTEMPTS = 4; // 首次投递 + 最多 3 次重试
export const RETRY_INTERVAL_MS = 5000;
