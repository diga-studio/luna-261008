import { test } from "node:test";
import assert from "node:assert/strict";
import { plan } from "../src/plan";
import { replay } from "../src/replay";
import type { PlanInput } from "../src/types";

function baseInput(overrides: Partial<PlanInput>): PlanInput {
  return {
    days: 3,
    demand: [0, 0, 0],
    fixedBatches: [],
    allowedArrivalDays: [0, 1, 2],
    leadTime: 0,
    packSize: 1,
    moq: 1,
    ...overrides,
  };
}

test("classic: one order of 10 beats daily gap filling", () => {
  const input = baseInput({
    demand: [3, 3, 3],
    packSize: 2,
    moq: 4,
    leadTime: 0,
  });
  const result = plan(input);
  assert.equal(result.feasible, true);
  if (!result.feasible) return;
  assert.equal(result.totalQuantity, 10);
  assert.equal(result.orderCount, 1);
  assert.deepEqual(result.orders, [{ arrivalDay: 0, quantity: 10 }]);
  // Every returned plan must pass replay.
  const check = replay(input, result.orders);
  assert.equal(check.feasible, true);
});

test("infeasible when stock expires before demand day", () => {
  const input = baseInput({
    days: 4,
    demand: [0, 0, 0, 5],
    fixedBatches: [{ arrivalDay: 0, quantity: 100 }],
    allowedArrivalDays: [],
  });
  // Plenty of total supply, but it expires at the start of day 3.
  assert.equal(plan(input).feasible, false);
});

test("infeasible when lead time makes the only allowed day illegal", () => {
  const input = baseInput({
    days: 1,
    demand: [2],
    allowedArrivalDays: [0],
    leadTime: 1,
  });
  // Order day would be -1: cannot place the order.
  assert.equal(plan(input).feasible, false);
});

test("infeasible when demand exceeds all possible supply", () => {
  const input = baseInput({
    days: 2,
    demand: [50, 50],
    allowedArrivalDays: [],
    fixedBatches: [{ arrivalDay: 0, quantity: 10 }],
  });
  assert.equal(plan(input).feasible, false);
});

test("fixed in-transit supply is used before ordering", () => {
  const input = baseInput({
    days: 3,
    demand: [4, 4, 4],
    fixedBatches: [{ arrivalDay: 1, quantity: 8 }],
    packSize: 2,
    moq: 4,
  });
  const result = plan(input);
  assert.equal(result.feasible, true);
  if (!result.feasible) return;
  // Day 0 needs 4 (order 4 on day 0). Days 1-2 covered by the batch of 8.
  assert.equal(result.totalQuantity, 4);
  assert.equal(result.orderCount, 1);
  assert.equal(replay(input, result.orders).feasible, true);
});

test("no order is placed when fixed supply covers everything", () => {
  const input = baseInput({
    days: 3,
    demand: [2, 2, 2],
    fixedBatches: [
      { arrivalDay: 0, quantity: 3 },
      { arrivalDay: 1, quantity: 3 },
      { arrivalDay: 2, quantity: 3 },
    ],
  });
  const result = plan(input);
  assert.equal(result.feasible, true);
  if (!result.feasible) return;
  assert.equal(result.totalQuantity, 0);
  assert.equal(result.orderCount, 0);
  assert.deepEqual(result.orders, []);
});

test("moq and pack size rounding are respected", () => {
  const input = baseInput({
    days: 2,
    demand: [1, 0],
    packSize: 3,
    moq: 5,
    allowedArrivalDays: [0, 1],
  });
  const result = plan(input);
  assert.equal(result.feasible, true);
  if (!result.feasible) return;
  // Smallest legal order is max(moq, pack) rounded up to a pack multiple: 6.
  assert.equal(result.totalQuantity, 6);
  assert.equal(result.orderCount, 1);
  assert.equal(replay(input, result.orders).feasible, true);
});

test("second objective: fewer orders among equal total quantity", () => {
  // Demand 6 over 3 days, pack 1, moq 1. Total must be >= 6.
  // One order of 6 on day 0 (covers all 3 days) beats 2+2+2.
  const input = baseInput({
    days: 3,
    demand: [2, 2, 2],
    packSize: 1,
    moq: 1,
  });
  const result = plan(input);
  assert.equal(result.feasible, true);
  if (!result.feasible) return;
  assert.equal(result.totalQuantity, 6);
  assert.equal(result.orderCount, 1);
});

test("lead time shifts feasible arrival days", () => {
  const input = baseInput({
    days: 4,
    demand: [0, 0, 5, 5],
    allowedArrivalDays: [2, 3],
    leadTime: 2,
    packSize: 5,
    moq: 5,
  });
  const result = plan(input);
  assert.equal(result.feasible, true);
  if (!result.feasible) return;
  // Both arrival days are legal (order days 0 and 1).
  assert.equal(result.totalQuantity, 10);
  assert.equal(replay(input, result.orders).feasible, true);
});

test("60-day instance solves at scale", () => {
  const days = 60;
  const demand: number[] = [];
  for (let d = 0; d < days; d++) {
    demand.push((d * 7) % 41); // deterministic pseudo-random 0..40
  }
  const allowedArrivalDays: number[] = [];
  for (let d = 0; d < days; d += 2) allowedArrivalDays.push(d);
  const input = baseInput({
    days,
    demand,
    allowedArrivalDays,
    leadTime: 3,
    packSize: 6,
    moq: 12,
    fixedBatches: [
      { arrivalDay: -1, quantity: 30 },
      { arrivalDay: 2, quantity: 40 },
      { arrivalDay: 5, quantity: 50 },
    ],
  });
  const start = Date.now();
  const result = plan(input);
  const elapsed = Date.now() - start;
  assert.equal(result.feasible, true);
  if (!result.feasible) return;
  const check = replay(input, result.orders);
  assert.equal(check.feasible, true);
  assert.equal(check.totalQuantity, result.totalQuantity);
  assert.equal(check.orderCount, result.orderCount);
  assert.ok(elapsed < 10000, `solver too slow: ${elapsed}ms`);
});
