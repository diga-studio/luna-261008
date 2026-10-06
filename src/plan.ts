import type { PlanInput, PlanResult } from "./types";

const SHELF_LIFE = 3;
const INF = Number.POSITIVE_INFINITY;

export function plan(input: PlanInput): PlanResult {
  const { days, demand, fixedBatches, allowedArrivalDays, leadTime, packSize, moq } = input;

  const demandAt = (d: number): number => (d >= 0 && d < days ? demand[d]! : 0);

  // State bounds derived from the input: stock that arrived on d-2 is only
  // useful today (<= demand[d]), stock from d-1 only today and tomorrow.
  let aMax = 0;
  let bMax = 0;
  for (let d = 0; d < days; d++) {
    aMax = Math.max(aMax, demandAt(d));
    bMax = Math.max(bMax, demandAt(d) + demandAt(d + 1));
  }
  const stateCount = (aMax + 1) * (bMax + 1);
  const stateKey = (a: number, b: number): number => a * (bMax + 1) + b;

  const fixedByDay = new Map<number, number>();
  for (const batch of fixedBatches) {
    fixedByDay.set(batch.arrivalDay, (fixedByDay.get(batch.arrivalDay) ?? 0) + batch.quantity);
  }
  const fixedAt = (d: number): number => fixedByDay.get(d) ?? 0;

  const allowed = new Set(allowedArrivalDays);
  const qMin = Math.ceil(moq / packSize) * packSize;

  // Order quantity candidates per day: 0, or a multiple of packSize in [qMin, qMax].
  // qMax never exceeds the demand usable within the shelf-life window (plus the
  // minimum order), so the search bound is derived from the input, not fixed.
  const orderOptions: number[][] = [];
  for (let d = 0; d < days; d++) {
    const options: number[] = [0];
    if (allowed.has(d) && d - leadTime >= 0) {
      const window = demandAt(d) + demandAt(d + 1) + demandAt(d + 2);
      const qMax = Math.max(qMin, Math.ceil(window / packSize) * packSize);
      for (let q = qMin; q <= qMax; q += packSize) options.push(q);
    }
    orderOptions.push(options);
  }

  // Cost packs (totalQuantity, orderCount) lexicographically into one number.
  const costOf = (qty: number, count: number): number => qty * (days + 1) + count;

  // DP state at the start of day d (after expiry removal, before arrivals):
  //   a = remaining stock that arrived on d-2 (expires at end of day d)
  //   b = remaining stock that arrived on d-1
  // Stock beyond what can be consumed before expiry is useless, so:
  //   a <= demand[d], b <= demand[d] + demand[d+1].
  let cur = new Float64Array(stateCount).fill(INF);
  const prevKeyOf: Int32Array[] = [];
  const orderQtyOf: Int32Array[] = [];

  const initA = Math.min(fixedAt(-2), demandAt(0));
  const initB = Math.min(fixedAt(-1), demandAt(0) + demandAt(1));
  cur[stateKey(initA, initB)] = costOf(0, 0);

  for (let d = 0; d < days; d++) {
    const dem = demandAt(d);
    const fixed = fixedAt(d);
    const aCapNext = demandAt(d + 1);
    const bCapNext = demandAt(d + 1) + demandAt(d + 2);
    const next = new Float64Array(stateCount).fill(INF);
    const prevKey = new Int32Array(stateCount).fill(-1);
    const orderQty = new Int32Array(stateCount).fill(0);

    for (let a = 0; a <= Math.min(aMax, dem); a++) {
      for (let b = 0; b <= Math.min(bMax, dem + demandAt(d + 1)); b++) {
        const base = cur[stateKey(a, b)]!;
        if (base === INF) continue;
        const carried = a + b + fixed;
        for (const q of orderOptions[d]!) {
          if (carried + q < dem) continue;
          // FIFO: oldest (a) first, then b, then today's arrivals.
          const remAfterA = dem - Math.min(a, dem);
          const fromB = Math.min(b, remAfterA);
          const fromNew = remAfterA - fromB;
          const a2 = Math.min(b - fromB, aCapNext);
          const b2 = Math.min(fixed + q - fromNew, bCapNext);
          const key2 = stateKey(a2, b2);
          const cost = base + (q > 0 ? costOf(q, 1) : 0);
          if (cost < next[key2]!) {
            next[key2] = cost;
            prevKey[key2] = stateKey(a, b);
            orderQty[key2] = q;
          }
        }
      }
    }

    cur = next;
    prevKeyOf.push(prevKey);
    orderQtyOf.push(orderQty);
  }

  let bestKey = -1;
  let bestCost = INF;
  for (let key = 0; key < stateCount; key++) {
    if (cur[key]! < bestCost) {
      bestCost = cur[key]!;
      bestKey = key;
    }
  }
  if (bestKey < 0) return { feasible: false };

  const orders: { arrivalDay: number; quantity: number }[] = [];
  let key = bestKey;
  for (let d = days - 1; d >= 0; d--) {
    const q = orderQtyOf[d]![key]!;
    if (q > 0) orders.push({ arrivalDay: d, quantity: q });
    key = prevKeyOf[d]![key]!;
  }
  orders.reverse();

  const totalQuantity = orders.reduce((sum, o) => sum + o.quantity, 0);
  return { feasible: true, orders, totalQuantity, orderCount: orders.length };
}
