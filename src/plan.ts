import type { Order, PlanInput, PlanResult } from "./types";
import { SHELF_LIFE_DAYS } from "./replay";

const INF = 0x3fffffff;
// Lexicographic cost (totalQuantity, orderCount) packed into one integer:
// orderCount never exceeds the number of days (<= 60 < 64).
const ORDER_SLOTS = 64;

/**
 * Exact dynamic program over daily stock-age states.
 *
 * State entering day d: (older, newer) = leftover quantities that arrived
 * on days d-2 and d-1 (older stock expires at the start of day d+1).
 * Transition: remove nothing (expiry is implicit in the state shift),
 * receive fixed supply plus at most one new order, satisfy the day's
 * demand FIFO, then carry the two youngest leftover classes into day d+1.
 *
 * Order quantities are bounded by input-derived limits only: an order can
 * only be consumed within its 3-day shelf life, so anything beyond the
 * demand of the arrival window (plus what MOQ forces) is provably useless.
 *
 * States are pruned by exact dominance: state A dominates B when A holds
 * at least as much stock of every age class at no worse lexicographic
 * cost. This keeps the solver exact while supporting 60-day horizons.
 */
export function plan(input: PlanInput): PlanResult {
  const days = input.days;
  const demand = input.demand;
  const pack = input.packSize;
  const allowed = new Set(input.allowedArrivalDays);

  const fixedByDay = new Array<number>(days).fill(0);
  let initOlder = 0; // arrived day -2, expires at the start of day 1
  let initNewer = 0; // arrived day -1, expires at the start of day 2
  for (const batch of input.fixedBatches) {
    if (batch.arrivalDay === -2) initOlder += batch.quantity;
    else if (batch.arrivalDay === -1) initNewer += batch.quantity;
    else if (batch.arrivalDay >= 0 && batch.arrivalDay < days) {
      fixedByDay[batch.arrivalDay]! += batch.quantity;
    }
  }

  const canOrder = (day: number): boolean =>
    allowed.has(day) && day - input.leadTime >= 0;

  const minOrder = Math.ceil(input.moq / pack) * pack;

  // Largest quantity an order arriving on any day could ever usefully
  // have: the demand of its 3-day consumption window, rounded up to a
  // pack multiple, but at least the MOQ. Purely input-derived.
  let maxOrderQty = 0;
  for (let day = 0; day < days; day++) {
    if (!canOrder(day)) continue;
    let window = 0;
    for (let t = day; t < Math.min(day + SHELF_LIFE_DAYS, days); t++) {
      window += demand[t]!;
    }
    const cap = Math.max(minOrder, Math.ceil(window / pack) * pack);
    if (cap > maxOrderQty) maxOrderQty = cap;
  }

  let maxFixed = Math.max(initOlder, initNewer);
  for (let day = 0; day < days; day++) {
    maxFixed = Math.max(maxFixed, fixedByDay[day]!);
  }
  // Stock of one age class never exceeds one day's fixed supply plus one
  // maximal order. State keys are (older, newer) pairs in [0, K)^2.
  const K = maxFixed + maxOrderQty + 1;
  const size = K * K;

  const keyOf = (older: number, newer: number): number => older * K + newer;

  let costs = new Int32Array(size).fill(INF);
  costs[keyOf(initOlder, initNewer)] = 0;
  let live: number[] = [keyOf(initOlder, initNewer)];

  const parentKeys: Int32Array[] = [];
  const orderQtys: Int32Array[] = [];
  const suffix = new Int32Array((K + 1) * (K + 1));

  for (let day = 0; day < days; day++) {
    const dem = demand[day]!;
    const fixed = fixedByDay[day]!;
    const demNext1 = day + 1 < days ? demand[day + 1]! : 0;
    const demNext2 = day + 2 < days ? demand[day + 2]! : 0;
    const orderable = canOrder(day);

    const next = new Int32Array(size).fill(INF);
    const parent = new Int32Array(size);
    const orderQty = new Int32Array(size);

    for (const key of live) {
      const older = (key / K) | 0;
      const newer = key - older * K;
      const cost = costs[key]!;
      const qty = Math.floor(cost / ORDER_SLOTS);
      const ords = cost - qty * ORDER_SLOTS;

      // FIFO: oldest class first, then newer, then today's arrivals.
      const takeOlder = Math.min(older, dem);
      const rem1 = dem - takeOlder;
      const takeNewer = Math.min(newer, rem1);
      const needed = rem1 - takeNewer; // must come from today's arrivals
      const newerLeft = newer - takeNewer;

      if (fixed >= needed) {
        // No purchase required today.
        const nk = keyOf(newerLeft, fixed - needed);
        if (cost < next[nk]!) {
          next[nk] = cost;
          parent[nk] = key;
          orderQty[nk] = 0;
        }
      }

      if (!orderable) continue;

      // Leftover arriving today can only be consumed on day+1 and day+2,
      // where it is FIFO-ahead of later arrivals: at most
      // max(0, demNext1 - newerLeft) + demNext2 units are absorbable.
      const absorb = Math.max(0, demNext1 - newerLeft) + demNext2;
      const needQty = needed - fixed; // > 0: purchase required today
      const qLow = Math.max(
        minOrder,
        Math.ceil(Math.max(0, needQty) / pack) * pack,
      );
      // Round up: pack granularity may force at most pack-1 units of
      // unavoidable waste on top of the absorbable window.
      const qHigh = Math.ceil((absorb + needed - fixed) / pack) * pack;

      if (qHigh >= qLow) {
        for (let q = qLow; q <= qHigh; q += pack) {
          const nk = keyOf(newerLeft, fixed + q - needed);
          const ncost = (qty + q) * ORDER_SLOTS + ords + 1;
          if (ncost < next[nk]!) {
            next[nk] = ncost;
            parent[nk] = key;
            orderQty[nk] = q;
          }
        }
      } else {
        // Every legal quantity overshoots the absorbable window (typically
        // because of the MOQ). Only the smallest legal quantity can be
        // useful. It is certainly useful when today's demand cannot be
        // met without it; otherwise only if leftover stock plus certain
        // future fixed supply cannot cover the rest of the window.
        // Simulate the next two days exactly (FIFO, per-age expiry).
        let useful = needQty > 0;
        if (!useful) {
          const fixed1 = day + 1 < days ? fixedByDay[day + 1]! : 0;
          const fixed2 = day + 2 < days ? fixedByDay[day + 2]! : 0;
          const arrivedLeft = fixed - needed; // >= 0 because needQty <= 0
          let covered = true;
          let carryB = arrivedLeft; // arrived today, usable day+1, day+2
          if (newerLeft + arrivedLeft + fixed1 < demNext1) {
            covered = false;
          } else {
            const useA = Math.min(newerLeft, demNext1);
            const rem1 = demNext1 - useA;
            const useB = Math.min(carryB, rem1);
            carryB -= useB;
            const fixed1Left = fixed1 - (rem1 - useB);
            if (carryB + fixed1Left + fixed2 < demNext2) {
              covered = false;
            }
          }
          useful = !covered;
        }
        if (useful && fixed + qLow >= needed) {
          const nk = keyOf(newerLeft, fixed + qLow - needed);
          const ncost = (qty + qLow) * ORDER_SLOTS + ords + 1;
          if (ncost < next[nk]!) {
            next[nk] = ncost;
            parent[nk] = key;
            orderQty[nk] = qLow;
          }
        }
      }
    }

    // Dominance pruning via 2D suffix minima over the cost array:
    // state s is dominated iff some other state with older' >= older and
    // newer' >= newer has cost' <= cost(s).
    const W = K + 1;
    suffix.fill(INF);
    for (let o = K - 1; o >= 0; o--) {
      for (let n = K - 1; n >= 0; n--) {
        const value = next[o * K + n]!;
        const right = suffix[o * W + (n + 1)]!;
        const below = suffix[(o + 1) * W + n]!;
        const diag = suffix[(o + 1) * W + (n + 1)]!;
        let m = value < right ? value : right;
        const b = below < diag ? below : diag;
        if (b < m) m = b;
        suffix[o * W + n] = m;
      }
    }

    const nextLive: number[] = [];
    for (let o = 0; o < K; o++) {
      for (let n = 0; n < K; n++) {
        const key = o * K + n;
        const cost = next[key]!;
        if (cost === INF) continue;
        const rival = Math.min(
          suffix[(o + 1) * W + n]!,
          suffix[o * W + (n + 1)]!,
        );
        if (rival > cost) {
          nextLive.push(key);
        }
      }
    }

    if (nextLive.length === 0) {
      return { feasible: false };
    }
    costs = next;
    live = nextLive;
    parentKeys.push(parent);
    orderQtys.push(orderQty);
  }

  let bestKey = -1;
  let bestCost = INF;
  for (const key of live) {
    const cost = costs[key]!;
    if (cost < bestCost) {
      bestCost = cost;
      bestKey = key;
    }
  }

  const totalQuantity = Math.floor(bestCost / ORDER_SLOTS);
  const orderCount = bestCost - totalQuantity * ORDER_SLOTS;

  const orders: Order[] = [];
  let key = bestKey;
  for (let day = days - 1; day >= 0; day--) {
    const q = orderQtys[day]![key]!;
    if (q > 0) {
      orders.push({ arrivalDay: day, quantity: q });
    }
    key = parentKeys[day]![key]!;
  }
  orders.reverse();

  return { feasible: true, orders, totalQuantity, orderCount };
}
