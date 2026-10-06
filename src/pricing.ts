/**
 * Computes the final payable amount with exact integer-cent math.
 *
 * Order of operations:
 * 1. subtract total gift value from the original total;
 * 2. multiply by every selected percent-off ratio (100 - p) / 100,
 *    flooring to cents only once at the end of this stage;
 * 3. subtract every selected fixed-amount discount;
 * 4. clamp at zero.
 */
export function computePayableCents(
  originalTotalCents: number,
  giftValueCents: number,
  percentOffs: number[],
  fixedOffsCents: number[]
): number {
  let numerator = originalTotalCents - giftValueCents;
  let denominator = 1;
  for (const percent of percentOffs) {
    numerator *= 100 - percent;
    denominator *= 100;
  }
  let payable = Math.floor(numerator / denominator);
  for (const fixed of fixedOffsCents) {
    payable -= fixed;
  }
  return Math.max(0, payable);
}
