/**
 * A single session update event reported by an access point.
 * `value === null` is a deletion marker (tombstone).
 */
export interface SessionEvent {
  sessionId: string;
  sourceAp: string;
  sourceSeq: number;
  /** Millisecond timestamp. */
  updatedAt: number;
  /** Full redacted session value, or null for deletion. */
  value: Record<string, unknown> | null;
}

/** The conflict-ordering key of an event / winning state. */
export interface WinnerKey {
  updatedAt: number;
  sourceAp: string;
  sourceSeq: number;
}

/** Per-session state stored for a version: the winning event key plus value. */
export interface SessionState extends WinnerKey {
  value: Record<string, unknown> | null;
}

/** Compare two winner keys: updatedAt, then sourceAp (lexicographic), then sourceSeq. */
export function compareWinnerKey(a: WinnerKey, b: WinnerKey): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
  if (a.sourceAp !== b.sourceAp) return a.sourceAp < b.sourceAp ? -1 : 1;
  return a.sourceSeq - b.sourceSeq;
}
