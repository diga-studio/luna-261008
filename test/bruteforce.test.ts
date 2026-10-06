import { test } from "node:test";
import assert from "node:assert/strict";
import { plan } from "../src/plan";
import { replay } from "../src/replay";
import { SHELF_LIFE_DAYS } from "../src/replay";
import type { Order, PlanInput } from "../src/types";

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Independent exhaustive checker: enumerates every legal order plan
 * (subsets of orderable days x every legal quantity) and finds the
 * lexicographic (totalQuantity, orderCount) optimum among plans that
 * pass replay. Exponential on purpose; only used on tiny instances.
 */
function bruteForce(input: PlanInput): {
  feasible: boolean;
  totalQuantity: number;
  orderCount: number;
} {
  const orderableDays: number[] = [];
  for (let d = 0; d < input.days; d++) {
    if (input.allowedArrivalDays.includes(d) && d - input.leadTime >= 0) {
      orderableDays.push(d);
    }
  }
  // Legal quantities per day: 0 or multiples of packSize in [moq, bound].
  // Bound derives from the input: an order can only be consumed within
  // its 3-day shelf life, so more than the window demand is never useful
  // (except that MOQ may force overshoot).
  const optionsByDay = new Map<number, number[]>();
  for (const day of orderableDays) {
    let window = 0;
    for (let d = day; d < Math.min(day + SHELF_LIFE_DAYS, input.days); d++) {
      window += input.demand[d]!;
    }
    const pack = input.packSize;
    const minOrder = Math.ceil(input.moq / pack) * pack;
    const maxOrder = Math.max(minOrder, Math.ceil(window / pack) * pack);
    const options = [0];
    for (let q = minOrder; q <= maxOrder; q += pack) options.push(q);
    optionsByDay.set(day, options);
  }

  let best: { feasible: boolean; totalQuantity: number; orderCount: number } = {
    feasible: false,
    totalQuantity: Infinity,
    orderCount: Infinity,
  };

  const orders: Order[] = [];
  const visit = (index: number): void => {
    if (index === orderableDays.length) {
      const result = replay(input, orders);
      if (!result.feasible) return;
      const qty = result.totalQuantity;
      const count = result.orderCount;
      if (
        !best.feasible ||
        qty < best.totalQuantity ||
        (qty === best.totalQuantity && count < best.orderCount)
      ) {
        best = { feasible: true, totalQuantity: qty, orderCount: count };
      }
      return;
    }
    const day = orderableDays[index]!;
    for (const q of optionsByDay.get(day)!) {
      if (q === 0) {
        visit(index + 1);
      } else {
        orders.push({ arrivalDay: day, quantity: q });
        visit(index + 1);
        orders.pop();
      }
    }
  };
  visit(0);
  return best;
}

function randomInput(rand: () => number, seed: number): PlanInput {
  const pick = (n: number): number => Math.floor(rand() * n);
  const days = 1 + pick(7); // 1..7
  const demand = Array.from({ length: days }, () => pick(7)); // 0..6
  const packSize = 1 + pick(5); // 1..5
  const moq = 1 + pick(12); // 1..12
  const leadTime = pick(4); // 0..3
  const allowedArrivalDays: number[] = [];
  for (let d = 0; d < days; d++) {
    if (rand() < 0.7) allowedArrivalDays.push(d);
  }
  const fixedBatches: { arrivalDay: number; quantity: number }[] = [];
  for (let d = -2; d < days; d++) {
    if (rand() < 0.3) {
      fixedBatches.push({ arrivalDay: d, quantity: 1 + pick(10) });
    }
  }
  void seed;
  return {
    days,
    demand,
    fixedBatches,
    allowedArrivalDays,
    leadTime,
    packSize,
    moq,
  };
}

test("plan matches exhaustive enumeration on random small instances", () => {
  const INSTANCE_COUNT = 1000;
  for (let seed = 1; seed <= INSTANCE_COUNT; seed++) {
    const rand = rng(seed * 2654435761);
    const input = randomInput(rand, seed);
    // Keep the exponential checker tractable: skip instances whose
    // enumeration space is huge. The solver itself has no such limit.
    let space = 1;
    for (let d = 0; d < input.days; d++) {
      if (
        input.allowedArrivalDays.includes(d) &&
        d - input.leadTime >= 0
      ) {
        let window = 0;
        for (let t = d; t < Math.min(d + 3, input.days); t++) {
          window += input.demand[t]!;
        }
        const minOrder = Math.ceil(input.moq / input.packSize) * input.packSize;
        const maxOrder = Math.max(
          minOrder,
          Math.ceil(window / input.packSize) * input.packSize,
        );
        space *= 2 + (maxOrder - minOrder) / input.packSize;
      }
    }
    if (space > 200000) continue;
    const expected = bruteForce(input);
    const actual = plan(input);
    assert.equal(
      actual.feasible,
      expected.feasible,
      `feasibility mismatch on seed ${seed}: ${JSON.stringify(input)}`,
    );
    if (!actual.feasible || !expected.feasible) continue;
    assert.equal(
      actual.totalQuantity,
      expected.totalQuantity,
      `total quantity mismatch on seed ${seed}: ${JSON.stringify(input)}`,
    );
    assert.equal(
      actual.orderCount,
      expected.orderCount,
      `order count mismatch on seed ${seed}: ${JSON.stringify(input)}`,
    );
    // The returned plan itself must replay cleanly.
    const check = replay(input, actual.orders!);
    assert.equal(check.feasible, true, `replay failed on seed ${seed}`);
  }
});
