import { test } from "node:test";
import { deepEqual } from "node:assert/strict";
import { replay } from "../src/index";
import type { SimulationInput } from "../src/index";

test("queue propagates across two activities (hand-computed)", () => {
  const input: SimulationInput = {
    activities: [
      { id: "A", samples: [10], capacity: 1 },
      { id: "B", samples: [5], capacity: 1 },
    ],
    cases: [
      { id: "c1", arrival: 0, path: ["A", "B"] },
      { id: "c2", arrival: 0, path: ["A", "B"] },
      { id: "c3", arrival: 2, path: ["A", "B"] },
    ],
  };
  const result = replay(input, {}, "seed", 0);
  deepEqual(result.steps, [
    { caseId: "c1", activityId: "A", stepIndex: 0, ready: 0, start: 0, end: 10 },
    { caseId: "c2", activityId: "A", stepIndex: 0, ready: 0, start: 10, end: 20 },
    { caseId: "c1", activityId: "B", stepIndex: 1, ready: 10, start: 10, end: 15 },
    { caseId: "c3", activityId: "A", stepIndex: 0, ready: 2, start: 20, end: 30 },
    { caseId: "c2", activityId: "B", stepIndex: 1, ready: 20, start: 20, end: 25 },
    { caseId: "c3", activityId: "B", stepIndex: 1, ready: 30, start: 30, end: 35 },
  ]);
  deepEqual(result.completions, { c1: 15, c2: 25, c3: 35 });
});

test("repeated activity reuses its pool serially per case", () => {
  const input: SimulationInput = {
    activities: [{ id: "A", samples: [10], capacity: 1 }],
    cases: [{ id: "c1", arrival: 0, path: ["A", "A"] }],
  };
  const result = replay(input, {}, "seed", 0);
  deepEqual(result.steps, [
    { caseId: "c1", activityId: "A", stepIndex: 0, ready: 0, start: 0, end: 10 },
    { caseId: "c1", activityId: "A", stepIndex: 1, ready: 10, start: 10, end: 20 },
  ]);
  deepEqual(result.completions, { c1: 20 });
});

test("zero-duration cascade and same-time completions", () => {
  const input: SimulationInput = {
    activities: [
      { id: "Z", samples: [0], capacity: 1 },
      { id: "B", samples: [5], capacity: 1 },
    ],
    cases: [
      { id: "c1", arrival: 0, path: ["Z", "Z", "B"] },
      { id: "c2", arrival: 0, path: ["B"] },
      { id: "c3", arrival: 0, path: ["Z"] },
    ],
  };
  const result = replay(input, {}, "seed", 0);
  deepEqual(result.steps, [
    { caseId: "c1", activityId: "Z", stepIndex: 0, ready: 0, start: 0, end: 0 },
    { caseId: "c2", activityId: "B", stepIndex: 0, ready: 0, start: 0, end: 5 },
    { caseId: "c1", activityId: "Z", stepIndex: 1, ready: 0, start: 0, end: 0 },
    { caseId: "c3", activityId: "Z", stepIndex: 0, ready: 0, start: 0, end: 0 },
    { caseId: "c1", activityId: "B", stepIndex: 2, ready: 0, start: 5, end: 10 },
  ]);
  deepEqual(result.completions, { c1: 10, c2: 5, c3: 0 });
});

test("higher capacity lets services overlap", () => {
  const input: SimulationInput = {
    activities: [{ id: "A", samples: [10], capacity: 1 }],
    cases: [
      { id: "c1", arrival: 0, path: ["A"] },
      { id: "c2", arrival: 0, path: ["A"] },
    ],
  };
  const serial = replay(input, {}, "seed", 0);
  deepEqual(serial.steps, [
    { caseId: "c1", activityId: "A", stepIndex: 0, ready: 0, start: 0, end: 10 },
    { caseId: "c2", activityId: "A", stepIndex: 0, ready: 0, start: 10, end: 20 },
  ]);
  const parallel = replay(input, { capacity: { A: 2 } }, "seed", 0);
  deepEqual(parallel.steps, [
    { caseId: "c1", activityId: "A", stepIndex: 0, ready: 0, start: 0, end: 10 },
    { caseId: "c2", activityId: "A", stepIndex: 0, ready: 0, start: 0, end: 10 },
  ]);
  deepEqual(parallel.completions, { c1: 10, c2: 10 });
});
