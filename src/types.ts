export type Metric = "cpu" | "memory" | "disk";

export type WindowHours = 1 | 6 | 12 | 24 | 48 | 72;

export const WINDOW_HOURS: readonly WindowHours[] = [1, 6, 12, 24, 48, 72];

export const METRICS: readonly Metric[] = ["cpu", "memory", "disk"];

/** How long a heartbeat's values remain valid, in milliseconds. */
export const HOLD_MS = 300_000;

export interface Heartbeat {
  timestampMs: number;
  cpu: number;
  memory: number;
  disk: number;
}

export interface RankEntry {
  nodeId: string;
  /** Integral of the metric over the window, in (1/100 percent)*ms. */
  integral: bigint;
  /** Covered milliseconds inside the window. */
  coverageMs: bigint;
  /** Unrounded mean as a float (integral / coverageMs), for display. */
  mean: number;
}
