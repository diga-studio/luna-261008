import { DatabaseSync } from 'node:sqlite';
import { AckMessage, AgentId, EventEnvelope, EventId, ReceiveResult, Seq } from './types';

const KEY_NEXT_SEQ = 'next_seq';
const KEY_ACK_WATERMARK = 'ack_watermark';

/**
 * 代理侧存储：本地接收事件、生成待补传批次、应用确认水位并清理正文。
 * 全部状态持久化在 SQLite（WAL + 事务），进程随时中断后重启可恢复。
 */
export class AgentStore {
  private readonly db: DatabaseSync;
  private readonly agentId: AgentId;

  constructor(dbPath: string, agentId: AgentId) {
    this.agentId = agentId;
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        payload BLOB
      );
    `);
    this.ensureMeta(KEY_NEXT_SEQ, '1');
    this.ensureMeta(KEY_ACK_WATERMARK, '0');
  }

  /**
   * 本地接收事件。同一 eventId 无论提交多少次都返回原序号；
   * 序号分配与写入在同一事务内完成，中断后原标识重试不会产生重复或缺口。
   */
  receiveEvent(eventId: EventId, payload: Buffer): ReceiveResult {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db
        .prepare('SELECT seq FROM events WHERE event_id = ?')
        .get(eventId) as { seq: number } | undefined;
      if (existing) {
        this.db.exec('COMMIT');
        return { eventId, seq: existing.seq, isNew: false };
      }
      const seq = Number(this.readMeta(KEY_NEXT_SEQ));
      this.db
        .prepare('INSERT INTO events (event_id, seq, payload) VALUES (?, ?, ?)')
        .run(eventId, seq, payload);
      this.writeMeta(KEY_NEXT_SEQ, String(seq + 1));
      this.db.exec('COMMIT');
      return { eventId, seq, isNew: true };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 当前已分配的最大序号（无事件时为 0）。 */
  lastSeq(): Seq {
    return Number(this.readMeta(KEY_NEXT_SEQ)) - 1;
  }

  /** 待补传事件：正文仍在（未被确认清理）的事件，按序号升序。 */
  pendingEvents(limit?: number): EventEnvelope[] {
    const watermark = this.ackWatermark();
    const sql =
      'SELECT event_id, seq, payload FROM events WHERE payload IS NOT NULL AND seq > ? ORDER BY seq ASC' +
      (limit !== undefined ? ' LIMIT ?' : '');
    const stmt = this.db.prepare(sql);
    const rows = (limit !== undefined ? stmt.all(watermark, limit) : stmt.all(watermark)) as Array<{
      event_id: string;
      seq: number;
      payload: Uint8Array;
    }>;
    return rows.map((row) => ({
      agentId: this.agentId,
      eventId: row.event_id,
      seq: row.seq,
      payload: Buffer.from(row.payload),
    }));
  }

  /**
   * 应用汇总侧回执。水位只增不减（过期回执自动忽略）；
   * 水位推进与正文清理在同一事务内完成，清理过程中断不会留下半清理状态。
   */
  applyAck(ack: AckMessage): void {
    if (ack.agentId !== this.agentId) {
      return;
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = Number(this.readMeta(KEY_ACK_WATERMARK));
      if (ack.watermark > current) {
        this.writeMeta(KEY_ACK_WATERMARK, String(ack.watermark));
        this.db
          .prepare('UPDATE events SET payload = NULL WHERE seq <= ? AND payload IS NOT NULL')
          .run(ack.watermark);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 当前确认水位（无确认为 0）。 */
  ackWatermark(): Seq {
    return Number(this.readMeta(KEY_ACK_WATERMARK));
  }

  close(): void {
    this.db.close();
  }

  private ensureMeta(key: string, initial: string): void {
    this.db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(key, initial);
  }

  private readMeta(key: string): string {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    if (!row) {
      throw new Error(`meta key missing: ${key}`);
    }
    return row.value;
  }

  private writeMeta(key: string, value: string): void {
    this.db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(value, key);
  }
}
