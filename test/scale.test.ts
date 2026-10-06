import { test } from "node:test";
import assert from "node:assert/strict";
import { plan } from "../src/plan";
import { replay } from "../src/replay";
import { makeRng } from "./bruteforce";
import type { PlanInput } from "../src/types";

test("60-day instance with known optimum: 20 orders of 120", () => {
  const input: PlanInput = {
    days: 60,
    demand: Array.from({ length: 60 }, () => 40),
    fixedBatches: [],
    allowedArrivalDays: Array.from({ length: 60 }, (_, d) => d),
    leadTime: 0,
    packSize: 12,
    moq: 36,
  };
  const started = Date.now();
  const result = plan(input);
  const elapsed = Date.now() - started;
  assert.equal(result.feasible, true);
  if (!result.feasible) return;
  // Shelf life is 3 days, so every 3-day window needs 120 units; the optimum
  // is one order of 120 on days 0, 3, ..., 57.
  assert.equal(result.totalQuantity, 2400);
  assert.equal(result.orderCount, 20);
  assert.equal(replay(input, result.orders).feasible, true);
  assert.ok(elapsed < 10_000, `solver too slow: ${elapsed}ms`);
});

test("60-day randomized instance solves and replays feasibly", () => {
  const rng = makeRng(60);
  const pick = (n: number): number => Math.floor(rng() * n);
  const days = 60;
  const demand = Array.from({ length: days }, () => pick(41)); // 0..40
  const allowedArrivalDays = Array.from({ length: days }, (_, d) => d).filter(
    () => rng() < 0.8,
  );
  const fixedBatches: { arrivalDay: number; quantity: number }[] = [];
  for (let d = -2; d < days; d++) {
    if (rng() < 0.3) {
      const quantity = pick(121); // 0..120 per arrival day
      if (quantity > 0) fixedBatches.push({ arrivalDay: d, quantity });
    }
  }
  const input: PlanInput = {
    days,
    demand,
    fixedBatches,
    allowedArrivalDays,
    leadTime: pick(11), // 0..10
    packSize: 1 + pick(12), // 1..12
    moq: 1 + pick(36), // 1..36
  };
  const started = Date.now();
  const result = plan(input);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10_000, `solver too slow: ${elapsed}ms`);
  if (!result.feasible) {
    // Infeasible is acceptable for random input, but the check below covers
    // the feasible path; force feasibility by construction in the next test.
    return;
  }
  const check = replay(input, result.orders);
  assert.equal(check.feasible, true);
  assert.equal(
    result.orders.reduce((sum, o) => sum + o.quantity, 0),
    result.totalQuantity,
  );
});

test("60-day guaranteed-feasible instance with leadTime 10", () => {
  const rng = makeRng(610);
  const pick = (n: number): number => Math.floor(rng() * n);
  const days = 60;
  const demand = Array.from({ length: days }, () => pick(41));
  const input: PlanInput = {
    days,
    demand,
    // Confirmed in-transit supply covers the horizon until the first legal
    // new order can arrive (day 10, because leadTime is 10).
    fixedBatches: Array.from({ length: 10 }, (_, d) => ({
      arrivalDay: d,
      quantity: 120,
    })),
    allowedArrivalDays: Array.from({ length: days }, (_, d) => d),
    leadTime: 10,
    packSize: 12,
    moq: 36,
  };
  const started = Date.now();
  const result = plan(input);
  const elapsed = Date.now() - started;
  assert.equal(result.feasible, true);
  if (!result.feasible) return;
  assert.equal(replay(input, result.orders).feasible, true);
  assert.ok(elapsed < 10_000, `solver too slow: ${elapsed}ms`);
});
