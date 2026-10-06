import {
  MAX_ATTEMPTS_PER_ONLINE_PERIOD,
  RETRY_INTERVAL_MS,
  type DeliverFn,
  type MessageRecord,
} from "./types.js";

interface MessageState {
  record: MessageRecord;
  /** Attempts initiated during the current online period. */
  attemptsUsed: number;
  /** Earliest caller-time at which the next attempt may be initiated. */
  nextAttemptAt: number;
  /** Token of the currently in-flight attempt, or null. */
  inFlightToken: number | null;
}

/**
 * In-memory delivery state for one conversation: online flag plus
 * per-message attempt bookkeeping for the current online period.
 * Attempt state is intentionally not persisted; a fresh library
 * instance starts offline and grants a new quota on the next
 * offline->online transition.
 */
export class ConversationSession {
  private readonly conversationId: string;
  private readonly deliver: DeliverFn;
  private readonly messages = new Map<number, MessageState>();
  private isOnline = false;
  private nextToken = 0;

  constructor(conversationId: string, messages: MessageRecord[], deliver: DeliverFn) {
    this.conversationId = conversationId;
    this.deliver = deliver;
    for (const record of messages) {
      this.messages.set(record.seq, ConversationSession.freshState(record));
    }
  }

  private static freshState(record: MessageRecord): MessageState {
    return { record, attemptsUsed: 0, nextAttemptAt: 0, inFlightToken: null };
  }

  get online(): boolean {
    return this.isOnline;
  }

  /** Add a freshly persisted message to the in-memory view. */
  addMessage(record: MessageRecord): void {
    if (this.messages.has(record.seq)) return;
    this.messages.set(record.seq, ConversationSession.freshState(record));
  }

  /** Mark a message acknowledged in memory (idempotent, late-ACK safe). */
  markAcked(seq: number): void {
    const state = this.messages.get(seq);
    if (state !== undefined) {
      state.record.acked = true;
    }
  }

  /**
   * Set connectivity. A real offline->online transition grants every
   * unacknowledged message a fresh attempt quota; repeated sets of the
   * same state are no-ops. In-flight calls from a previous online
   * period are forgotten: their late completion must not touch the
   * new period's quota or schedule.
   */
  setOnline(online: boolean): void {
    if (online === this.isOnline) return;
    this.isOnline = online;
    if (online) {
      for (const state of this.messages.values()) {
        if (state.record.acked) continue;
        state.attemptsUsed = 0;
        state.nextAttemptAt = 0;
        state.inFlightToken = null;
      }
    }
  }

  /**
   * Initiate due attempts for this conversation at time `now`.
   * Never blocks on deliver(); safe to call while previous deliver
   * promises are still pending. Re-entrant calls (from deliver
   * synchronously calling back into the library) are safe: every
   * candidate is re-validated right before its attempt starts.
   */
  pump(now: number): void {
    if (!this.isOnline) return;
    const candidates = [...this.messages.values()];
    for (const state of candidates) {
      if (!this.isOnline) return;
      if (state.record.acked) continue;
      if (state.inFlightToken !== null) continue;
      if (state.attemptsUsed >= MAX_ATTEMPTS_PER_ONLINE_PERIOD) continue;
      if (state.nextAttemptAt > now) continue;
      this.initiateAttempt(state, now);
    }
  }

  private initiateAttempt(state: MessageState, now: number): void {
    const token = ++this.nextToken;
    state.inFlightToken = token;
    state.attemptsUsed += 1;
    state.nextAttemptAt = now + RETRY_INTERVAL_MS;
    const { seq, messageId, text } = state.record;
    let promise: Promise<unknown>;
    try {
      promise = this.deliver(this.conversationId, seq, messageId, text);
    } catch {
      // Synchronous throw counts as a failed attempt (quota already spent).
      if (state.inFlightToken === token) state.inFlightToken = null;
      return;
    }
    const onSettled = (): void => {
      // Stale completions (token replaced by a reconnect) change nothing.
      if (state.inFlightToken === token) state.inFlightToken = null;
    };
    promise.then(onSettled, onSettled);
  }
}
