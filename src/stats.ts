import { openDatabase } from './db.js';
import type { ActivityEvent, DailyReport, ImportResult } from './types.js';

/** 尽调文档参与度统计库主入口 */
export interface EngagementStats {
  /** 批量导入事件（幂等，可乱序、可重投） */
  importEvents(events: ActivityEvent[]): ImportResult;
  /** 查询某房间某文档某 UTC 自然日的日报；当天无任何数据时返回 null */
  getDailyReport(roomId: string, docId: string, date: string): DailyReport | null;
  /** 关闭底层数据库 */
  close(): void;
}

/** 停留有效上限：20 分钟（含） */
const MAX_DWELL_MS = 20 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function validateEvent(event: ActivityEvent): void {
  if (typeof event.eventId !== 'string' || event.eventId.length === 0 || !/^[\x20-\x7E]+$/.test(event.eventId)) {
    throw new Error(`invalid eventId: ${String(event.eventId)}`);
  }
  if (!event.roomId || !event.sessionId || !event.userId) {
    throw new Error(`event ${event.eventId}: roomId/sessionId/userId must be non-empty`);
  }
  if (!Number.isFinite(event.timestamp) || event.timestamp < 0) {
    throw new Error(`event ${event.eventId}: invalid timestamp`);
  }
  if (event.action !== 'open' && event.action !== 'download' && event.action !== 'other') {
    throw new Error(`event ${event.eventId}: invalid action ${String(event.action)}`);
  }
  if ((event.action === 'open' || event.action === 'download') && !event.docId) {
    throw new Error(`event ${event.eventId}: ${event.action} requires docId`);
  }
}

function parseDate(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`invalid date (expect YYYY-MM-DD): ${date}`);
  const dayStart = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(dayStart)) throw new Error(`invalid date: ${date}`);
  return dayStart;
}

/** 创建统计实例；path 传 ':memory:' 使用内存库 */
export function createStats(path: string): EngagementStats {
  const db = openDatabase(path);

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO events (event_id, room_id, session_id, user_id, ts, action, doc_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const opensStmt = db.prepare(
    `SELECT event_id, session_id, user_id, ts FROM events
     WHERE room_id = ? AND doc_id = ? AND action = 'open' AND ts >= ? AND ts < ?
     ORDER BY ts, event_id`,
  );
  const downloadsStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM events
     WHERE room_id = ? AND doc_id = ? AND action = 'download' AND ts >= ? AND ts < ?`,
  );
  const successorStmt = db.prepare(
    `SELECT ts FROM events
     WHERE session_id = ? AND (ts > ? OR (ts = ? AND event_id > ?))
     ORDER BY ts, event_id LIMIT 1`,
  );

  return {
    importEvents(events: ActivityEvent[]): ImportResult {
      let inserted = 0;
      db.exec('BEGIN');
      try {
        for (const event of events) {
          validateEvent(event);
          const result = insertStmt.run(
            event.eventId,
            event.roomId,
            event.sessionId,
            event.userId,
            event.timestamp,
            event.action,
            event.docId ?? null,
          );
          inserted += Number(result.changes);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return { received: events.length, inserted };
    },

    getDailyReport(roomId: string, docId: string, date: string): DailyReport | null {
      const dayStart = parseDate(date);
      const dayEnd = dayStart + DAY_MS;

      const opens = opensStmt.all(roomId, docId, dayStart, dayEnd) as unknown as Array<{
        event_id: string;
        session_id: string;
        user_id: string;
        ts: number;
      }>;
      const downloads = Number(
        (downloadsStmt.get(roomId, docId, dayStart, dayEnd) as { n: number }).n,
      );

      if (opens.length === 0 && downloads === 0) return null;

      const readers = new Set<string>();
      let dwellSum = 0;
      let dwellCount = 0;
      for (const open of opens) {
        readers.add(open.user_id);
        const successor = successorStmt.get(open.session_id, open.ts, open.ts, open.event_id) as
          | { ts: number }
          | undefined;
        if (successor === undefined) continue;
        const dwell = successor.ts - open.ts;
        if (dwell <= MAX_DWELL_MS) {
          dwellSum += dwell;
          dwellCount += 1;
        }
      }

      return {
        roomId,
        docId,
        date,
        opens: opens.length,
        uniqueReaders: readers.size,
        downloads,
        avgDwellMs: dwellCount > 0 ? dwellSum / dwellCount : null,
      };
    },

    close(): void {
      db.close();
    },
  };
}
