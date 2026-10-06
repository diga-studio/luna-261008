export const STAGES = [
  "Identified",
  "Contacted",
  "Engaged",
  "Submitted to Client",
  "Interviewing",
  "Placed",
  "Alumni",
] as const;

export type Stage = (typeof STAGES)[number];

/** A single stage-change record: at `at` (UTC epoch ms) the candidate entered `stage`. */
export interface StageChange {
  at: number;
  stage: Stage;
}

/** Per-stage dwell statistics within a report window. */
export interface StageStats {
  /** Number of dwell segments overlapping the window. */
  segments: number;
  /** Total overlapped dwell time in milliseconds. */
  totalMs: number;
  /** Average dwell time in milliseconds (totalMs / segments, 0 when no segments). */
  averageMs: number;
}

export type StageReport = Record<Stage, StageStats>;
