import { DatabaseSync } from "node:sqlite";
import { MessageRow } from "./types";

interface RawRow {
  conversation_id: string;
  seq: number;
  message_id: string;
  text: string;
  acked: number;
  attempts: number;
  next_attempt_at: number | null;
}

function toMessageRow(row: RawRow): MessageRow {
  return {
    conversationId: row.conversation_id,
    seq: row.seq,
    messageId: row.message_id,
    text: row.text,
    acked: row.acked !== 0,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
  };
}

/**
 * SQLite 持久化层。所有方法均为同步；
 * 事务只包裹纯数据库操作，绝不跨越 deliver 调用。
 */
export class Store {
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
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        PRIMARY KEY (conversation_id, seq)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_message_id
        ON messages (conversation_id, message_id);
    `);
  }

  /**
   * 幂等插入：seq 为会话内 MAX(seq)+1（从 1 开始连续递增）。
   * messageId 已存在时：文本一致返回原 seq，不一致抛错。
   */
  insertMessage(conversationId: string, messageId: string, text: string): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare(
          "SELECT seq, text FROM messages WHERE conversation_id = ? AND message_id = ?"
        )
        .get(conversationId, messageId) as { seq: number; text: string } | undefined;
      if (existing !== undefined) {
        if (existing.text !== text) {
          throw new Error(
            `messageId ${messageId} already exists in conversation ${conversationId} with different text`
          );
        }
        this.db.exec("COMMIT");
        return existing.seq;
      }
      const maxSeq = (
        this.db
          .prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM messages WHERE conversation_id = ?")
          .get(conversationId) as { max_seq: number }
      ).max_seq;
      const seq = maxSeq + 1;
      this.db
        .prepare(
          "INSERT INTO messages (conversation_id, seq, message_id, text) VALUES (?, ?, ?, ?)"
        )
        .run(conversationId, seq, messageId, text);
      this.db.exec("COMMIT");
      return seq;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // 已经提交则忽略
      }
      throw err;
    }
  }

  /** 幂等确认单条消息；不存在的消息静默忽略。 */
  ack(conversationId: string, seq: number): void {
    this.db
      .prepare("UPDATE messages SET acked = 1 WHERE conversation_id = ? AND seq = ?")
      .run(conversationId, seq);
  }

  isAcked(conversationId: string, seq: number): boolean {
    const row = this.db
      .prepare("SELECT acked FROM messages WHERE conversation_id = ? AND seq = ?")
      .get(conversationId, seq) as { acked: number } | undefined;
    return row !== undefined && row.acked !== 0;
  }

  /**
   * 当前可发起投递的未确认消息，按 seq 升序：
   * 首次投递（attempts = 0），或额度内且已到期的重试。
   */
  eligibleMessages(conversationId: string, now: number, maxAttempts: number): MessageRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE conversation_id = ? AND acked = 0
           AND (attempts = 0 OR (attempts < ? AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?))
         ORDER BY seq ASC`
      )
      .all(conversationId, maxAttempts, now) as unknown as RawRow[];
    return rows.map(toMessageRow);
  }

  /** 在发起 deliver 之前记录一次尝试（自增 attempts、清空排定重试）。 */
  markAttempt(conversationId: string, seq: number): void {
    this.db
      .prepare(
        "UPDATE messages SET attempts = attempts + 1, next_attempt_at = NULL WHERE conversation_id = ? AND seq = ?"
      )
      .run(conversationId, seq);
  }

  /** 单条消息当前是否仍可发起投递（与 eligibleMessages 同一判定）。 */
  isEligible(conversationId: string, seq: number, now: number, maxAttempts: number): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS ok FROM messages
         WHERE conversation_id = ? AND seq = ? AND acked = 0
           AND (attempts = 0 OR (attempts < ? AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?))`
      )
      .get(conversationId, seq, maxAttempts, now) as { ok: number } | undefined;
    return row !== undefined;
  }

  /** 投递失败后排定下一次重试时间；已确认或额度耗尽时不排定。 */
  scheduleRetry(conversationId: string, seq: number, nextAttemptAt: number, maxAttempts: number): void {
    this.db
      .prepare(
        "UPDATE messages SET next_attempt_at = ? WHERE conversation_id = ? AND seq = ? AND acked = 0 AND attempts < ?"
      )
      .run(nextAttemptAt, conversationId, seq, maxAttempts);
  }

  /** 离线->在线切换：重置该会话所有未确认消息的投递额度。 */
  resetQuota(conversationId: string): void {
    this.db
      .prepare(
        "UPDATE messages SET attempts = 0, next_attempt_at = NULL WHERE conversation_id = ? AND acked = 0"
      )
      .run(conversationId);
  }

  close(): void {
    this.db.close();
  }
}
