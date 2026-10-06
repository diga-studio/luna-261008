import type { Database } from './db.js';
import { isInSilentWindow, nextSilentWindowEnd } from './time.js';
import type {
  AlertLevel,
  AlertRecord,
  AlertStatus,
  NotificationRecord,
  SegmentInput,
} from './types.js';

const NEGATIVE_THRESHOLD = -0.5;
const STREAK_FOR_ALERT = 3;
const WARN_AFTER_MS = 15 * 60 * 1000;
const CRITICAL_AFTER_MS = 30 * 60 * 1000;
const CURSOR_KEY = 'event_cursor';

interface AlertRow {
  id: string;
  call_id: string;
  created_at: number;
  level: string;
  confirmed_at: number | null;
}

interface NotificationRow {
  id: string;
  alert_id: string;
  call_id: string;
  level: string;
  published_at: number;
}

function toAlert(row: AlertRow): AlertRecord {
  return {
    id: row.id,
    callId: row.call_id,
    createdAt: row.created_at,
    level: row.level as AlertLevel,
    confirmedAt: row.confirmed_at,
  };
}

function toNotification(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    alertId: row.alert_id,
    callId: row.call_id,
    level: row.level as AlertLevel,
    publishedAt: row.published_at,
  };
}

export class AlertService {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** Register a segment score. Duplicate (callId, segmentIndex) deliveries are ignored. */
  registerSegment(input: SegmentInput): void {
    this.processDueEvents(input.businessTime);
    this.db.exec('BEGIN');
    try {
      const inserted = this.db
        .prepare(
          'INSERT OR IGNORE INTO segments (call_id, segment_index, score, registered_at) VALUES (?, ?, ?, ?)',
        )
        .run(input.callId, input.segmentIndex, input.score, input.businessTime);
      if (Number(inserted.changes) > 0) {
        this.applySegment(input);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Confirm an alert, stopping further escalation and notifications. */
  confirmAlert(alertId: string, businessTime: number): void {
    this.processDueEvents(businessTime);
    const result = this.db
      .prepare('UPDATE alerts SET confirmed_at = ? WHERE id = ? AND confirmed_at IS NULL')
      .run(businessTime, alertId);
    if (Number(result.changes) === 0) {
      const existing = this.db.prepare('SELECT id FROM alerts WHERE id = ?').get(alertId);
      if (!existing) {
        throw new Error(`alert not found: ${alertId}`);
      }
    }
  }

  /** Advance business time, processing all events due up to it. */
  advanceTime(businessTime: number): void {
    this.processDueEvents(businessTime);
  }

  getAlert(alertId: string): AlertRecord | null {
    const row = this.db
      .prepare('SELECT * FROM alerts WHERE id = ?')
      .get(alertId) as unknown as AlertRow | undefined;
    return row ? toAlert(row) : null;
  }

  listAlerts(callId?: string): AlertRecord[] {
    const rows = (
      callId === undefined
        ? this.db.prepare('SELECT * FROM alerts ORDER BY created_at, id').all()
        : this.db
            .prepare('SELECT * FROM alerts WHERE call_id = ? ORDER BY created_at, id')
            .all(callId)
    ) as unknown as AlertRow[];
    return rows.map(toAlert);
  }

  getAlertStatus(alertId: string): AlertStatus | null {
    const alert = this.getAlert(alertId);
    if (!alert) {
      return null;
    }
    const rows = this.db
      .prepare('SELECT * FROM notifications WHERE alert_id = ? ORDER BY published_at, id')
      .all(alertId) as unknown as NotificationRow[];
    return { alert, notifications: rows.map(toNotification) };
  }

  listNotifications(callId?: string): NotificationRecord[] {
    const rows = (
      callId === undefined
        ? this.db.prepare('SELECT * FROM notifications ORDER BY published_at, id').all()
        : this.db
            .prepare(
              'SELECT * FROM notifications WHERE call_id = ? ORDER BY published_at, id',
            )
            .all(callId)
    ) as unknown as NotificationRow[];
    return rows.map(toNotification);
  }

  private applySegment(input: SegmentInput): void {
    const state = this.db
      .prepare('SELECT last_segment_index, negative_streak FROM call_state WHERE call_id = ?')
      .get(input.callId) as
      | { last_segment_index: number; negative_streak: number }
      
    const lastIndex = state ? state.last_segment_index : -1;
    if (input.segmentIndex <= lastIndex) {
      return;
    }
    const negative = input.score < NEGATIVE_THRESHOLD;
    const streak = negative ? (state?.negative_streak ?? 0) + 1 : 0;
    this.db
      .prepare(
        `INSERT INTO call_state (call_id, last_segment_index, negative_streak)
         VALUES (?, ?, ?)
         ON CONFLICT (call_id) DO UPDATE SET
           last_segment_index = excluded.last_segment_index,
           negative_streak = excluded.negative_streak`,
      )
      .run(input.callId, input.segmentIndex, streak);
    if (negative && streak === STREAK_FOR_ALERT) {
      const alertId = `al-${input.callId}-${input.segmentIndex}`;
      this.db
        .prepare(
          'INSERT OR IGNORE INTO alerts (id, call_id, created_at, level, confirmed_at) VALUES (?, ?, ?, ?, NULL)',
        )
        .run(alertId, input.callId, input.businessTime, 'INFO');
      this.maybeNotify(alertId, input.callId, 'INFO', input.businessTime);
    }
  }

  /** Publish a notification unless suppressed by the silent window. */
  private maybeNotify(
    alertId: string,
    callId: string,
    level: AlertLevel,
    timeMs: number,
  ): void {
    if (level !== 'CRITICAL' && isInSilentWindow(timeMs)) {
      return;
    }
    this.publishNotification(alertId, callId, level, timeMs);
  }

  private publishNotification(
    alertId: string,
    callId: string,
    level: AlertLevel,
    timeMs: number,
  ): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO notifications (id, alert_id, call_id, level, published_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(`ntf-${alertId}-${level}`, alertId, callId, level, timeMs);
  }

  private getCursor(): number {
    const row = this.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(CURSOR_KEY) as { value: number } | undefined;
    return row ? row.value : Number.MIN_SAFE_INTEGER;
  }

  private setCursor(timeMs: number): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(CURSOR_KEY, timeMs);
  }

  /**
   * Process every event due at or before `businessTime`, in chronological
   * order. At the same instant upgrades run first, then the silent-window
   * end; confirmations ordered afterwards happen in the calling operation.
   */
  private processDueEvents(businessTime: number): void {
    let cursor = this.getCursor();
    if (businessTime <= cursor) {
      return;
    }
    for (;;) {
      let nextTime = Number.POSITIVE_INFINITY;
      let upgrades: Array<{ id: string; callId: string; level: AlertLevel }> = [];
      const pending = this.db
        .prepare('SELECT id, call_id, created_at, level FROM alerts WHERE confirmed_at IS NULL')
        .all() as Array<Pick<AlertRow, 'id' | 'call_id' | 'created_at' | 'level'>>;
      for (const alert of pending) {
        if (alert.level === 'INFO') {
          const at = alert.created_at + WARN_AFTER_MS;
          if (at <= businessTime && at < nextTime) {
            nextTime = at;
            upgrades = [{ id: alert.id, callId: alert.call_id, level: 'WARN' }];
          } else if (at === nextTime) {
            upgrades.push({ id: alert.id, callId: alert.call_id, level: 'WARN' });
          }
        } else if (alert.level === 'WARN') {
          const at = alert.created_at + CRITICAL_AFTER_MS;
          if (at <= businessTime && at < nextTime) {
            nextTime = at;
            upgrades = [{ id: alert.id, callId: alert.call_id, level: 'CRITICAL' }];
          } else if (at === nextTime) {
            upgrades.push({ id: alert.id, callId: alert.call_id, level: 'CRITICAL' });
          }
        }
      }
      let silentEndAt = Number.POSITIVE_INFINITY;
      if (this.hasSuppressedAlerts()) {
        const end = nextSilentWindowEnd(cursor);
        if (end <= businessTime) {
          silentEndAt = end;
        }
      }
      if (silentEndAt < nextTime) {
        nextTime = silentEndAt;
        upgrades = [];
      } else if (silentEndAt > nextTime) {
        silentEndAt = Number.POSITIVE_INFINITY;
      }
      if (nextTime === Number.POSITIVE_INFINITY) {
        break;
      }
      for (const upgrade of upgrades) {
        this.db
          .prepare('UPDATE alerts SET level = ? WHERE id = ? AND confirmed_at IS NULL')
          .run(upgrade.level, upgrade.id);
        this.maybeNotify(upgrade.id, upgrade.callId, upgrade.level, nextTime);
      }
      if (silentEndAt === nextTime) {
        this.publishSuppressedAt(nextTime);
      }
      cursor = nextTime;
    }
    this.setCursor(businessTime);
  }

  /** Unconfirmed, non-critical alerts whose current level has no notification. */
  private hasSuppressedAlerts(): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM alerts a
         WHERE a.confirmed_at IS NULL AND a.level != 'CRITICAL'
           AND NOT EXISTS (
             SELECT 1 FROM notifications n
             WHERE n.alert_id = a.id AND n.level = a.level
           )
         LIMIT 1`,
      )
      .get();
    return row !== undefined;
  }

  /** At silent-window end, publish the current level of still-suppressed alerts. */
  private publishSuppressedAt(timeMs: number): void {
    const rows = this.db
      .prepare(
        `SELECT a.id, a.call_id, a.level FROM alerts a
         WHERE a.confirmed_at IS NULL AND a.level != 'CRITICAL'
           AND NOT EXISTS (
             SELECT 1 FROM notifications n
             WHERE n.alert_id = a.id AND n.level = a.level
           )`,
      )
      .all() as Array<Pick<AlertRow, 'id' | 'call_id' | 'level'>>;
    for (const row of rows) {
      this.publishNotification(row.id, row.call_id, row.level as AlertLevel, timeMs);
    }
  }
}
