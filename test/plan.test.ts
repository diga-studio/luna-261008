import { test } from "node:test";
import assert from "node:assert/strict";
import { plan } from "../src/plan";
import { replay } from "../src/replay";
import type { PlanInput } from "../src/types";

function baseInput(overrides: Partial<PlanInput>): PlanInput {
  return {
    days: 3,
    demand: [3, 3, 3],
    fixedBatches: [],
    allowedArrivalDays: [0, 1, 2],
    leadTime: 0,
    packSize: 2,
    moq: 4,
    ...overrides,
  };
}

test("spec example: one order of 10 beats daily gap filling", () => {
  const result = plan(baseInput({}));
  assert.equal(result.feasible, true);
  if (!result.feasible) return;
  assert.equal(result.totalQuantity, 10);
  assert.equal(result.orderCount, 1);
  assert.deepEqual(result.orders, [{ arrivalDay: 0, quantity: 10 }]);
  assert.equal(replay(baseInput({}), result.orders).feasible, true);
});

test("infeasible when supply expires before it can be used", () => {
  const input = baseInput({
    days: 5,
    demand: [40, 40, 40, 40, 40],
    fixedBatches: [{ arrivalDay: 0, quantity: 120 }],
    allowedArrivalDays: [],
  });
  assert.deepEqual(plan(input), { feasible: false });
});

test("infeasible when leadTime pushes the purchase day before day 0", () => {
  const input = baseInput({
    days: 2,
    demand: [5, 5],
    allowedArrivalDays: [0, 1],
    leadTime: 2,
    packSize: 1,
    moq: 1,
  });
  assert.deepEqual(plan(input), { feasible: false });
});

test("infeasible when no arrival is allowed on a day with unmet demand", () => {
  const input = baseInput({
    days: 2,
    demand: [5, 5],
    allowedArrivalDays: [1],
    packSize: 1,
    moq: 1,
  });
  assert.deepEqual(plan(input), { feasible: false });
});

test("feasible again once leadTime permits a legal purchase day", () => {
  const input = baseInput({
    days: 4,
    demand: [0, 0, 5, 5],
    allowedArrivalDays: [2, 3],
    leadTime: 2,
    packSize: 1,
    moq: 1,
  });
  const result = plan(input);
  assert.equal(result.feasible, true);
  if (!result.feasible) return;
  assert.equal(result.totalQuantity, 10);
  assert.equal(result.orderCount, 1);
  assert.deepEqual(result.orders, [{ arrivalDay: 2, quantity: 10 }]);
});

test("zero demand needs no orders", () => {
  const input = baseInput({ demand: [0, 0, 0] });
  const result = plan(input);
  assert.equal(result.feasible, true);
  if (!result.feasible) return;
  assert.equal(result.totalQuantity, 0);
  assert.equal(result.orderCount, 0);
  assert.deepEqual(result.orders, []);
});

test("fixed in-transit supply reduces purchases", () => {
  const input = baseInput({
    demand: [3, 3, 3],
    fixedBatches: [{ arrivalDay: 1, quantity: 3 }],
  });
  const result = plan(input);
  assert.equal(result.feasible, true);
  if (!result.feasible) return;
  // Remaining need is 6; one order of 6 on day 0 covers days 0..2 via shelf life.
  assert.equal(result.totalQuantity, 6);
  assert.equal(result.orderCount, 1);
  assert.equal(replay(input, result.orders).feasible, true);
});

test("MOQ and packSize force rounding up", () => {
  const input = baseInput({
    days: 1,
    demand: [3],
    allowedArrivalDays: [0],
    packSize: 4,
    moq: 8,
  });
  const result = plan(input);
  assert.equal(result.feasible, true);
  if (!result.feasible) return;
  assert.equal(result.totalQuantity, 8);
  assert.equal(result.orderCount, 1);
});

test("order count breaks ties after total quantity", () => {
  // Total 6 is achievable as one order of 6 on day 0 or two orders of 3...
  // but packSize 3 with MOQ 3: single order of 6 on day 0 wins on order count.
  const input = baseInput({
    demand: [2, 2, 2],
    packSize: 3,
    moq: 3,
  });
  const result = plan(input);
  assert.equal(result.feasible, true);
  if (!result.feasible) return;
  assert.equal(result.totalQuantity, 6);
  assert.equal(result.orderCount, 1);
});
