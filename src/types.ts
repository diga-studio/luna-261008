/** Action kinds carried by an activity event. */
export type ActionType = "open" | "download" | "other";

/** A single immutable activity event. */
export interface ActivityEvent {
  /** Globally unique ASCII event id. */
  eventId: string;
  roomId: string;
  sessionId: string;
  userId: string;
  /** UTC epoch milliseconds. */
  timestamp: number;
  action: ActionType;
  /** Present for "open" and "download" actions; unique within a room. */
  documentId?: string;
}

/** Daily engagement report for one (room, document, UTC day). */
export interface DailyReport {
  roomId: string;
  documentId: string;
  /** UTC calendar day, YYYY-MM-DD. */
  date: string;
  openCount: number;
  /** Distinct users who opened the document that day. */
  uniqueReaders: number;
  downloadCount: number;
  /**
   * Average dwell time in milliseconds over opens with a valid successor
   * (fractional, not pre-rounded); null when no valid dwell exists.
   */
  avgDwellMs: number | null;
}
