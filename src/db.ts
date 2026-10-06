import { DatabaseSync } from "node:sqlite";
import type { ActivityEvent } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  event_id   TEXT PRIMARY KEY,
  room_id    TEXT NOT NULL,
  session_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  action     TEXT NOT NULL,
  doc_id     TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events (session_id, ts, event_id);
CREATE INDEX IF NOT EXISTS idx_events_doc ON events (room_id, doc_id, action, ts);
`;

/** Opens (or creates) the SQLite database and ensures the schema exists. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

/** Inserts events idempotently; duplicates (same event id) are ignored. */
export function insertEvents(db: DatabaseSync, events: ActivityEvent[]): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO events
       (event_id, room_id, session_id, user_id, ts, action, doc_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec("BEGIN");
  try {
    for (const e of events) {
      stmt.run(
        e.eventId,
        e.roomId,
        e.sessionId,
        e.userId,
        e.timestamp,
        e.action,
        e.documentId ?? null,
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
