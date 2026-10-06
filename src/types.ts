/** All timestamps are UTC seconds. A day is exactly 86400 seconds. */
export const SECONDS_PER_DAY = 86400;

/** How a check-in's raw measured value is normalized into [0, 1] progress. */
export type ProgressKind = "percentage" | "numeric" | "binary";

export interface KeyResultSpec {
  /** Caller-defined unique KR id. */
  readonly id: string;
  /** Weight within the objective; all KR weights of an objective sum to 100. */
  readonly weight: number;
  readonly progressKind: ProgressKind;
  /**
   * Fixed positive target value, required when progressKind is "numeric".
   * Progress = measured value / targetValue.
   */
  readonly targetValue?: number;
}

export interface ObjectiveSpec {
  readonly id: string;
  /** Objective period start, UTC seconds. */
  readonly start: number;
  /** Objective period end, UTC seconds. Period is at least 28 days. */
  readonly end: number;
  /** 1 to 5 key results. */
  readonly krs: readonly KeyResultSpec[];
}

/** A check-in: measured progress value at a point in time. */
export interface CheckIn {
  readonly krId: string;
  readonly time: number;
  readonly value: number;
}

/** A sprint-close record: integer confidence from 1 to 10. */
export interface ConfidenceRecord {
  readonly krId: string;
  readonly time: number;
  /** Integer in [1, 10]. */
  readonly confidence: number;
}

/** Caller-supplied, read-only history for a set of objectives. */
export interface OkrHistory {
  readonly objectives: readonly ObjectiveSpec[];
  readonly checkIns: readonly CheckIn[];
  readonly confidenceRecords: readonly ConfidenceRecord[];
}

/** Sub-scores and final health score for one KR or one objective. */
export interface HealthScore {
  /** Velocity component in [0, 1]. */
  readonly velocity: number;
  /** Frequency component in [0, 1]. */
  readonly frequency: number;
  /** Trend component in [0, 1]. */
  readonly trend: number;
  /** 0.4 * velocity + 0.3 * frequency + 0.3 * trend. */
  readonly health: number;
}

export interface KeyResultHealth extends HealthScore {
  readonly krId: string;
  readonly weight: number;
}

export interface ObjectiveHealth extends HealthScore {
  readonly objectiveId: string;
  /** Query time, UTC seconds. */
  readonly time: number;
  readonly krs: readonly KeyResultHealth[];
}
