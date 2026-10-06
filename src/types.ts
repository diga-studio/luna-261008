/** Date string in MM/DD/YYYY format. */
export type DateString = string;

/**
 * One piece of initial history: `positionId` reports to `managerId`
 * on days in [start, end). A null start means the infinite past,
 * a null end means the infinite future. A null managerId means
 * the position has no manager (top-level) during the interval.
 */
export interface HistoryRecord {
  positionId: string;
  managerId: string | null;
  start: DateString | null;
  end: DateString | null;
}

/**
 * One adjustment: set the manager of `positionId` to `newManagerId`
 * on days in [start, end). End is exclusive; a null end means the
 * infinite future.
 */
export interface Adjustment {
  positionId: string;
  newManagerId: string | null;
  start: DateString;
  end: DateString | null;
}

export interface BatchResult {
  accepted: boolean;
  /** Human-readable reason when the batch is rejected. */
  reason?: string;
}

/** Manager assignment for every position on a single day. */
export type OrgSnapshot = Record<string, string | null>;
