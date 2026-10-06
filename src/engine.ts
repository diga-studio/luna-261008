import { computeCommission, parseDateKey } from "./commission.js";
import { DealTreap } from "./treap.js";
import type { Deal, DealExplanation, DealType, PlanVersion, Tier } from "./types.js";

interface IndexedDeal {
  readonly dateKey: number;
  readonly deal: Deal;
}

interface IndexedPlanVersion {
  readonly startKey: number;
  readonly endKey: number;
  readonly version: PlanVersion;
}

export class CommissionEngine {
  private readonly versions: IndexedPlanVersion[];
  private readonly treap = new DealTreap();
  private readonly dealsById = new Map<string, IndexedDeal>();

  constructor(planVersions: readonly PlanVersion[]) {
    if (planVersions.length === 0) throw new Error("at least one plan version is required");
    this.versions = planVersions
      .map((version) => ({
        startKey: parseDateKey(version.startDate),
        endKey: parseDateKey(version.endDate),
        version,
      }))
      .sort((a, b) => a.startKey - b.startKey);
  }

  upsertDeal(deal: Deal): void {
    const existing = this.dealsById.get(deal.externalId);
    if (existing !== undefined) {
      this.treap.remove(existing.dateKey, deal.externalId);
    }
    const dateKey = parseDateKey(deal.closeDate);
    this.treap.insert(dateKey, deal.externalId, BigInt(deal.amountCents));
    this.dealsById.set(deal.externalId, { dateKey, deal });
  }

  removeDeal(externalId: string): void {
    const existing = this.dealsById.get(externalId);
    if (existing === undefined) throw new Error(`unknown deal: ${externalId}`);
    this.treap.remove(existing.dateKey, externalId);
    this.dealsById.delete(externalId);
  }

  explainDeal(externalId: string): DealExplanation {
    const existing = this.dealsById.get(externalId);
    if (existing === undefined) throw new Error(`unknown deal: ${externalId}`);
    const { dateKey, deal } = existing;
    const priorCumulative = this.treap.prefixSumBefore(dateKey, externalId);
    const version = this.findVersion(dateKey);
    const tiers = this.tiersFor(version, deal.dealType);
    const { slices, payableCents } = computeCommission(
      tiers,
      priorCumulative,
      BigInt(deal.amountCents),
    );
    return {
      externalId,
      priorCumulativeCents: priorCumulative.toString(),
      planVersionId: version.id,
      slices,
      payableCents: payableCents.toString(),
    };
  }

  private findVersion(dateKey: number): PlanVersion {
    let lo = 0;
    let hi = this.versions.length - 1;
    let result = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.versions[mid].startKey <= dateKey) {
        result = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (result < 0 || this.versions[result].endKey < dateKey) {
      throw new Error(`no plan version covers dateKey ${dateKey}`);
    }
    return this.versions[result].version;
  }

  private tiersFor(version: PlanVersion, dealType: DealType): readonly Tier[] {
    return dealType === "newBusiness" ? version.newBusinessTiers : version.renewalTiers;
  }
}

export type { Deal, DealExplanation, DealType, PlanVersion };
