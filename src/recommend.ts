import { bestBuyXGetYAllocation } from "./allocate";
import { computePayableCents } from "./pricing";
import {
  Activity,
  BuyXGetYActivity,
  Cart,
  PricingResult,
  StackablePair,
} from "./types";

function isStackable(
  a: Activity,
  b: Activity,
  pairs: StackablePair[]
): boolean {
  return pairs.some(
    (pair) =>
      (pair.activityIdA === a.id && pair.activityIdB === b.id) ||
      (pair.activityIdA === b.id && pair.activityIdB === a.id)
  );
}

/**
 * Recommends the lowest payable price over all legal activity combinations
 * (at most two activities, only explicitly stackable pairs) and item
 * allocations.
 */
export function recommendLowestPrice(
  cart: Cart,
  activities: Activity[],
  stackablePairs: StackablePair[]
): PricingResult {
  const originalTotalCents = cart.reduce(
    (sum, line) => sum + line.unitPriceCents * line.quantity,
    0
  );

  const combos: Activity[][] = [[]];
  for (const activity of activities) combos.push([activity]);
  for (let i = 0; i < activities.length; i++) {
    for (let j = i + 1; j < activities.length; j++) {
      if (isStackable(activities[i], activities[j], stackablePairs)) {
        combos.push([activities[i], activities[j]]);
      }
    }
  }

  let best: PricingResult | null = null;
  for (const combo of combos) {
    const buyXGetYs = combo.filter(
      (a): a is BuyXGetYActivity => a.type === "buyXGetY"
    );
    const percentOffs = combo
      .filter((a) => a.type === "percentOff")
      .map((a) => (a as { percent: number }).percent);
    const fixedOffs = combo
      .filter((a) => a.type === "fixedOff")
      .map((a) => (a as { amountCents: number }).amountCents);

    let giftValueCents = 0;
    let allocations: PricingResult["allocations"] = [];
    if (buyXGetYs.length > 0) {
      const allocation = bestBuyXGetYAllocation(cart, buyXGetYs);
      if (allocation === null) continue; // combo not satisfiable on this cart
      giftValueCents = allocation.totalGiftValueCents;
      allocations = allocation.allocations;
    }

    const payableCents = computePayableCents(
      originalTotalCents,
      giftValueCents,
      percentOffs,
      fixedOffs
    );
    if (best === null || payableCents < best.payableCents) {
      best = {
        payableCents,
        selectedActivityIds: combo.map((a) => a.id),
        allocations,
      };
    }
  }

  return best!;
}
