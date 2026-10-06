import { isotonicL1Min } from "./isotonic";
import { AdjustResult, CueInput } from "./types";

/** Minimum gap between consecutive cues, in milliseconds. */
export const DEFAULT_GAP_MS = 80;

/**
 * Weight given to the two boundary sentinels of a sub-problem. Larger than
 * any achievable sum of real cue weights (<= 9 * 2 * 100000), so sentinels
 * never move; small enough that all weight arithmetic stays exact in
 * double precision.
 */
const SENTINEL_WEIGHT = 1e12;

/**
 * Globally re-times one subtitle track.
 *
 * The 2n cue boundaries (start/end of every cue) form a chain of variables
 * x[0..2n-1] with minimum-spacing constraints (display duration, inter-cue
 * gap, video bounds). Substituting y[j] = x[j] - P[j], where P[j] accumulates
 * the required spacings, turns the constraints into a simple monotone chain,
 * and the weighted |offset| cost into a weighted L1 isotonic regression,
 * which is solved to the componentwise-minimal optimum. Locked cues are fixed
 * points and split the chain into independent sub-problems.
 *
 * Returns { ok: false } when no feasible timeline exists.
 */
export function adjustTrack(
  cues: CueInput[],
  videoDuration: number,
  gapMs: number = DEFAULT_GAP_MS,
): AdjustResult {
  const n = cues.length;
  if (n === 0) return { ok: true, cues: [], totalCost: 0 };

  const m = 2 * n;
  // P[j] = minimal offset of boundary j: duration of cue k between start/end
  // elements, gap between end of cue k and start of cue k+1.
  const P = new Array<number>(m);
  P[0] = 0;
  for (let k = 0; k < n; k++) {
    P[2 * k + 1] = P[2 * k] + cues[k].minDuration;
    if (k + 1 < n) P[2 * k + 2] = P[2 * k + 1] + gapMs;
  }

  const target = new Array<number>(m);
  const weight = new Array<number>(m);
  const lockedElem = new Uint8Array(m);
  for (let k = 0; k < n; k++) {
    target[2 * k] = cues[k].start - P[2 * k];
    target[2 * k + 1] = cues[k].end - P[2 * k + 1];
    weight[2 * k] = cues[k].weight;
    weight[2 * k + 1] = cues[k].weight;
    if (cues[k].locked) {
      lockedElem[2 * k] = 1;
      lockedElem[2 * k + 1] = 1;
    }
  }

  const y = new Array<number>(m);
  let segStart = 0;
  let leftBound = 0; // y[0] >= 0  <=>  x[0] >= 0
  let scan = 0;
  for (;;) {
    let lock = -1;
    for (let j = scan; j < m; j++) {
      if (lockedElem[j]) {
        lock = j;
        break;
      }
    }
    const segEnd = lock === -1 ? m - 1 : lock - 1;
    const rightBound = lock === -1 ? videoDuration - P[m - 1] : target[lock];
    if (segEnd >= segStart) {
      const len = segEnd - segStart + 1;
      const t = new Array<number>(len + 2);
      const w = new Array<number>(len + 2);
      t[0] = leftBound;
      w[0] = SENTINEL_WEIGHT;
      for (let j = 0; j < len; j++) {
        t[j + 1] = target[segStart + j];
        w[j + 1] = weight[segStart + j];
      }
      t[len + 1] = rightBound;
      w[len + 1] = SENTINEL_WEIGHT;
      const ys = isotonicL1Min(t, w);
      for (let j = 0; j < len; j++) y[segStart + j] = ys[j + 1];
    }
    if (lock === -1) break;
    y[lock] = target[lock];
    leftBound = target[lock];
    segStart = lock + 1;
    scan = lock + 1;
  }

  // Map back to milliseconds and verify every hard constraint. If the
  // instance is infeasible, at least one sentinel/locked value could not be
  // honored and a constraint below fails.
  const outStart = new Array<number>(n);
  const outEnd = new Array<number>(n);
  for (let k = 0; k < n; k++) {
    outStart[k] = y[2 * k] + P[2 * k];
    outEnd[k] = y[2 * k + 1] + P[2 * k + 1];
  }
  let feasible = outStart[0] >= 0 && outEnd[n - 1] <= videoDuration;
  for (let k = 0; k < n && feasible; k++) {
    if (outEnd[k] - outStart[k] < cues[k].minDuration) feasible = false;
    if (k + 1 < n && outStart[k + 1] - outEnd[k] < gapMs) feasible = false;
    if (cues[k].locked && (outStart[k] !== cues[k].start || outEnd[k] !== cues[k].end)) {
      feasible = false;
    }
  }
  if (!feasible) return { ok: false };

  let totalCost = 0;
  for (let k = 0; k < n; k++) {
    totalCost +=
      cues[k].weight *
      (Math.abs(outStart[k] - cues[k].start) + Math.abs(outEnd[k] - cues[k].end));
  }

  const result = new Array<{ start: number; end: number }>(n);
  for (let k = 0; k < n; k++) result[k] = { start: outStart[k], end: outEnd[k] };
  return { ok: true, cues: result, totalCost };
}
