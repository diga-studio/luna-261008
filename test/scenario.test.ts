import { test } from "node:test";
import { deepEqual, equal, throws } from "node:assert/strict";
import { compare, replay } from "../src/index";
import type { SimulationInput } from "../src/index";

test("shortening floors durations and may reach zero", () => {
  const input: SimulationInput = {
    activities: [{ id: "A", samples: [10], capacity: 1 }],
    cases: [{ id: "c1", arrival: 0, path: ["A"] }],
  };
  equal(replay(input, { shorten: { A: 50 } }, "s", 0).steps[0]?.end, 5);
  // floor(10 * 0.01) = 0
  const zeroed = replay(input, { shorten: { A: 99 } }, "s", 0);
  equal(zeroed.steps[0]?.end, 0);
  equal(zeroed.completions["c1"], 0);
});

test("removing every activity completes cases at arrival", () => {
  const input: SimulationInput = {
    activities: [{ id: "A", samples: [10], capacity: 1 }],
    cases: [
      { id: "c1", arrival: 5, path: ["A", "A"] },
      { id: "c2", arrival: 9, path: ["A"] },
    ],
  };
  const result = replay(input, { remove: ["A"] }, "s", 0);
  deepEqual(result.steps, []);
  deepEqual(result.completions, { c1: 5, c2: 9 });
});

test("case with an empty path completes at arrival", () => {
  const input: SimulationInput = {
    activities: [{ id: "A", samples: [10], capacity: 1 }],
    cases: [{ id: "c1", arrival: 7, path: [] }],
  };
  deepEqual(replay(input, {}, "s", 0).completions, { c1: 7 });
});

test("compare rejects out-of-range round counts", () => {
  const input: SimulationInput = {
    activities: [{ id: "A", samples: [1], capacity: 1 }],
    cases: [{ id: "c1", arrival: 0, path: ["A"] }],
  };
  throws(() => compare(input, {}, "s", 99));
  throws(() => compare(input, {}, "s", 10001));
  throws(() => compare(input, {}, "s", 100.5));
});
