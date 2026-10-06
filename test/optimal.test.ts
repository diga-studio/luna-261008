import { test } from "node:test";
import assert from "node:assert/strict";
import { plan } from "../src/plan";
import { replay } from "../src/replay";
import { bruteForceOptimum, makeRng } from "./bruteforce";
import type { PlanInput } from "../src/types";

function randomInput(rng: () => number): PlanInput {
  const pick = (n: number): number => Math.floor(rng() * n);
  const days = 1 + pick(4); // 1..4 days keeps the exhaustive search small
  const demand = Array.from({ length: days }, () => pick(6)); // 0..5
  const packSize = 1 + pick(3); // 1..3
  const moq = 1 + pick(6); // 1..6
  const leadTime = pick(3); // 0..2
  const allowedArrivalDays: number[] = [];
  for (let d = 0; d < days; d++) {
    if (rng() < 0.7) allowedArrivalDays.push(d);
  }
  const fixedBatches: { arrivalDay: number; quantity: number }[] = [];
  for (let d = -2; d < days; d++) {
    if (rng() < 0.4) {
      const quantity = pick(9); // 0..8
      if (quantity > 0) fixedBatches.push({ arrivalDay: d, quantity });
    }
  }
  return { days, demand, fixedBatches, allowedArrivalDays, leadTime, packSize, moq };
}

test("plan matches the exhaustive optimum on random small instances", () => {
  const rng = makeRng(20261006);
  const instances = 300;
  let feasibleCount = 0;
  for (let i = 0; i < instances; i++) {
    const input = randomInput(rng);
    const optimum = bruteForceOptimum(input);
    const result = plan(input);

    if (optimum === null) {
      assert.equal(result.feasible, false, `instance ${i}: plan should be infeasible`);
      continue;
    }
    feasibleCount++;
    assert.equal(result.feasible, true, `instance ${i}: plan should be feasible`);
    if (!result.feasible) continue;

    assert.equal(
      result.totalQuantity,
      optimum.totalQuantity,
      `instance ${i}: total quantity mismatch`,
    );
    assert.equal(
      result.orderCount,
      optimum.orderCount,
      `instance ${i}: order count mismatch`,
    );

    const sum = result.orders.reduce((s, o) => s + o.quantity, 0);
    assert.equal(sum, result.totalQuantity, `instance ${i}: summary mismatch`);
    assert.equal(result.orders.length, result.orderCount, `instance ${i}: count mismatch`);

    const check = replay(input, result.orders);
    assert.equal(check.feasible, true, `instance ${i}: plan must survive replay`);
  }
  assert.ok(feasibleCount > instances / 2, "too few feasible random instances");
});
