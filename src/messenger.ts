import { ConversationSession } from "./session.js";
import { MessageStore } from "./store.js";
import type { DeliverFn } from "./types.js";

/**
 * Public entry point. Persists messages in SQLite and drives delivery
 * attempts via the injected deliver function.
 *
 * All mutating operations are synchronous with respect to the database;
 * deliver() is the only async boundary and no SQLite transaction ever
 * spans it. There is no global queue: one conversation's slow delivery
 * never blocks another conversation.
 */
export class Messenger {
  private readonly store: MessageStore;
  private readonly deliver: DeliverFn;
  private readonly sessions = new Map<string, ConversationSession>();

  constructor(dbPath: string, deliver: DeliverFn) {
    this.store = new MessageStore(dbPath);
    this.deliver = deliver;
  }

  /** Persist a message and return its per-conversation seq (from 1, gapless). */
  enqueue(conversationId: string, messageId: string, text: string): number {
    const record = this.store.enqueue(conversationId, messageId, text);
    this.sessionFor(conversationId).addMessage(record);
    return record.seq;
  }

  /** Set receiver connectivity for a conversation (initially offline). */
  setOnline(conversationId: string, online: boolean): void {
    this.sessionFor(conversationId).setOnline(online);
  }

  /** Acknowledge exactly one message by seq. Idempotent and late-ACK safe. */
  acknowledge(conversationId: string, seq: number): void {
    this.store.acknowledge(conversationId, seq);
    this.sessionFor(conversationId).markAcked(seq);
  }

  /** Run due delivery attempts. `now` is caller-supplied, non-decreasing ms. */
  pump(now: number): void {
    for (const session of [...this.sessions.values()]) {
      session.pump(now);
    }
  }

  close(): void {
    this.store.close();
  }

  private sessionFor(conversationId: string): ConversationSession {
    let session = this.sessions.get(conversationId);
    if (session === undefined) {
      session = new ConversationSession(
        conversationId,
        this.store.loadConversation(conversationId),
        this.deliver
      );
      this.sessions.set(conversationId, session);
    }
    return session;
  }
}
