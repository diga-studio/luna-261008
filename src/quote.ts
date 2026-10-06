import type {
  Activity,
  BuyXGetYActivity,
  BuyXGetYAllocation,
  QuoteRequest,
  QuoteResult,
} from './types.js';

interface AllocationSearchResult {
  /** 所有选中买赠活动免单的赠品原价总额（美分） */
  giftValueCents: number;
  allocations: BuyXGetYAllocation[];
}

/**
 * 在所有合法活动组合与餐品分配中，返回最低应付金额的方案。
 * 纯内存计算，无副作用。
 */
export function bestQuote(request: QuoteRequest): QuoteResult {
  const priceBySku = new Map<string, number>();
  const qtyBySku = new Map<string, number>();
  let originalTotalCents = 0;
  for (const line of request.cart) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new Error(`invalid quantity for sku ${line.sku}`);
    }
    if (!Number.isInteger(line.unitPriceCents) || line.unitPriceCents < 0) {
      throw new Error(`invalid unit price for sku ${line.sku}`);
    }
    if (priceBySku.has(line.sku)) {
      throw new Error(`duplicate cart line for sku ${line.sku}`);
    }
    priceBySku.set(line.sku, line.unitPriceCents);
    qtyBySku.set(line.sku, line.quantity);
    originalTotalCents += line.unitPriceCents * line.quantity;
  }

  const stackable = new Set<string>();
  for (const [a, b] of request.stackablePairs) {
    stackable.add(pairKey(a, b));
  }

  // 候选子集：空集、单活动、明确允许叠加的活动对
  const subsets: Activity[][] = [[]];
  const acts = request.activities;
  for (let i = 0; i < acts.length; i++) {
    subsets.push([acts[i]]);
    for (let j = i + 1; j < acts.length; j++) {
      if (stackable.has(pairKey(acts[i].id, acts[j].id))) {
        subsets.push([acts[i], acts[j]]);
      }
    }
  }

  let bestPayable = Number.POSITIVE_INFINITY;
  let bestIds: string[] = [];
  let bestAllocations: BuyXGetYAllocation[] = [];

  for (const subset of subsets) {
    const bxgyActivities = subset.filter(
      (a): a is BuyXGetYActivity => a.kind === 'buyXGetY',
    );

    let giftValueCents = 0;
    let allocations: BuyXGetYAllocation[] = [];
    if (bxgyActivities.length > 0) {
      const found = findBestGiftAllocation(bxgyActivities, qtyBySku, priceBySku);
      if (found === null) continue; // 购物车无法满足该组合的买赠分配
      giftValueCents = found.giftValueCents;
      allocations = found.allocations;
    }

    const payable = computePayable(originalTotalCents, giftValueCents, subset);

    if (payable < bestPayable) {
      bestPayable = payable;
      bestIds = subset.map((a) => a.id);
      bestAllocations = allocations;
    }
  }

  return {
    payableCents: bestPayable,
    selectedActivityIds: bestIds,
    allocations: bestAllocations,
  };
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * 价格公式：先从原价总额扣除赠品原价，再叠乘百分比折后比例
 * （仅在最后向下取整到美分），最后扣固定减免，最低 0。
 * 比例计算用 BigInt 整数运算，避免浮点误差。
 */
function computePayable(
  originalTotalCents: number,
  giftValueCents: number,
  subset: Activity[],
): number {
  const afterGifts = originalTotalCents - giftValueCents;

  let numerator = BigInt(afterGifts);
  let denominator = 1n;
  let fixedOffTotal = 0;
  for (const activity of subset) {
    if (activity.kind === 'percentOff') {
      numerator *= BigInt(100 - activity.percentOff);
      denominator *= 100n;
    } else if (activity.kind === 'fixedOff') {
      fixedOffTotal += activity.amountOffCents;
    }
  }
  const afterPercent = numerator / denominator; // BigInt 除法即向下取整
  const payable = Number(afterPercent) - fixedOffTotal;
  return payable < 0 ? 0 : payable;
}

/**
 * 在购物车可用份数约束下，为选中的买赠活动寻找赠品原价总额最大的分配。
 * 每份餐品在所有选中买赠活动中最多承担一个角色。
 * 无法满足任一活动的 X/Y 份数要求时返回 null。
 */
function findBestGiftAllocation(
  activities: BuyXGetYActivity[],
  qtyBySku: Map<string, number>,
  priceBySku: Map<string, number>,
): AllocationSearchResult | null {
  const remaining = new Map(qtyBySku);
  let best: AllocationSearchResult | null = null;

  const search = (
    index: number,
    giftValueSoFar: number,
    allocationsSoFar: BuyXGetYAllocation[],
  ): void => {
    if (index === activities.length) {
      if (best === null || giftValueSoFar > best.giftValueCents) {
        best = {
          giftValueCents: giftValueSoFar,
          allocations: allocationsSoFar.map((a) => ({
            activityId: a.activityId,
            thresholds: { ...a.thresholds },
            gifts: { ...a.gifts },
          })),
        };
      }
      return;
    }
    const activity = activities[index];
    forEachAssignment(activity.thresholdSkus, activity.x, remaining, (thresholds) => {
      takeFrom(remaining, thresholds, -1);
      forEachAssignment(activity.giftSkus, activity.y, remaining, (gifts) => {
        takeFrom(remaining, gifts, -1);
        let giftValue = 0;
        for (const [sku, count] of Object.entries(gifts)) {
          giftValue += (priceBySku.get(sku) ?? 0) * count;
        }
        allocationsSoFar.push({ activityId: activity.id, thresholds, gifts });
        search(index + 1, giftValueSoFar + giftValue, allocationsSoFar);
        allocationsSoFar.pop();
        takeFrom(remaining, gifts, 1);
      });
      takeFrom(remaining, thresholds, 1);
    });
  };

  search(0, 0, []);
  return best;
}

/**
 * 枚举“从 allowedSkus 中分配恰好 total 份”的所有按 SKU 份数方案，
 * 受 remaining 中可用份数约束。
 */
function forEachAssignment(
  allowedSkus: readonly string[],
  total: number,
  remaining: Map<string, number>,
  emit: (assignment: Record<string, number>) => void,
): void {
  const skus = allowedSkus.filter((sku) => (remaining.get(sku) ?? 0) > 0);
  const current: Record<string, number> = {};

  const walk = (skuIndex: number, left: number): void => {
    if (left === 0) {
      emit({ ...current });
      return;
    }
    if (skuIndex >= skus.length) return;
    const sku = skus[skuIndex];
    const maxTake = Math.min(left, remaining.get(sku) ?? 0);
    for (let take = maxTake; take >= 0; take--) {
      if (take > 0) current[sku] = take;
      walk(skuIndex + 1, left - take);
      if (take > 0) delete current[sku];
    }
  };

  walk(0, total);
}

function takeFrom(
  remaining: Map<string, number>,
  assignment: Record<string, number>,
  direction: 1 | -1,
): void {
  for (const [sku, count] of Object.entries(assignment)) {
    remaining.set(sku, (remaining.get(sku) ?? 0) + direction * count);
  }
}
