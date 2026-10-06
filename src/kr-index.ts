import {
  BUCKET_SECONDS,
  DEFAULT_CONFIDENCE,
  FREQUENCY_BUCKETS,
} from './types.js';

/** Events per confidence block for the blocked moment index. */
const CONF_BLOCK_SIZE = 64;

/** First index i with sorted[i] > x (count of elements <= x). */
function upperBound(sorted: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index i with sorted[i] >= x. */
function lowerBound(sorted: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Per-KR in-memory index over read-only history.
 *
 * Progress and confidence are step functions: a record holds from its
 * timestamp until the next record of the same KR and kind.
 *
 * Confidence moments are kept in blocked form so window integrals are
 * computed in coordinates local to the window, avoiding catastrophic
 * cancellation from large absolute UTC timestamps over 20-year spans.
 */
export class KrIndex {
  /** Sorted check-in times (UTC seconds). */
  private readonly checkTimes: Float64Array;
  /** Normalized progress in [0, 1], parallel to checkTimes. */
  private readonly progressValues: Float64Array;

  /** Sorted confidence review times (UTC seconds). */
  private readonly reviewTimes: Float64Array;
  /** Confidence scores (1..10), parallel to reviewTimes. */
  private readonly reviewScores: Float64Array;

  /** First event index of each confidence block. */
  private readonly blockStartIdx: number[];
  /** Start time of each confidence block. */
  private readonly blockStartTime: number[];
  /** Integral of c dt over the block's covered range. */
  private readonly blockM0: number[];
  /** Integral of (t - blockStart) * c dt over the block's covered range. */
  private readonly blockM1: number[];

  private constructor(
    checkTimes: Float64Array,
    progressValues: Float64Array,
    reviewTimes: Float64Array,
    reviewScores: Float64Array,
  ) {
    this.checkTimes = checkTimes;
    this.progressValues = progressValues;
    this.reviewTimes = reviewTimes;
    this.reviewScores = reviewScores;

    this.blockStartIdx = [];
    this.blockStartTime = [];
    this.blockM0 = [];
    this.blockM1 = [];
    const n = reviewTimes.length;
    for (let s = 0; s < n; s += CONF_BLOCK_SIZE) {
      const e = Math.min(s + CONF_BLOCK_SIZE, n);
      const base = reviewTimes[s]!;
      let m0 = 0;
      let m1 = 0;
      for (let i = s; i < e; i++) {
        const segStart = reviewTimes[i]!;
        const segEnd = i + 1 < n ? reviewTimes[i + 1]! : Number.POSITIVE_INFINITY;
        const v = reviewScores[i]!;
        m0 += v * (segEnd - segStart);
        const a = segStart - base;
        const b = segEnd - base;
        m1 += (v * (b * b - a * a)) / 2;
      }
      this.blockStartIdx.push(s);
      this.blockStartTime.push(base);
      this.blockM0.push(m0);
      this.blockM1.push(m1);
    }
  }

  /**
   * Build an index from raw records of one KR, in arbitrary order.
   * `normalize` maps a raw check-in value to clamped progress in [0, 1].
   */
  static build(
    checkIns: readonly { time: number; value: number }[],
    reviews: readonly { time: number; score: number }[],
    normalize: (raw: number) => number,
  ): KrIndex {
    const sortedChecks = [...checkIns].sort((a, b) => a.time - b.time);
    const sortedReviews = [...reviews].sort((a, b) => a.time - b.time);

    const checkTimes = new Float64Array(sortedChecks.length);
    const progressValues = new Float64Array(sortedChecks.length);
    for (let i = 0; i < sortedChecks.length; i++) {
      checkTimes[i] = sortedChecks[i]!.time;
      progressValues[i] = normalize(sortedChecks[i]!.value);
    }

    const reviewTimes = new Float64Array(sortedReviews.length);
    const reviewScores = new Float64Array(sortedReviews.length);
    for (let i = 0; i < sortedReviews.length; i++) {
      reviewTimes[i] = sortedReviews[i]!.time;
      reviewScores[i] = sortedReviews[i]!.score;
    }

    return new KrIndex(checkTimes, progressValues, reviewTimes, reviewScores);
  }

  /** Progress at time t: last check-in at or before t, else 0. */
  progressAt(t: number): number {
    const i = upperBound(this.checkTimes, t);
    return i === 0 ? 0 : this.progressValues[i - 1]!;
  }

  /**
   * Number of the 4 consecutive 7-day buckets starting at L that contain
   * at least one check-in. Buckets are [start, end); a check-in exactly
   * at L + 28d belongs to no bucket.
   */
  frequencyHitBuckets(L: number): number {
    let hits = 0;
    for (let k = 0; k < FREQUENCY_BUCKETS; k++) {
      const lo = L + k * BUCKET_SECONDS;
      const hi = lo + BUCKET_SECONDS;
      if (lowerBound(this.checkTimes, hi) - lowerBound(this.checkTimes, lo) > 0) {
        hits++;
      }
    }
    return hits;
  }

  /**
   * Confidence moments over [L, T] for the held-value step curve:
   * m0 = integral of c dt, m1 = integral of (t - L) * c dt.
   * The last review at or before L carries in; a review exactly at T
   * has zero duration inside the window.
   */
  trendMoments(L: number, T: number): { m0: number; m1: number } {
    const rt = this.reviewTimes;
    const rv = this.reviewScores;
    const n = rt.length;
    let m0 = 0;
    let m1 = 0;

    const addSegment = (from: number, to: number, v: number): void => {
      const lo = Math.max(from, L);
      const hi = Math.min(to, T);
      if (hi <= lo) return;
      m0 += v * (hi - lo);
      const a = lo - L;
      const b = hi - L;
      m1 += (v * (b * b - a * a)) / 2;
    };

    // Carry-in segment: value of the last review at or before L holds
    // from L until the first review strictly after L.
    const carryIdx = upperBound(rt, L) - 1;
    const carryValue = carryIdx >= 0 ? rv[carryIdx]! : DEFAULT_CONFIDENCE;
    const carryEnd = carryIdx + 1 < n ? rt[carryIdx + 1]! : Number.POSITIVE_INFINITY;
    addSegment(L, carryEnd, carryValue);

    // Blocks intersecting (L, T]: from the block containing the first
    // event after L up to the block containing T.
    const nBlocks = this.blockStartIdx.length;
    if (nBlocks === 0) return { m0, m1 };
    const jLo = Math.max(0, upperBound(this.blockStartTime, L) - 1);
    const jHi = upperBound(this.blockStartTime, T) - 1;

    for (let j = jLo; j <= jHi; j++) {
      const blockStart = this.blockStartTime[j]!;
      const blockEnd =
        j + 1 < nBlocks ? this.blockStartTime[j + 1]! : Number.POSITIVE_INFINITY;
      if (blockStart > L && blockEnd <= T) {
        // Fully covered block: reuse precomputed local moments.
        const bm0 = this.blockM0[j]!;
        m0 += bm0;
        m1 += this.blockM1[j]! + (blockStart - L) * bm0;
      } else {
        // Partial block: walk its events, skipping segments at or
        // before L (already covered by the carry-in segment).
        const s = this.blockStartIdx[j]!;
        const e =
          j + 1 < nBlocks ? this.blockStartIdx[j + 1]! : n;
        for (let i = s; i < e; i++) {
          const segStart = rt[i]!;
          if (segStart >= T) break;
          if (segStart <= L) continue;
          const segEnd = i + 1 < n ? rt[i + 1]! : Number.POSITIVE_INFINITY;
          addSegment(segStart, segEnd, rv[i]!);
        }
      }
    }

    return { m0, m1 };
  }
}
