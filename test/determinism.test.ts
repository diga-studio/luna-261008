import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { compare, replay } from "../src/index";
import type { SimulationInput } from "../src/index";

/** Small deterministic PRNG for building test workloads. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function makeInput(rand: () => number): SimulationInput {
  const activities = ["A", "B", "C", "D"].map((id) => ({
    id,
    samples: Array.from({ length: 5 }, () => Math.floor(rand() * 40)),
    capacity: 1 + Math.floor(rand() * 3),
  }));
  const cases = Array.from({ length: 40 }, (_, i) => ({
    id: `case-${i}`,
    arrival: Math.floor(rand() * 500),
    path: Array.from(
      { length: 2 + Math.floor(rand() * 5) },
      () => (activities[Math.floor(rand() * activities.length)] as { id: string }).id,
    ),
  }));
  return { activities, cases };
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

test("same seed and round reproduce identical results", () => {
  const input = makeInput(lcg(42));
  const scenario = { shorten: { A: 30 }, capacity: { B: 2 } };
  deepEqual(replay(input, scenario, "s", 7), replay(input, scenario, "s", 7));
});

test("shuffling case and sample input order changes nothing", () => {
  const input = makeInput(lcg(7));
  const rand = lcg(99);
  const shuffled: SimulationInput = {
    activities: input.activities.map((a) => ({ ...a, samples: shuffle(a.samples, rand) })),
    cases: shuffle(input.cases, rand),
  };
  const scenario = { remove: ["B"], shorten: { C: 50 }, capacity: { A: 1 } };
  deepEqual(replay(input, scenario, "seed", 3), replay(shuffled, scenario, "seed", 3));
});

test("removing a middle step keeps retained steps' raw sampling", () => {
  const input: SimulationInput = {
    activities: [
      { id: "A", samples: [3, 4, 5, 6, 7], capacity: 2 },
      { id: "B", samples: [11, 13], capacity: 1 },
      { id: "C", samples: [2, 8, 9], capacity: 2 },
    ],
    cases: Array.from({ length: 12 }, (_, i) => ({
      id: `k${i}`,
      arrival: i * 3,
      path: ["A", "B", "C", "A"],
    })),
  };
  const baseline = replay(input, {}, "seed", 5);
  const removed = replay(input, { remove: ["B"] }, "seed", 5);
  const durationOf = (steps: typeof baseline.steps) => {
    const map = new Map<string, number>();
    for (const s of steps) map.set(`${s.caseId}|${s.stepIndex}`, s.end - s.start);
    return map;
  };
  const baseDur = durationOf(baseline.steps);
  for (const step of removed.steps) {
    equal(
      step.end - step.start,
      baseDur.get(`${step.caseId}|${step.stepIndex}`),
      `duration of ${step.caseId} step ${step.stepIndex} changed after removal`,
    );
  }
  // Removed steps keep their original indices: 0,2,3 remain, 1 is gone.
  deepEqual(
    removed.steps.filter((s) => s.caseId === "k0").map((s) => s.stepIndex),
    [0, 2, 3],
  );
});

test("empty scenario matches baseline exactly", () => {
  const input = makeInput(lcg(123));
  deepEqual(
    replay(input, {}, "seed", 2),
    replay(input, { remove: [], shorten: {}, capacity: {} }, "seed", 2),
  );
  const result = compare(input, {}, "seed", 100);
  equal(result.diff.mean, 0);
  equal(result.diff.median, 0);
  deepEqual(result.baseline, result.scenario);
});
