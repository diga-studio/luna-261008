import { DatabaseSync } from "node:sqlite";
import type { MessageRecord } from "./types.js";

interface MessageRow {
  conversation_id: string;
  seq: number;
  message_id: string;
  text: string;
  acked: number;
}

function toRecord(row: MessageRow): MessageRecord {
  return {
    conversationId: row.conversation_id,
    seq: row.seq,
    messageId: row.message_id,
    text: row.text,
    acked: row.acked !== 0,
  };
}

/**
 * SQLite-backed persistence for messages and acknowledgements.
 * Synchronous (node:sqlite DatabaseSync); transactions never span
 * a deliver() call, so re-entrant library calls from inside deliver
 * see and mutate committed state immediately.
 */
export class MessageStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        conversation_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        message_id TEXT NOT NULL,
        text TEXT NOT NULL,
        acked INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (conversation_id, seq)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS messages_conversation_message
        ON messages (conversation_id, message_id);
    `);
  }

  /**
   * Persist a new message, or return the existing record when the same
   * messageId + text was already accepted for this conversation.
   * Throws when messageId exists with different text.
   */
  enqueue(conversationId: string, messageId: string, text: string): MessageRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare(
          "SELECT * FROM messages WHERE conversation_id = ? AND message_id = ?"
        )
        .get(conversationId, messageId) as MessageRow | undefined;
      if (existing !== undefined) {
        if (existing.text !== text) {
          throw new Error(
            `messageId ${JSON.stringify(messageId)} already used in conversation ` +
              `${JSON.stringify(conversationId)} with different text`
          );
        }
        const record = toRecord(existing);
        this.db.exec("COMMIT");
        return record;
      }
      const seqRow = this.db
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM messages WHERE conversation_id = ?"
        )
        .get(conversationId) as { next_seq: number };
      const seq = seqRow.next_seq;
      this.db
        .prepare(
          "INSERT INTO messages (conversation_id, seq, message_id, text, acked) VALUES (?, ?, ?, ?, 0)"
        )
        .run(conversationId, seq, messageId, text);
      this.db.exec("COMMIT");
      return { conversationId, seq, messageId, text, acked: false };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw err;
    }
  }

  /** Idempotently mark one message (conversationId, seq) as acknowledged. */
  acknowledge(conversationId: string, seq: number): void {
    this.db
      .prepare("UPDATE messages SET acked = 1 WHERE conversation_id = ? AND seq = ?")
      .run(conversationId, seq);
  }

  /** Load all messages of a conversation, ordered by seq. */
  loadConversation(conversationId: string): MessageRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC")
      .all(conversationId) as unknown as MessageRow[];
    return rows.map(toRecord);
  }

  /** List all known conversation ids. */
  listConversations(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT conversation_id FROM messages")
      .all() as unknown as Array<{ conversation_id: string }>;
    return rows.map((row) => row.conversation_id);
  }

  close(): void {
    this.db.close();
  }
}
