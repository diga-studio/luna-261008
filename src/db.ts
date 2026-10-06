import { DatabaseSync } from 'node:sqlite';
import type { AlertLevel, AlertRecord, NotificationRecord } from './types.js';

export interface AlertRow {
  alert_id: string;
  call_id: string;
  created_at: number;
  level: AlertLevel;
  acknowledged_at: number | null;
}

const META_LAST_PROCESSED_TIME = 'last_processed_time';

/** SQLite 持久化封装：所有状态与通知的唯一存储 */
export class AlertDatabase {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS calls (
        call_id TEXT PRIMARY KEY,
        last_seq INTEGER NOT NULL,
        consecutive_negatives INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS segments (
        call_id TEXT NOT NULL,
        segment_seq INTEGER NOT NULL,
        score REAL NOT NULL,
        business_time INTEGER NOT NULL,
        PRIMARY KEY (call_id, segment_seq)
      );
      CREATE TABLE IF NOT EXISTS alerts (
        alert_id TEXT PRIMARY KEY,
        call_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        level TEXT NOT NULL,
        acknowledged_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_alerts_call ON alerts (call_id);
      CREATE TABLE IF NOT EXISTS notifications (
        notification_id TEXT PRIMARY KEY,
        alert_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        level TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        UNIQUE (alert_id, level)
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_call ON notifications (call_id);
    `);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getLastProcessedTime(): number | null {
    const row = this.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(META_LAST_PROCESSED_TIME) as { value: string } | undefined;
    return row === undefined ? null : Number(row.value);
  }

  setLastProcessedTime(timeMs: number): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(META_LAST_PROCESSED_TIME, String(timeMs));
  }

  getSegmentScore(callId: string, segmentSeq: number): number | null {
    const row = this.db
      .prepare('SELECT score FROM segments WHERE call_id = ? AND segment_seq = ?')
      .get(callId, segmentSeq) as { score: number } | undefined;
    return row === undefined ? null : row.score;
  }

  insertSegment(callId: string, segmentSeq: number, score: number, businessTime: number): void {
    this.db
      .prepare('INSERT INTO segments (call_id, segment_seq, score, business_time) VALUES (?, ?, ?, ?)')
      .run(callId, segmentSeq, score, businessTime);
  }

  getCallState(callId: string): { lastSeq: number; consecutiveNegatives: number } | null {
    const row = this.db
      .prepare('SELECT last_seq, consecutive_negatives FROM calls WHERE call_id = ?')
      .get(callId) as { last_seq: number; consecutive_negatives: number } | undefined;
    if (row === undefined) return null;
    return { lastSeq: row.last_seq, consecutiveNegatives: row.consecutive_negatives };
  }

  upsertCallState(callId: string, lastSeq: number, consecutiveNegatives: number): void {
    this.db
      .prepare(
        'INSERT INTO calls (call_id, last_seq, consecutive_negatives) VALUES (?, ?, ?) ' +
          'ON CONFLICT (call_id) DO UPDATE SET last_seq = excluded.last_seq, consecutive_negatives = excluded.consecutive_negatives',
      )
      .run(callId, lastSeq, consecutiveNegatives);
  }

  insertAlert(alertId: string, callId: string, createdAt: number): void {
    this.db
      .prepare("INSERT INTO alerts (alert_id, call_id, created_at, level, acknowledged_at) VALUES (?, ?, ?, 'INFO', NULL)")
      .run(alertId, callId, createdAt);
  }

  getAlert(alertId: string): AlertRow | null {
    const row = this.db
      .prepare('SELECT alert_id, call_id, created_at, level, acknowledged_at FROM alerts WHERE alert_id = ?')
      .get(alertId) as AlertRow | undefined;
    return row === undefined ? null : row;
  }

  listAlerts(callId: string): AlertRow[] {
    return this.db
      .prepare('SELECT alert_id, call_id, created_at, level, acknowledged_at FROM alerts WHERE call_id = ? ORDER BY created_at, alert_id')
      .all(callId) as unknown as AlertRow[];
  }

  listUnacknowledgedAlerts(): AlertRow[] {
    return this.db
      .prepare('SELECT alert_id, call_id, created_at, level, acknowledged_at FROM alerts WHERE acknowledged_at IS NULL')
      .all() as unknown as AlertRow[];
  }

  setAlertLevel(alertId: string, level: AlertLevel): void {
    this.db.prepare('UPDATE alerts SET level = ? WHERE alert_id = ?').run(level, alertId);
  }

  acknowledgeAlert(alertId: string, acknowledgedAt: number): void {
    this.db
      .prepare('UPDATE alerts SET acknowledged_at = ? WHERE alert_id = ? AND acknowledged_at IS NULL')
      .run(acknowledgedAt, alertId);
  }

  /** 幂等插入：同一告警同一等级最多一条；occurred_at 为逻辑发生时间 */
  insertNotificationIfAbsent(
    notificationId: string,
    alertId: string,
    callId: string,
    level: AlertLevel,
    occurredAt: number,
  ): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO notifications (notification_id, alert_id, call_id, level, occurred_at, seq) ' +
          'VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM notifications))',
      )
      .run(notificationId, alertId, callId, level, occurredAt);
  }

  listNotifications(callId?: string): NotificationRecord[] {
    const rows =
      callId === undefined
        ? (this.db
            .prepare('SELECT notification_id, alert_id, call_id, level, occurred_at FROM notifications ORDER BY occurred_at, seq')
            .all() as unknown as Array<{ notification_id: string; alert_id: string; call_id: string; level: AlertLevel; occurred_at: number }>)
        : (this.db
            .prepare('SELECT notification_id, alert_id, call_id, level, occurred_at FROM notifications WHERE call_id = ? ORDER BY occurred_at, seq')
            .all(callId) as unknown as Array<{ notification_id: string; alert_id: string; call_id: string; level: AlertLevel; occurred_at: number }>);
    return rows.map((row) => ({
      notificationId: row.notification_id,
      alertId: row.alert_id,
      callId: row.call_id,
      level: row.level,
      occurredAt: row.occurred_at,
    }));
  }
}

export function alertRowToRecord(row: AlertRow): AlertRecord {
  return {
    alertId: row.alert_id,
    callId: row.call_id,
    createdAt: row.created_at,
    level: row.level,
    acknowledgedAt: row.acknowledged_at,
  };
}
