import { DatabaseSync } from 'node:sqlite';
import { AckMessage, AgentId, EventEnvelope, Seq, ThreatRecord } from './types';

/**
 * 汇总侧存储：接收各代理补传的事件，按代理维护连续前缀与确认水位。
 * 写入与水位推进在同一事务内完成；重复送达幂等；重启后水位不回退。
 */
export class AggregatorStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        agent_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        payload BLOB NOT NULL,
        PRIMARY KEY (agent_id, seq)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_agent_event ON events (agent_id, event_id);
      CREATE TABLE IF NOT EXISTS watermarks (
        agent_id TEXT PRIMARY KEY,
        watermark INTEGER NOT NULL
      );
    `);
  }

  /**
   * 应用一批补传事件（可乱序、可含重复、可只含部分）。
   * 返回每个涉及代理的最新确认回执；重复送达不会产生重复记录。
   */
  applyEvents(envelopes: EventEnvelope[]): AckMessage[] {
    if (envelopes.length === 0) {
      return [];
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO events (agent_id, seq, event_id, payload) VALUES (?, ?, ?, ?)',
      );
      const agentIds: AgentId[] = [];
      const seen = new Set<AgentId>();
      for (const env of envelopes) {
        insert.run(env.agentId, env.seq, env.eventId, env.payload);
        if (!seen.has(env.agentId)) {
          seen.add(env.agentId);
          agentIds.push(env.agentId);
        }
      }
      const acks = agentIds.map((agentId) => ({
        agentId,
        watermark: this.advanceWatermark(agentId),
      }));
      this.db.exec('COMMIT');
      return acks;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 某代理的确认水位：从 1 开始无缺口的连续前缀末尾。 */
  watermark(agentId: AgentId): Seq {
    const row = this.db
      .prepare('SELECT watermark FROM watermarks WHERE agent_id = ?')
      .get(agentId) as { watermark: number } | undefined;
    return row ? row.watermark : 0;
  }

  /** 某代理公开的事件记录：序号 1..watermark 的连续前缀，按序号升序。 */
  records(agentId: AgentId): ThreatRecord[] {
    const rows = this.db
      .prepare(
        'SELECT event_id, seq, payload FROM events WHERE agent_id = ? AND seq <= ? ORDER BY seq ASC',
      )
      .all(agentId, this.watermark(agentId)) as Array<{
      event_id: string;
      seq: number;
      payload: Uint8Array;
    }>;
    return rows.map((row) => ({
      agentId,
      eventId: row.event_id,
      seq: row.seq,
      payload: Buffer.from(row.payload),
    }));
  }

  close(): void {
    this.db.close();
  }

  /** 在事务内推进某代理的水位：从当前水位起逐条检查 seq+1 是否已到达。 */
  private advanceWatermark(agentId: AgentId): Seq {
    let watermark = this.watermark(agentId);
    const hasNext = this.db.prepare(
      'SELECT 1 AS found FROM events WHERE agent_id = ? AND seq = ?',
    );
    while (hasNext.get(agentId, watermark + 1)) {
      watermark += 1;
    }
    this.db
      .prepare(
        'INSERT INTO watermarks (agent_id, watermark) VALUES (?, ?) ' +
          'ON CONFLICT(agent_id) DO UPDATE SET watermark = excluded.watermark',
      )
      .run(agentId, watermark);
    return watermark;
  }
}
