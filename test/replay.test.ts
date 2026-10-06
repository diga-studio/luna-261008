import { test } from "node:test";
import assert from "node:assert/strict";
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

test("fifo consumption and expiry at arrival+3", () => {
  const input = baseInput({
    days: 4,
    demand: [2, 2, 2, 2],
    fixedBatches: [{ arrivalDay: 0, quantity: 5 }],
    allowedArrivalDays: [],
  });
  const result = replay(input, []);
  // Day 0: consume 2, balance 3. Day 1: consume 2, balance 1.
  // Day 2: consume 1 (batch empties), shortage 1 -> infeasible.
  assert.equal(result.days[0]!.consumed, 2);
  assert.equal(result.days[0]!.balance, 3);
  assert.equal(result.days[1]!.consumed, 2);
  assert.equal(result.days[2]!.consumed, 1);
  assert.equal(result.feasible, false);
  assert.equal(result.shortageDay, 2);
});

test("batch expires at start of arrival day + 3", () => {
  const input = baseInput({
    days: 4,
    demand: [0, 0, 0, 1],
    fixedBatches: [{ arrivalDay: 0, quantity: 10 }],
    allowedArrivalDays: [],
  });
  const result = replay(input, []);
  // Usable on days 0,1,2; expires at start of day 3.
  assert.equal(result.days[3]!.expired, 10);
  assert.equal(result.days[3]!.consumed, 0);
  assert.equal(result.feasible, false);
  assert.equal(result.shortageDay, 3);
});

test("initial stock with negative arrival days ages correctly", () => {
  const input = baseInput({
    days: 3,
    demand: [0, 1, 0],
    fixedBatches: [{ arrivalDay: -2, quantity: 3 }],
    allowedArrivalDays: [],
  });
  const result = replay(input, []);
  // Arrived day -2: usable days -2..0, expires at start of day 1.
  assert.equal(result.days[0]!.expired, 0);
  assert.equal(result.days[0]!.balance, 3);
  assert.equal(result.days[1]!.expired, 3);
  assert.equal(result.shortageDay, 1);
  assert.equal(result.feasible, false);
});

test("orders arriving same day are usable that day", () => {
  const input = baseInput({
    days: 1,
    demand: [4],
    allowedArrivalDays: [0],
    packSize: 2,
    moq: 4,
  });
  const result = replay(input, [{ arrivalDay: 0, quantity: 4 }]);
  assert.equal(result.feasible, true);
  assert.equal(result.days[0]!.consumed, 4);
  assert.equal(result.totalQuantity, 4);
  assert.equal(result.orderCount, 1);
});

test("rejects orders violating constraints", () => {
  const input = baseInput({
    days: 2,
    demand: [2, 2],
    allowedArrivalDays: [0],
    leadTime: 1,
    packSize: 2,
    moq: 4,
  });
  // Arrival day 0 with leadTime 1 -> order day -1, illegal.
  assert.equal(replay(input, [{ arrivalDay: 0, quantity: 4 }]).feasible, false);
  // Not a multiple of packSize.
  assert.equal(replay(input, [{ arrivalDay: 0, quantity: 3 }]).feasible, false);
  // Below MOQ.
  assert.equal(replay(input, [{ arrivalDay: 0, quantity: 2 }]).feasible, false);
  // Arrival day not allowed.
  assert.equal(replay(input, [{ arrivalDay: 1, quantity: 4 }]).feasible, false);
  // Two orders on the same day.
  assert.equal(
    replay(input, [
      { arrivalDay: 0, quantity: 4 },
      { arrivalDay: 0, quantity: 4 },
    ]).feasible,
    false,
  );
  // Non-positive quantity.
  assert.equal(replay(input, [{ arrivalDay: 0, quantity: 0 }]).feasible, false);
});

test("fifo prefers older batches over fresh orders", () => {
  const input = baseInput({
    days: 2,
    demand: [3, 0],
    fixedBatches: [{ arrivalDay: 0, quantity: 5 }],
    allowedArrivalDays: [0],
    packSize: 1,
    moq: 1,
  });
  const result = replay(input, [{ arrivalDay: 0, quantity: 4 }]);
  // Day 0 consumes 3 from the fixed batch; day 1 consumes 0.
  // Day 2: nothing expires yet (fixed expires start of day 3).
  assert.equal(result.days[0]!.balance, 6);
  assert.equal(result.feasible, true);
});
