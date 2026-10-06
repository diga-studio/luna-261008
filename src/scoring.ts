/**
 * Composite pair score: 50 * skillRatio + 30 * commuteRatio + 20 * timeRatio.
 * All ratios are in [0, 1]; the result is in [0, 100].
 */
export function compositeScore(
  skillRatio: number,
  commuteRatio: number,
  timeRatio: number,
): number {
  return 50 * skillRatio + 30 * commuteRatio + 20 * timeRatio;
}

/** Round to 6 decimal places. Scores are non-negative, so Math.round is exact. */
export function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Count of common elements between two ascending-sorted numeric arrays. */
export function countCommonSorted(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let i = 0;
  let j = 0;
  let common = 0;
  while (i < a.length && j < b.length) {
    const av = a[i];
    const bv = b[j];
    if (av === bv) {
      common++;
      i++;
      j++;
    } else if (av < bv) {
      i++;
    } else {
      j++;
    }
  }
  return common;
}
