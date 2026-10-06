import { OrderStatisticTree } from "./treap.js";
import type {
  CommissionExplanation,
  CommissionSlice,
  DealInput,
  DealType,
  PlanVersion,
  Tier,
} from "./types.js";

/** MM/DD/YYYY -> 可比较整数（y*10000 + m*100 + d）。 */
export function dateKeyOf(closeDate: string): number {
  const month = Number(closeDate.slice(0, 2));
  const day = Number(closeDate.slice(3, 5));
  const year = Number(closeDate.slice(6, 10));
  return year * 10000 + month * 100 + day;
}

interface DealKey {
  readonly dateKey: number;
  readonly externalId: string;
}

function compareKeys(a: DealKey, b: DealKey): number {
  if (a.dateKey !== b.dateKey) return a.dateKey - b.dateKey;
  return a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0;
}

interface DealRecord {
  readonly key: DealKey;
  readonly amountCents: bigint;
  readonly dealType: DealType;
}

interface CompiledTier {
  readonly threshold: bigint;
  readonly rateBps: bigint;
}

interface CompiledVersion {
  readonly id: string;
  readonly fromKey: number;
  readonly toKey: number;
  readonly tiers: Readonly<Record<DealType, readonly CompiledTier[]>>;
}

function compileTiers(tiers: readonly Tier[], versionId: string): CompiledTier[] {
  if (tiers.length < 1 || tiers.length > 4) {
    throw new Error(`plan ${versionId}: tiers must have 1..4 entries`);
  }
  const compiled: CompiledTier[] = [];
  let prev = -1n;
  for (const tier of tiers) {
    const threshold = BigInt(tier.thresholdCents);
    if (threshold <= prev) {
      throw new Error(`plan ${versionId}: thresholds must strictly increase`);
    }
    prev = threshold;
    compiled.push({ threshold, rateBps: BigInt(tier.rateBps) });
  }
  if (compiled[0]!.threshold !== 0n) {
    throw new Error(`plan ${versionId}: first tier must start at 0`);
  }
  return compiled;
}

/** mulberry32：确定性伪随机源，保证 Treap 优先级可复现。 */
function makeRand(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class CommissionEngine {
  private readonly versions: readonly CompiledVersion[];
  private readonly tree = new OrderStatisticTree<DealKey>(
    compareKeys,
    makeRand(0x5eed),
  );
  private readonly deals = new Map<string, DealRecord>();

  constructor(plan: readonly PlanVersion[]) {
    if (plan.length === 0) {
      throw new Error("plan must contain at least one version");
    }
    const sorted = [...plan].sort(
      (a, b) => dateKeyOf(a.effectiveFrom) - dateKeyOf(b.effectiveFrom),
    );
    const versions: CompiledVersion[] = [];
    let expectedFrom = dateKeyOf("01/01/2026");
    for (const version of sorted) {
      const fromKey = dateKeyOf(version.effectiveFrom);
      const toKey = dateKeyOf(version.effectiveTo);
      if (fromKey !== expectedFrom || toKey < fromKey) {
        throw new Error(
          `plan versions must be contiguous and cover Q1 2026 (bad: ${version.id})`,
        );
      }
      versions.push({
        id: version.id,
        fromKey,
        toKey,
        tiers: {
          NEW_BUSINESS: compileTiers(version.newBusinessTiers, version.id),
          RENEWAL: compileTiers(version.renewalTiers, version.id),
        },
      });
      expectedFrom = toKey + 1;
    }
    if (expectedFrom !== dateKeyOf("03/31/2026") + 1) {
      throw new Error("plan versions must cover the whole quarter");
    }
    this.versions = versions;
  }

  get dealCount(): number {
    return this.tree.size;
  }

  upsertDeal(deal: DealInput): void {
    const key: DealKey = {
      dateKey: dateKeyOf(deal.closeDate),
      externalId: deal.externalId,
    };
    const amount = BigInt(deal.amountCents);
    const existing = this.deals.get(deal.externalId);
    if (existing !== undefined) {
      if (
        existing.key.dateKey === key.dateKey &&
        existing.amountCents === amount &&
        existing.dealType === deal.dealType
      ) {
        return;
      }
      this.tree.remove(existing.key);
    }
    this.tree.upsert(key, amount);
    this.deals.set(deal.externalId, {
      key,
      amountCents: amount,
      dealType: deal.dealType,
    });
  }

  removeDeal(externalId: string): void {
    const existing = this.deals.get(externalId);
    if (existing === undefined) {
      throw new Error(`unknown deal: ${externalId}`);
    }
    this.tree.remove(existing.key);
    this.deals.delete(externalId);
  }

  explainDeal(externalId: string): CommissionExplanation {
    const record = this.deals.get(externalId);
    if (record === undefined) {
      throw new Error(`unknown deal: ${externalId}`);
    }
    const prior = this.tree.sumBefore(record.key);
    const version = this.versionFor(record.key.dateKey);
    const tiers = version.tiers[record.dealType];
    const from = prior;
    const to = prior + record.amountCents;

    const slices: CommissionSlice[] = [];
    let weighted = 0n;
    for (let i = 0; i < tiers.length; i += 1) {
      const tierLo = tiers[i]!.threshold;
      const tierHi =
        i + 1 < tiers.length ? tiers[i + 1]!.threshold : null;
      const lo = from > tierLo ? from : tierLo;
      const hi = tierHi !== null && tierHi < to ? tierHi : to;
      if (lo < hi) {
        const amount = hi - lo;
        weighted += amount * tiers[i]!.rateBps;
        slices.push({
          fromCents: lo.toString(),
          toCents: hi.toString(),
          amountCents: amount.toString(),
          rateBps: Number(tiers[i]!.rateBps),
        });
      }
    }

    // 仅在最终支付分数上四舍五入，恰好半分向上。
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

  private versionFor(dateKey: number): CompiledVersion {
    let lo = 0;
    let hi = this.versions.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.versions[mid]!.fromKey <= dateKey) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return this.versions[lo]!;
  }
}
