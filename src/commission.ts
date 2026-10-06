import type { CommissionSlice, Tier } from "./types.js";

/** 将 MM/DD/YYYY 解析为可比较的日历序整数。 */
export function parseDateKey(date: string): number {
  const month = Number(date.slice(0, 2));
  const day = Number(date.slice(3, 5));
  const year = Number(date.slice(6, 10));
  return year * 10000 + month * 100 + day;
}

const BPS_DENOMINATOR = 10000n;
const HALF_DENOMINATOR = 5000n;

/**
 * 计算区间 [priorCumulative, priorCumulative + amount) 的跨档切片。
 * 精确累加 sum(sliceAmount * rateBps)，仅在最终支付分上除以 10000 并四舍五入（半分向上）。
 */
export function computeCommission(
  tiers: readonly Tier[],
  priorCumulative: bigint,
  amount: bigint,
): { slices: CommissionSlice[]; payableCents: bigint } {
  const lo = priorCumulative;
  const hi = priorCumulative + amount;
  const slices: CommissionSlice[] = [];
  let weightedSum = 0n;

  for (let i = 0; i < tiers.length; i += 1) {
    const tierStart = BigInt(tiers[i].thresholdCents);
    const tierEnd = i + 1 < tiers.length ? BigInt(tiers[i + 1].thresholdCents) : null;
    const sliceFrom = lo > tierStart ? lo : tierStart;
    const sliceTo = tierEnd !== null && hi > tierEnd ? tierEnd : hi;
    if (sliceFrom >= sliceTo) continue;
    const sliceAmount = sliceTo - sliceFrom;
    const rateBps = tiers[i].rateBps;
    weightedSum += sliceAmount * BigInt(rateBps);
    slices.push({
      fromCumulativeCents: sliceFrom.toString(),
      toCumulativeCents: sliceTo.toString(),
      amountCents: sliceAmount.toString(),
      rateBps,
    });
  }

  const payableCents = (weightedSum + HALF_DENOMINATOR) / BPS_DENOMINATOR;
  return { slices, payableCents };
}
