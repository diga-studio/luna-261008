/**
 * 仅供测试使用的全量排序参考计算器。
 * 每次查询都重新排序全部成交并从头累加，O(n log n)，
 * 与生产实现（Treap 增量聚合）完全独立。
 */
import type {
  CommissionExplanation,
  CommissionSlice,
  DealInput,
  PlanVersion,
  Tier,
} from "../src/types.js";

function toKey(closeDate: string): number {
  const month = Number(closeDate.slice(0, 2));
  const day = Number(closeDate.slice(3, 5));
  const year = Number(closeDate.slice(6, 10));
  return year * 10000 + month * 100 + day;
}

export class ReferenceCalculator {
  private readonly deals = new Map<string, DealInput>();

  constructor(private readonly plan: readonly PlanVersion[]) {}

  upsertDeal(deal: DealInput): void {
    this.deals.set(deal.externalId, deal);
  }

  removeDeal(externalId: string): void {
    this.deals.delete(externalId);
  }

  explainDeal(externalId: string): CommissionExplanation {
    const target = this.deals.get(externalId);
    if (target === undefined) {
      throw new Error(`unknown deal: ${externalId}`);
    }
    const ordered = [...this.deals.values()].sort((a, b) => {
      const da = toKey(a.closeDate);
      const db = toKey(b.closeDate);
      if (da !== db) return da - db;
      return a.externalId < b.externalId
        ? -1
        : a.externalId > b.externalId
          ? 1
          : 0;
    });

    let prior = 0n;
    for (const deal of ordered) {
      if (deal.externalId === externalId) break;
      prior += BigInt(deal.amountCents);
    }

    const dateKey = toKey(target.closeDate);
    const version = this.plan.find(
      (v) => toKey(v.effectiveFrom) <= dateKey && dateKey <= toKey(v.effectiveTo),
    );
    if (version === undefined) {
      throw new Error(`no plan version for ${target.closeDate}`);
    }
    const tiers: readonly Tier[] =
      target.dealType === "NEW_BUSINESS"
        ? version.newBusinessTiers
        : version.renewalTiers;

    const from = prior;
    const to = prior + BigInt(target.amountCents);
    const slices: CommissionSlice[] = [];
    let weighted = 0n;
    for (let i = 0; i < tiers.length; i += 1) {
      const tierLo = BigInt(tiers[i]!.thresholdCents);
      const tierHi =
        i + 1 < tiers.length ? BigInt(tiers[i + 1]!.thresholdCents) : null;
      const lo = from > tierLo ? from : tierLo;
      const hi = tierHi !== null && tierHi < to ? tierHi : to;
      if (lo < hi) {
        const amount = hi - lo;
        weighted += amount * BigInt(tiers[i]!.rateBps);
        slices.push({
          fromCents: lo.toString(),
          toCents: hi.toString(),
          amountCents: amount.toString(),
          rateBps: tiers[i]!.rateBps,
        });
      }
    }
    const quotient = weighted / 10000n;
    const remainder = weighted % 10000n;
    const payment = remainder * 2n >= 10000n ? quotient + 1n : quotient;

    return {
      externalId,
      priorAccumulatedCents: prior.toString(),
      planVersionId: version.id,
      slices,
      paymentCents: payment.toString(),
    };
  }
}
