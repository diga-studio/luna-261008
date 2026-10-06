/** Metric kinds supported by the ranker. Values are integers in hundredths of a percent. */
export type MetricKind = 'cpu' | 'memory' | 'disk';

/** Supported query window sizes in hours. */
export type WindowHours = 1 | 6 | 12 | 24 | 48 | 72;

/** One ranked entry returned by `top`. */
export interface RankEntry {
  nodeId: string;
  /** Integral of the metric over covered time, in hundredths-of-percent * milliseconds. */
  integral: number;
  /** Covered milliseconds inside the window. */
  coverageMs: number;
  /** Unrounded mean: integral / coverageMs. */
  mean: number;
}

/** A single stored heartbeat. */
export interface Heartbeat {
  timestampMs: number;
  cpu: number;
  memory: number;
  disk: number;
}
