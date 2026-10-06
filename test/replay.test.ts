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

test("batch expires at the start of arrival day + 3", () => {
  const input = baseInput({
    days: 4,
    demand: [0, 0, 0, 5],
    fixedBatches: [{ arrivalDay: 0, quantity: 5 }],
  });
  const result = replay(input, []);
  assert.equal(result.feasible, false);
  assert.equal(result.daily[3]!.expired, 5);
  assert.equal(result.daily[3]!.consumed, 0);
});

test("batch is usable on arrival day and the two following days", () => {
  const input = baseInput({
    days: 4,
    demand: [0, 1, 2, 1],
    fixedBatches: [{ arrivalDay: 1, quantity: 4 }],
  });
  const result = replay(input, []);
  assert.equal(result.feasible, true);
  assert.deepEqual(
    result.daily.map((d) => d.consumed),
    [0, 1, 2, 1],
  );
  assert.equal(result.totalExpired, 0);
});

test("initial stock from day -2 is usable only on day 0", () => {
  const input = baseInput({
    days: 2,
    demand: [3, 1],
    fixedBatches: [{ arrivalDay: -2, quantity: 3 }, { arrivalDay: -1, quantity: 1 }],
  });
  const result = replay(input, []);
  assert.equal(result.feasible, true);
  assert.deepEqual(
    result.daily.map((d) => d.consumed),
    [3, 1],
  );
});

test("FIFO consumes older batches before newer ones", () => {
  const input = baseInput({
    days: 4,
    demand: [0, 0, 4, 4],
    fixedBatches: [
      { arrivalDay: 1, quantity: 4 },
      { arrivalDay: 2, quantity: 4 },
    ],
  });
  const result = replay(input, []);
  assert.equal(result.feasible, true);
  // Day-1 batch would expire at start of day 4; FIFO ensures it is used on day 3.
  assert.equal(result.totalExpired, 0);
  assert.equal(result.daily[3]!.endBalance, 0);
});

test("rejects an order that is not a multiple of packSize", () => {
  const input = baseInput({ packSize: 2, moq: 2 });
  const result = replay(input, [{ arrivalDay: 0, quantity: 3 }]);
  assert.equal(result.feasible, false);
  assert.match(result.error!, /multiple of packSize/);
});

test("rejects an order below MOQ", () => {
  const input = baseInput({ packSize: 2, moq: 4 });
  const result = replay(input, [{ arrivalDay: 0, quantity: 2 }]);
  assert.equal(result.feasible, false);
  assert.match(result.error!, /MOQ/);
});

test("rejects two orders arriving on the same day", () => {
  const input = baseInput({});
  const result = replay(input, [
    { arrivalDay: 1, quantity: 2 },
    { arrivalDay: 1, quantity: 2 },
  ]);
  assert.equal(result.feasible, false);
  assert.match(result.error!, /more than one order/);
});

test("rejects arrival on a disallowed day", () => {
  const input = baseInput({ allowedArrivalDays: [0, 2] });
  const result = replay(input, [{ arrivalDay: 1, quantity: 1 }]);
  assert.equal(result.feasible, false);
  assert.match(result.error!, /not an allowed arrival day/);
});

test("rejects an order whose purchase day would be before day 0", () => {
  const input = baseInput({ leadTime: 2 });
  const result = replay(input, [{ arrivalDay: 1, quantity: 1 }]);
  assert.equal(result.feasible, false);
  assert.match(result.error!, /before day 0/);
});

test("accepts a valid order and reports balances", () => {
  const input = baseInput({
    days: 2,
    demand: [2, 2],
    packSize: 2,
    moq: 4,
    leadTime: 0,
  });
  const result = replay(input, [{ arrivalDay: 0, quantity: 4 }]);
  assert.equal(result.feasible, true);
  assert.deepEqual(
    result.daily.map((d) => d.endBalance),
    [2, 0],
  );
});
