import type { Party, PartyAmounts } from './types.ts';

const TIE_ORDER: readonly Party[] = ['merchant', 'platform', 'partner'];

export function computeCumulativeShares(
  refundedTotal: number,
  totalAmount: number,
  original: PartyAmounts,
): PartyAmounts {
  if (refundedTotal === 0) {
    return { merchant: 0, platform: 0, partner: 0 };
  }
  const parts = TIE_ORDER.map((party) => {
    const numerator = refundedTotal * original[party];
    return {
      party,
      floor: Math.floor(numerator / totalAmount),
      remainder: numerator % totalAmount,
    };
  });
  const floorSum = parts.reduce((sum, p) => sum + p.floor, 0);
  let extra = refundedTotal - floorSum;
  const ranked = [...parts].sort((a, b) => {
    if (b.remainder !== a.remainder) return b.remainder - a.remainder;
    return TIE_ORDER.indexOf(a.party) - TIE_ORDER.indexOf(b.party);
  });
  const result: PartyAmounts = { merchant: 0, platform: 0, partner: 0 };
  for (const p of parts) result[p.party] = p.floor;
  for (const p of ranked) {
    if (extra <= 0) break;
    result[p.party] += 1;
    extra -= 1;
  }
  return result;
}
