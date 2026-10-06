/** Dimension label -> weight. Weights are non-negative numbers; their decimal
 * representation is treated as exact for scoring purposes. */
export type Weights = Record<string, number>;

/** Dimension label -> value. Values are integers in units of 0.01 points. */
export type DimensionValues = Record<string, number>;

export interface CreditResult {
  /** Credit score in points, rounded to the nearest 0.01 (half up). */
  score: number;
  /** True when the unrounded score is strictly below 40. */
  restricted: boolean;
}
