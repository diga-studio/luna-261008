import { replay } from "../src/replay";
import type { Order, PlanInput } from "../src/types";

export interface BruteForceOptimum {
  totalQuantity: number;
  orderCount: number;
}

/**
 * Independent exhaustive checker for small instances: enumerates every legal
 * combination of orders (arrival day subset x quantities) and evaluates each
 * candidate with `replay`. Returns the lexicographically smallest
 * (totalQuantity, orderCount), or null when no feasible plan exists.
 */
export function bruteForceOptimum(input: PlanInput): BruteForceOptimum | null {
  const { days, demand, allowedArrivalDays, leadTime, packSize, moq } = input;
  const allowed = new Set(allowedArrivalDays);
  const qMin = Math.ceil(moq / packSize) * packSize;
  const totalDemand = demand.reduce((sum, d) => sum + d, 0);
  const qMax = Math.max(qMin, Math.ceil(totalDemand / packSize) * packSize);

  const optionsPerDay: number[][] = [];
  for (let d = 0; d < days; d++) {
    const options: number[] = [0];
    if (allowed.has(d) && d - leadTime >= 0) {
      for (let q = qMin; q <= qMax; q += packSize) options.push(q);
    }
    optionsPerDay.push(options);
  }

  let best: BruteForceOptimum | null = null;
  const chosen = new Array<number>(days).fill(0);

  const visit = (d: number): void => {
    if (d === days) {
      const orders: Order[] = [];
      for (let day = 0; day < days; day++) {
        const qty = chosen[day]!;
        if (qty > 0) orders.push({ arrivalDay: day, quantity: qty });
      }
      if (!replay(input, orders).feasible) return;
      const totalQuantity = orders.reduce((sum, o) => sum + o.quantity, 0);
      const candidate: BruteForceOptimum = { totalQuantity, orderCount: orders.length };
      const better =
        best === null ||
        candidate.totalQuantity < best.totalQuantity ||
        (candidate.totalQuantity === best.totalQuantity &&
          candidate.orderCount < best.orderCount);
      if (better) best = candidate;
      return;
    }
    for (const q of optionsPerDay[d]!) {
      chosen[d] = q;
      visit(d + 1);
    }
    chosen[d] = 0;
  };
  visit(0);

  return best;
}

/** Deterministic PRNG (mulberry32) for reproducible random instances. */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
