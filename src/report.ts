import type { PipelineStore } from "./store.js";
import type { Stage, StageChange, StageReport, StageStats } from "./types.js";
import { STAGES } from "./types.js";

/** Report window length: 90 * 24 hours, in milliseconds. */
export const WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Accumulate the parts of one candidate's dwell segments that overlap
 * [windowStart, windowEnd). Segment i covers [history[i].at, history[i+1].at);
 * the last segment is open-ended. Zero-length overlaps are ignored.
 */
function accumulateCandidate(
  history: readonly StageChange[],
  windowStart: number,
  windowEnd: number,
  totals: Map<Stage, { segments: number; totalMs: number }>,
): void {
  for (let i = 0; i < history.length; i += 1) {
    const segmentStart = history[i].at;
    const segmentEnd = i + 1 < history.length ? history[i + 1].at : windowEnd;
    const overlapStart = Math.max(segmentStart, windowStart);
    const overlapEnd = Math.min(segmentEnd, windowEnd);
    if (overlapEnd <= overlapStart) {
      continue;
    }
    const bucket = totals.get(history[i].stage)!;
    bucket.segments += 1;
    bucket.totalMs += overlapEnd - overlapStart;
  }
}

/**
 * Generate a stage-dwell report for all candidates as of `asOf` (UTC epoch ms).
 * Window is [asOf - WINDOW_MS, asOf), left-closed right-open.
 */
export function generateReport(store: PipelineStore, asOf: number): StageReport {
  if (!Number.isInteger(asOf)) {
    throw new RangeError(`asOf must be an integer (UTC ms), got ${asOf}`);
  }
  const windowEnd = asOf;
  const windowStart = asOf - WINDOW_MS;

  const totals = new Map<Stage, { segments: number; totalMs: number }>(
    STAGES.map((stage) => [stage, { segments: 0, totalMs: 0 }]),
  );
  for (const history of store.getHistories().values()) {
    accumulateCandidate(history, windowStart, windowEnd, totals);
  }

  const report = {} as Record<Stage, StageStats>;
  for (const stage of STAGES) {
    const { segments, totalMs } = totals.get(stage)!;
    report[stage] = {
      segments,
      totalMs,
      averageMs: segments === 0 ? 0 : totalMs / segments,
    };
  }
  return report;
}
