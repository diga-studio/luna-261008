import type { DatabaseSync } from "node:sqlite";
import { insertEvents, openDatabase } from "./db.js";
import type { ActivityEvent, DailyReport } from "./types.js";

/** Maximum dwell gap (20 minutes) still counted toward average dwell. */
const MAX_DWELL_MS = 20 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface EventRow {
  event_id: string;
  session_id: string;
  user_id: string;
  ts: number;
}

function dayStartMs(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    throw new Error(`invalid date, expected YYYY-MM-DD: ${date}`);
  }
  const [, y, m, d] = match;
  const ms = Date.UTC(Number(y), Number(m) - 1, Number(d));
  if (Number.isNaN(ms)) {
    throw new Error(`invalid date: ${date}`);
  }
  return ms;
}

/**
 * Engagement tracker: imports activity events and serves per-day
 * document engagement reports backed by SQLite.
 */
export class EngagementTracker {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
  }

  /** Imports a batch of events (any order, duplicates allowed). */
  importEvents(events: ActivityEvent[]): void {
    insertEvents(this.db, events);
  }

  /** Returns the daily report for a (room, document, UTC day). */
  getDailyReport(roomId: string, documentId: string, date: string): DailyReport {
    const start = dayStartMs(date);
    const end = start + DAY_MS;

    const opens = this.db
      .prepare(
        `SELECT event_id, session_id, user_id, ts FROM events
         WHERE room_id = ? AND doc_id = ? AND action = 'open'
           AND ts >= ? AND ts < ?`,
      )
      .all(roomId, documentId, start, end) as unknown as EventRow[];

    const downloadRow = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM events
         WHERE room_id = ? AND doc_id = ? AND action = 'download'
           AND ts >= ? AND ts < ?`,
      )
      .get(roomId, documentId, start, end) as unknown as { c: number };

    const successorStmt = this.db.prepare(
      `SELECT ts FROM events
       WHERE session_id = ? AND (ts > ? OR (ts = ? AND event_id > ?))
       ORDER BY ts ASC, event_id ASC
       LIMIT 1`,
    );

    const readers = new Set<string>();
    let dwellSum = 0;
    let dwellCount = 0;
    for (const open of opens) {
      readers.add(open.user_id);
      const next = successorStmt.get(
        open.session_id,
        open.ts,
        open.ts,
        open.event_id,
      ) as unknown as { ts: number } | undefined;
      if (next !== undefined) {
        const dwell = next.ts - open.ts;
        if (dwell <= MAX_DWELL_MS) {
          dwellSum += dwell;
          dwellCount += 1;
        }
      }
    }

    return {
      roomId,
      documentId,
      date,
      openCount: opens.length,
      uniqueReaders: readers.size,
      downloadCount: downloadRow.c,
      avgDwellMs: dwellCount > 0 ? dwellSum / dwellCount : null,
    };
  }

  close(): void {
    this.db.close();
  }
}
