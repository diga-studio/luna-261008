/** A single activity type with its historical service-time samples and capacity. */
export interface ActivityDef {
  /** Unique activity identifier. */
  id: string;
  /** Non-empty historical service durations (ms, non-negative integers, excluding waiting). */
  samples: number[];
  /** Baseline capacity: number of parallel workstations, 1..50. */
  capacity: number;
}

/** A case: arrives once and runs its activity sequence serially. */
export interface CaseDef {
  /** Unique ASCII case identifier. */
  id: string;
  /** Arrival time in ms (non-negative integer). */
  arrival: number;
  /** Ordered activity ids; repeats allowed; each activity uses its own workstation pool. */
  path: string[];
}

export interface SimulationInput {
  activities: ActivityDef[];
  cases: CaseDef[];
}

/**
 * Scenario modifications. Anything not mentioned keeps its baseline value.
 * An empty object means "identical to baseline".
 */
export interface Scenario {
  /** Activity ids to remove: all their occurrences are skipped. */
  remove?: string[];
  /** Activity id -> shortening percent (1..99). Shortened duration is floored, may become 0. */
  shorten?: Record<string, number>;
  /** Activity id -> capacity override (1..50). */
  capacity?: Record<string, number>;
}

/** One retained step of a replay, in dispatch order. */
export interface StepRecord {
  caseId: string;
  activityId: string;
  /** Original index of the step in the case's activity sequence. */
  stepIndex: number;
  /** Time the step became ready (predecessor completion or case arrival). */
  ready: number;
  /** Service start time. */
  start: number;
  /** Service end time (start + sampled, possibly modified, duration). */
  end: number;
}

export interface ReplayResult {
  /** Retained steps (removed activities are absent), in the order they started. */
  steps: StepRecord[];
  /** Case id -> completion time (empty paths complete at arrival). */
  completions: Record<string, number>;
}

export interface SideStats {
  /** Cross-round mean of per-round mean case durations. */
  mean: number;
  /** Cross-round mean of per-round median case durations. */
  median: number;
}

export interface CompareResult {
  baseline: SideStats;
  scenario: SideStats;
  /** scenario minus baseline. */
  diff: SideStats;
}
