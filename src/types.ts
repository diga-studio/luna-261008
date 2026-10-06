/** All timestamps are UTC seconds. A day is exactly 86400 seconds. */
export const SECONDS_PER_DAY = 86400;

/** Scoring window length: 28 days. */
export const WINDOW_DAYS = 28;
export const WINDOW_SECONDS = WINDOW_DAYS * SECONDS_PER_DAY;

/** Frequency score splits the window into four 7-day buckets. */
export const FREQUENCY_BUCKETS = 4;
export const BUCKET_SECONDS = (WINDOW_SECONDS / FREQUENCY_BUCKETS);

/** Default confidence when no review exists at or before the queried time. */
export const DEFAULT_CONFIDENCE = 5.5;

/** How a KR's raw check-in value is normalized to [0, 1]. */
export type ProgressKind = 'percent' | 'number' | 'binary';

/** Static objective metadata. Cycle length is at least 28 days. */
export interface ObjectiveSpec {
  readonly id: string;
  /** UTC seconds, inclusive start of the objective cycle. */
  readonly start: number;
  /** UTC seconds, inclusive end of the objective cycle. */
  readonly end: number;
}

/** Static KR metadata. Weights of an objective's KRs sum to 100 (percent). */
export interface KrSpec {
  readonly id: string;
  readonly objectiveId: string;
  /** Weight in percent; all KRs of one objective sum to 100. */
  readonly weight: number;
  readonly progressKind: ProgressKind;
  /** Fixed positive target, required when progressKind is 'number'. */
  readonly targetValue?: number;
}

/** A check-in record: raw measured value at a point in time. */
export interface CheckIn {
  readonly krId: string;
  /** UTC seconds. */
  readonly time: number;
  /** Raw value: percent (0-100+), absolute number, or 0/1 for binary. */
  readonly value: number;
}

/** A sprint-closing confidence review, integer score from 1 to 10. */
export interface ConfidenceReview {
  readonly krId: string;
  /** UTC seconds. */
  readonly time: number;
  readonly score: number;
}

/** Historical input, provided once by the caller in arbitrary order. */
export interface HistoryData {
  readonly checkIns: readonly CheckIn[];
  readonly reviews: readonly ConfidenceReview[];
}

/** Score breakdown for one KR or one objective (weighted aggregate). */
export interface HealthScore {
  readonly velocity: number;
  readonly frequency: number;
  readonly trend: number;
  readonly health: number;
}

/** A point-in-time health query against one objective. */
export interface ScoreQuery {
  readonly objectiveId: string;
  /** UTC seconds; must be >= start + 28 days and <= end. */
  readonly time: number;
}
