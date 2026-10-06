/** Stable identifier of a position in the fixed position set. */
export type PositionId = string;

/** Calendar date in MM/DD/YYYY format, compared by day, timezone independent. */
export type DateString = string;

/**
 * A single effective-dated change of a position's manager.
 * Effective range is [startDate, endDate): start inclusive, end exclusive.
 * endDate === null means "infinite future".
 */
export interface Adjustment {
  positionId: PositionId;
  managerId: PositionId | null;
  startDate: DateString;
  endDate: DateString | null;
}

/** One row of initial history: who manages a position over a range. */
export interface HistoryRecord {
  positionId: PositionId;
  managerId: PositionId | null;
  startDate: DateString;
  endDate: DateString | null;
}

export type BatchResult = { ok: true } | { ok: false; reason: string };
