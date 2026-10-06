import { test } from "node:test";
import assert from "node:assert/strict";
import { adjustTrack } from "../src/adjust";
import { CueInput } from "../src/types";

function cue(
  start: number,
  end: number,
  minDuration: number,
  weight: number,
  locked = false,
): CueInput {
  return { start, end, minDuration, weight, locked };
}

test("acceptance: 4000ms video, two overlapping cues, weights 1 and 9", () => {
  const r = adjustTrack(
    [cue(1000, 2000, 1000, 1), cue(1500, 2500, 1000, 9)],
    4000,
  );
  assert.ok(r.ok);
  assert.deepEqual(r.cues, [
    { start: 420, end: 1420 },
    { start: 1500, end: 2500 },
  ]);
  assert.equal(r.totalCost, 1160);
});

test("acceptance: same input with equal weights picks the same earliest timeline", () => {
  const r = adjustTrack(
    [cue(1000, 2000, 1000, 1), cue(1500, 2500, 1000, 1)],
    4000,
  );
  assert.ok(r.ok);
  // Several optima with cost 1160 exist (e.g. keeping cue 1 in place and
  // shifting cue 2); the lexicographically earliest one must win.
  assert.deepEqual(r.cues, [
    { start: 420, end: 1420 },
    { start: 1500, end: 2500 },
  ]);
  assert.equal(r.totalCost, 1160);
});

test("locked cues: infeasible when the gap between them is too small", () => {
  const r = adjustTrack(
    [
      cue(1000, 2000, 500, 5, true),
      cue(2100, 2900, 1500, 1),
      cue(3000, 4000, 500, 5, true),
    ],
    10000,
  );
  // Middle cue needs 1500ms but only 3000-2000-2*80 = 840ms is available.
  assert.equal(r.ok, false);
});

test("locked cues: preserved exactly, known global optimum between them", () => {
  const r = adjustTrack(
    [
      cue(1000, 2000, 500, 5, true),
      cue(1500, 2300, 800, 3),
      cue(3000, 3600, 1000, 1),
      cue(6000, 7000, 500, 5, true),
    ],
    10000,
  );
  assert.ok(r.ok);
  assert.deepEqual(r.cues, [
    { start: 1000, end: 2000 },
    { start: 2080, end: 2880 },
    { start: 2960, end: 3960 },
    { start: 6000, end: 7000 },
  ]);
  assert.equal(r.totalCost, 3880);
});

test("locked cue conflicting with its own minimum duration is infeasible", () => {
  const r = adjustTrack([cue(1000, 2000, 1500, 5, true)], 10000);
  assert.equal(r.ok, false);
});

test("single cue whose minimum duration exceeds the video is infeasible", () => {
  const r = adjustTrack([cue(1000, 2000, 20000, 1)], 10000);
  assert.equal(r.ok, false);
});

test("empty track", () => {
  const r = adjustTrack([], 10000);
  assert.ok(r.ok);
  assert.deepEqual(r.cues, []);
  assert.equal(r.totalCost, 0);
});

test("already valid track is returned unchanged with zero cost", () => {
  const r = adjustTrack(
    [cue(0, 1000, 500, 2), cue(2000, 3000, 500, 7), cue(3080, 4000, 500, 1)],
    10000,
  );
  assert.ok(r.ok);
  assert.deepEqual(r.cues, [
    { start: 0, end: 1000 },
    { start: 2000, end: 3000 },
    { start: 3080, end: 4000 },
  ]);
  assert.equal(r.totalCost, 0);
});

test("cues are clamped to the video start", () => {
  // Cue wants to stay at (0, 500) but needs 1000ms: end pushes to 1000.
  const r = adjustTrack([cue(0, 500, 1000, 1)], 4000);
  assert.ok(r.ok);
  assert.deepEqual(r.cues, [{ start: 0, end: 1000 }]);
  assert.equal(r.totalCost, 500);
});

test("cues are clamped to the video end", () => {
  const r = adjustTrack([cue(3500, 4000, 1000, 1), cue(3600, 4000, 1000, 1)], 4000);
  assert.ok(r.ok);
  const [a, b] = r.cues;
  assert.equal(a.end - a.start >= 1000, true);
  assert.equal(b.start - a.end >= 80, true);
  assert.equal(b.end <= 4000, true);
});

test("result is deterministic", () => {
  const input = [
    cue(1000, 2000, 1000, 1),
    cue(1500, 2500, 1000, 9),
    cue(2400, 2600, 300, 4, true),
    cue(2700, 2900, 900, 2),
  ];
  const r1 = adjustTrack(input, 10000);
  const r2 = adjustTrack(input, 10000);
  assert.deepEqual(r1, r2);
});
