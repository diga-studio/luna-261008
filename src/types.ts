/**
 * Injected by the caller. Performs the actual delivery of one message.
 * May stay pending for a long time, may reject, and may synchronously
 * re-enter the library (e.g. call acknowledge) before returning.
 */
export type DeliverFn = (
  conversationId: string,
  seq: number,
  messageId: string,
  text: string
) => Promise<unknown>;

/** A persisted message row. */
export interface MessageRecord {
  conversationId: string;
  seq: number;
  messageId: string;
  text: string;
  acked: boolean;
}

/** Maximum delivery attempts per online period: 1 first try + 3 retries. */
export const MAX_ATTEMPTS_PER_ONLINE_PERIOD = 4;

/** Minimum gap between consecutive attempt initiations, in milliseconds. */
export const RETRY_INTERVAL_MS = 5000;
