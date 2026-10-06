/**
 * 仅供测试使用的全量排序参考计算器。
 * 独立实现：每次调用都对当前成交全集重新排序、重新累计，
 * 不复用生产代码（src/commission.ts、src/engine.ts）的任何计算逻辑。
 */
import type { CommissionSlice, Deal, DealExplanation, PlanVersion, Tier } from "../src/types.js";

function dateKeyOf(date: string): number {
  const m = Number(date.slice(0, 2));
  const d = Number(date.slice(3, 5));
  const y = Number(date.slice(6, 10));
  return y * 10000 + m * 100 + d;
}

function sliceOneDeal(
  tiers: readonly Tier[],
  prior: bigint,
  amount: bigint,
): { slices: CommissionSlice[]; payableCents: bigint } {
  const thresholds = tiers.map((t) => BigInt(t.thresholdCents));
  const end = prior + amount;
  const slices: CommissionSlice[] = [];
  let acc = 0n;
  let cursor = prior;
  for (let i = 0; i < tiers.length && cursor < end; i += 1) {
    const from = cursor < thresholds[i] ? thresholds[i] : cursor;
    const upper = i + 1 < tiers.length && thresholds[i + 1] < end ? thresholds[i + 1] : end;
    if (from < upper) {
      const sliceAmount = upper - from;
      acc += sliceAmount * BigInt(tiers[i].rateBps);
      slices.push({
        fromCumulativeCents: from.toString(),
        toCumulativeCents: upper.toString(),
        amountCents: sliceAmount.toString(),
        rateBps: tiers[i].rateBps,
      });
      cursor = upper;
    }
  }
  return { slices, payableCents: (acc + 5000n) / 10000n };
}

export function referenceExplain(
  deals: ReadonlyMap<string, Deal>,
  planVersions: readonly PlanVersion[],
  externalId: string,
): DealExplanation {
  const all = [...deals.values()].sort((a, b) => {
    const ka = dateKeyOf(a.closeDate);
    const kb = dateKeyOf(b.closeDate);
    if (ka !== kb) return ka - kb;
    return a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0;
  });

  let cumulative = 0n;
  for (const deal of all) {
    if (deal.externalId !== externalId) {
      cumulative += BigInt(deal.amountCents);
      continue;
    }
    const key = dateKeyOf(deal.closeDate);
    const version = planVersions.find(
      (v) => dateKeyOf(v.startDate) <= key && key <= dateKeyOf(v.endDate),
    );
    if (version === undefined) throw new Error(`no version for ${deal.closeDate}`);
    const tiers = deal.dealType === "newBusiness" ? version.newBusinessTiers : version.renewalTiers;
    const { slices, payableCents } = sliceOneDeal(tiers, cumulative, BigInt(deal.amountCents));
    return {
      externalId,
      priorCumulativeCents: cumulative.toString(),
      planVersionId: version.id,
      slices,
      payableCents: payableCents.toString(),
    };
  }
  throw new Error(`unknown deal: ${externalId}`);
}
