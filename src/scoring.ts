/** Rounds a composite score to 6 decimal places (half away from zero). */
export function roundScore(score: number): number {
  return Math.round(score * 1e6) / 1e6;
}

/**
 * Composite score before rounding:
 * 50 * skillRatio + 30 * commuteRatio + 20 * timeRatio.
 */
export function compositeScore(
  skillRatio: number,
  commuteRatio: number,
  timeRatio: number,
): number {
  return 50 * skillRatio + 30 * commuteRatio + 20 * timeRatio;
}
