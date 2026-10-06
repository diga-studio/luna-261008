import { test } from "node:test";
import assert from "node:assert/strict";
import { plan } from "../src/plan";
import { replay } from "../src/replay";
import type { PlanInput } from "../src/types";

test("worst-case scale: 60 days x 40 demand, pack 1, moq 1", () => {
  const days = 60;
  const input: PlanInput = {
    days,
    demand: Array.from({ length: days }, () => 40),
    fixedBatches: [],
    allowedArrivalDays: Array.from({ length: days }, (_, d) => d),
    leadTime: 0,
    packSize: 1,
    moq: 1,
  };
  const start = Date.now();
  const result = plan(input);
  const elapsed = Date.now() - start;
  assert.equal(result.feasible, true);
  if (!result.feasible) return;
  // Shelf life 3 days: one order of 120 every 3 days is optimal.
  assert.equal(result.totalQuantity, 2400);
  assert.equal(result.orderCount, 20);
  assert.equal(replay(input, result.orders).feasible, true);
  assert.ok(elapsed < 10000, `solver too slow: ${elapsed}ms`);
});

test("boundary parameters: leadTime 10, pack 12, moq 36", () => {
  const days = 15;
  const input: PlanInput = {
    days,
    demand: Array.from({ length: days }, (_, d) => (d < 10 ? 0 : 30)),
    fixedBatches: [],
    allowedArrivalDays: Array.from({ length: days }, (_, d) => d),
    leadTime: 10,
    packSize: 12,
    moq: 36,
  };
  const result = plan(input);
  assert.equal(result.feasible, true);
  if (!result.feasible) return;
  assert.equal(replay(input, result.orders).feasible, true);
  for (const order of result.orders!) {
    assert.equal(order.quantity % 12, 0);
    assert.ok(order.quantity >= 36);
    assert.ok(order.arrivalDay >= 10);
  }
});

test("zero demand everywhere needs no orders", () => {
  const input: PlanInput = {
    days: 5,
    demand: [0, 0, 0, 0, 0],
    fixedBatches: [],
    allowedArrivalDays: [0, 1, 2, 3, 4],
    leadTime: 0,
    packSize: 4,
    moq: 8,
  };
  const result = plan(input);
  assert.equal(result.feasible, true);
  if (!result.feasible) return;
  assert.equal(result.totalQuantity, 0);
  assert.deepEqual(result.orders, []);
});

test("single day horizon", () => {
  const input: PlanInput = {
    days: 1,
    demand: [7],
    fixedBatches: [],
    allowedArrivalDays: [0],
    leadTime: 0,
    packSize: 2,
    moq: 4,
  };
  const result = plan(input);
  assert.equal(result.feasible, true);
  if (!result.feasible) return;
  assert.equal(result.totalQuantity, 8);
  assert.equal(result.orderCount, 1);
});

test("randomized 60-day instances: plan always replays cleanly", () => {
  let a = 42;
  const rand = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let iter = 0; iter < 20; iter++) {
    const days = 60;
    const demand = Array.from({ length: days }, () =>
      Math.floor(rand() * 41),
    );
    const allowedArrivalDays: number[] = [];
    for (let d = 0; d < days; d++) {
      if (rand() < 0.6) allowedArrivalDays.push(d);
    }
    const fixedBatches: { arrivalDay: number; quantity: number }[] = [];
    for (let d = -2; d < days; d++) {
      if (rand() < 0.15) {
        fixedBatches.push({
          arrivalDay: d,
          quantity: 1 + Math.floor(rand() * 60),
        });
      }
    }
    const input: PlanInput = {
      days,
      demand,
      fixedBatches,
      allowedArrivalDays,
      leadTime: Math.floor(rand() * 11),
      packSize: 1 + Math.floor(rand() * 12),
      moq: 1 + Math.floor(rand() * 36),
    };
    const result = plan(input);
    if (!result.feasible) continue; // feasibility itself is checked elsewhere
    const check = replay(input, result.orders!);
    assert.equal(check.feasible, true, `replay rejected plan on iter ${iter}`);
    assert.equal(check.totalQuantity, result.totalQuantity);
    assert.equal(check.orderCount, result.orderCount);
  }
});
