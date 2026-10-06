import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { compare, replay } from "../src/index";
import type { SimulationInput } from "../src/index";

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test("single round at full scale: 20 activities, 20000 cases, 200000 steps, 1e12 span", () => {
  const rand = lcg(2024);
  const activityCount = 20;
  const caseCount = 20000;
  const stepsPerCase = 10;
  const activities = Array.from({ length: activityCount }, (_, i) => ({
    id: `act-${i}`,
    samples: Array.from({ length: 8 }, () => Math.floor(rand() * 1000)),
    capacity: 1 + Math.floor(rand() * 50),
  }));
  const cases = Array.from({ length: caseCount }, (_, i) => ({
    id: `case-${i}`,
    arrival: Math.floor(rand() * 1e12),
    path: Array.from(
      { length: stepsPerCase },
      () => `act-${Math.floor(rand() * activityCount)}`,
    ),
  }));
  const input: SimulationInput = { activities, cases };
  const scenario = {
    remove: ["act-0"],
    shorten: { "act-1": 25 },
    capacity: { "act-2": 50 },
  };
  const started = Date.now();
  const result = replay(input, scenario, "scale-seed", 0);
  const elapsed = Date.now() - started;
  const expectedSteps = cases.reduce(
    (acc, c) => acc + c.path.filter((a) => a !== "act-0").length,
    0,
  );
  equal(result.steps.length, expectedSteps);
  equal(Object.keys(result.completions).length, caseCount);
  for (const c of cases) {
    ok((result.completions[c.id] as number) >= c.arrival);
  }
  ok(elapsed < 20000, `single round took ${elapsed}ms`);
});

test("compare runs 10000 paired rounds on a small input", () => {
  const rand = lcg(7);
  const input: SimulationInput = {
    activities: [
      { id: "A", samples: [1, 2, 3, 10], capacity: 1 },
      { id: "B", samples: [0, 5], capacity: 2 },
    ],
    cases: Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      arrival: i * 4,
      path: ["A", "B", "A"],
    })),
  };
  void rand;
  const scenario = { shorten: { A: 50 }, capacity: { A: 2 } };
  const first = compare(input, scenario, "cmp", 10000);
  const second = compare(input, scenario, "cmp", 10000);
  deepEqual(first, second);
  ok(Number.isFinite(first.baseline.mean));
  ok(Number.isFinite(first.scenario.median));
  // More capacity and shorter durations cannot increase the mean duration.
  ok(first.diff.mean <= 0, `expected non-positive diff, got ${first.diff.mean}`);
});
