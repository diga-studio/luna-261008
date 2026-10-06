import { Fraction } from "./fraction";
import { DimensionValues, Weights } from "./types";

export const DEFAULT_SCORE_HUNDREDTHS = 10000n;
export const RESTRICTION_THRESHOLD_HUNDREDTHS = 4000n;

/**
 * Exact credit score (in 0.01-point units) from the latest effective version
 * of each of the subject's ratings and the current dimension weights.
 *
 * For every configured label with at least one observation, the values are
 * averaged per label, then combined into a weighted average over those
 * labels. Labels without observations stay out of the denominator. With no
 * participating label the score is 100.
 */
export function computeScore(
  weights: Weights,
  effectiveValues: DimensionValues[]
): Fraction {
  let numerator = Fraction.zero();
  let denominator = Fraction.zero();

  for (const [label, weight] of Object.entries(weights)) {
    let sum = 0n;
    let count = 0n;
    for (const values of effectiveValues) {
      const value = values[label];
      if (value !== undefined) {
        sum += BigInt(value);
        count += 1n;
      }
    }
    if (count === 0n) continue;
    const w = Fraction.fromNumber(weight);
    numerator = numerator.add(w.mul(new Fraction(sum, count)));
    denominator = denominator.add(w);
  }

  if (denominator.num === 0n) {
    return new Fraction(DEFAULT_SCORE_HUNDREDTHS);
  }
  return numerator.div(denominator);
}
