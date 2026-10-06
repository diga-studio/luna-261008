import { BuyXGetYActivity, BuyXGetYAllocation, Cart } from "./types";

export interface AllocationResult {
  /** Total original price of all gifted units, in cents. */
  totalGiftValueCents: number;
  allocations: BuyXGetYAllocation[];
}

interface SkuInfo {
  price: number;
  quantity: number;
}

/** Enumerates all count vectors over `skus` summing to `total`, each entry <= cap. */
function* distribute(
  skus: string[],
  caps: number[],
  total: number,
  index: number,
  current: number[]
): Generator<number[]> {
  if (index === skus.length - 1) {
    if (total <= caps[index]) {
      current[index] = total;
      yield current.slice();
    }
    return;
  }
  const upper = Math.min(caps[index], total);
  for (let count = 0; count <= upper; count++) {
    current[index] = count;
    yield* distribute(skus, caps, total - count, index + 1, current);
  }
}

function toRecord(skus: string[], counts: number[]): Record<string, number> {
  const record: Record<string, number> = {};
  for (let i = 0; i < skus.length; i++) {
    if (counts[i] > 0) record[skus[i]] = counts[i];
  }
  return record;
}

/**
 * Finds an allocation of cart units to the given buy-X-get-Y activities that
 * maximizes the total gifted value. Every cart unit takes at most one role
 * across all activities. Returns null when any activity cannot be satisfied
 * with exactly X threshold and Y gift units.
 */
export function bestBuyXGetYAllocation(
  cart: Cart,
  activities: BuyXGetYActivity[]
): AllocationResult | null {
  const info = new Map<string, SkuInfo>();
  for (const line of cart) {
    info.set(line.sku, { price: line.unitPriceCents, quantity: line.quantity });
  }
  const remaining = new Map<string, number>();
  for (const line of cart) remaining.set(line.sku, line.quantity);

  let best: AllocationResult | null = null;

  function search(
    activityIndex: number,
    giftValueSoFar: number,
    allocationsSoFar: BuyXGetYAllocation[]
  ): void {
    if (activityIndex === activities.length) {
      if (best === null || giftValueSoFar > best.totalGiftValueCents) {
        best = {
          totalGiftValueCents: giftValueSoFar,
          allocations: allocationsSoFar.map((a) => ({
            activityId: a.activityId,
            threshold: { ...a.threshold },
            gift: { ...a.gift },
          })),
        };
      }
      return;
    }
    const activity = activities[activityIndex];
    const isLast = activityIndex === activities.length - 1;

    const giftSkus = activity.giftSkus.filter((sku) => info.has(sku));
    const giftCaps = giftSkus.map((sku) =>
      Math.min(remaining.get(sku)!, activity.y)
    );
    const thresholdSkus = activity.thresholdSkus.filter((sku) => info.has(sku));

    for (const giftCounts of distribute(
      giftSkus,
      giftCaps,
      activity.y,
      0,
      new Array(giftSkus.length).fill(0)
    )) {
      for (let i = 0; i < giftSkus.length; i++) {
        remaining.set(giftSkus[i], remaining.get(giftSkus[i])! - giftCounts[i]);
      }
      const giftValue = giftSkus.reduce(
        (sum, sku, i) => sum + giftCounts[i] * info.get(sku)!.price,
        0
      );

      const thresholdCaps = thresholdSkus.map((sku) =>
        Math.min(remaining.get(sku)!, activity.x)
      );
      const thresholdCapacity = thresholdCaps.reduce((a, b) => a + b, 0);

      if (thresholdCapacity >= activity.x) {
        if (isLast) {
          // Feasibility suffices; build one concrete threshold pick greedily.
          const thresholdCounts = new Array(thresholdSkus.length).fill(0);
          let needed = activity.x;
          for (let i = 0; i < thresholdSkus.length && needed > 0; i++) {
            const take = Math.min(thresholdCaps[i], needed);
            thresholdCounts[i] = take;
            needed -= take;
          }
          allocationsSoFar.push({
            activityId: activity.id,
            threshold: toRecord(thresholdSkus, thresholdCounts),
            gift: toRecord(giftSkus, giftCounts),
          });
          search(activityIndex + 1, giftValueSoFar + giftValue, allocationsSoFar);
          allocationsSoFar.pop();
        } else {
          for (const thresholdCounts of distribute(
            thresholdSkus,
            thresholdCaps,
            activity.x,
            0,
            new Array(thresholdSkus.length).fill(0)
          )) {
            for (let i = 0; i < thresholdSkus.length; i++) {
              remaining.set(
                thresholdSkus[i],
                remaining.get(thresholdSkus[i])! - thresholdCounts[i]
              );
            }
            allocationsSoFar.push({
              activityId: activity.id,
              threshold: toRecord(thresholdSkus, thresholdCounts),
              gift: toRecord(giftSkus, giftCounts),
            });
            search(
              activityIndex + 1,
              giftValueSoFar + giftValue,
              allocationsSoFar
            );
            allocationsSoFar.pop();
            for (let i = 0; i < thresholdSkus.length; i++) {
              remaining.set(
                thresholdSkus[i],
                remaining.get(thresholdSkus[i])! + thresholdCounts[i]
              );
            }
          }
        }
      }

      for (let i = 0; i < giftSkus.length; i++) {
        remaining.set(giftSkus[i], remaining.get(giftSkus[i])! + giftCounts[i]);
      }
    }
  }

  if (activities.length > 0) {
    search(0, 0, []);
  }
  return best;
}
