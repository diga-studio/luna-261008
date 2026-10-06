import { test } from "node:test";
import assert from "node:assert/strict";
import { adjustTrack } from "../src/adjust";
import { CueInput } from "../src/types";

const N = 100000;
const GAP = 80;
const MIN_DUR = 1000;
const VIDEO = 600_000_000; // ~6.9 days, near the 7-day maximum
const ORIG_START = 400_000_000;
const ORIG_SPACING = 1000; // tighter than MIN_DUR+GAP, forcing compression

function weightOf(k: number): number {
  return (k % 9) + 1;
}

// Cumulative minimal offsets, recomputed independently here.
function buildOffsets(): number[] {
  const P = new Array<number>(2 * N);
  P[0] = 0;
  for (let k = 0; k < N; k++) {
    P[2 * k + 1] = P[2 * k] + MIN_DUR;
    if (k + 1 < N) P[2 * k + 2] = P[2 * k + 1] + GAP;
  }
  return P;
}

test("100000 cues: known global optimum, within time and memory limits", () => {
  const P = buildOffsets();

  // Original times: evenly spaced but too tightly, so the whole track must
  // be re-spaced. In offset space every target is strictly decreasing, so
  // the optimal timeline assigns every boundary the lower weighted median
  // of all targets.
  const targets: { value: number; weight: number }[] = [];
  for (let k = 0; k < N; k++) {
    const origStart = ORIG_START + ORIG_SPACING * k;
    const origEnd = origStart + 500;
    targets.push({ value: origStart - P[2 * k], weight: weightOf(k) });
    targets.push({ value: origEnd - P[2 * k + 1], weight: weightOf(k) });
  }
  targets.sort((a, b) => a.value - b.value);
  const totalWeight = targets.reduce((s, t) => s + t.weight, 0);
  let cum = 0;
  let median = 0;
  for (const t of targets) {
    cum += t.weight;
    if (cum * 2 >= totalWeight) {
      median = t.value;
      break;
    }
  }

  // Expected timeline: every boundary at median + P[j].
  const expectedStart = (k: number) => median + P[2 * k];
  const expectedEnd = (k: number) => median + P[2 * k + 1];

  // Build the input; every 997th cue is locked at its expected position,
  // which keeps the unconstrained optimum feasible (hence still optimal).
  const cues: CueInput[] = [];
  let expectedCost = 0;
  for (let k = 0; k < N; k++) {
    const locked = k % 997 === 0;
    const origStart = locked ? expectedStart(k) : ORIG_START + ORIG_SPACING * k;
    const origEnd = locked ? expectedEnd(k) : origStart + 500;
    cues.push({ start: origStart, end: origEnd, minDuration: MIN_DUR, weight: weightOf(k), locked });
    if (!locked) {
      expectedCost +=
        weightOf(k) *
        (Math.abs(expectedStart(k) - origStart) + Math.abs(expectedEnd(k) - origEnd));
    }
  }

  const memBefore = process.memoryUsage().heapUsed;
  const t0 = process.hrtime.bigint();
  const r = adjustTrack(cues, VIDEO, GAP);
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const memAfter = process.memoryUsage().heapUsed;
  const memDeltaMiB = (memAfter - memBefore) / (1024 * 1024);
  console.log(
    `    100k cues: ${elapsedMs.toFixed(0)}ms, heap delta ${memDeltaMiB.toFixed(1)} MiB`,
  );

  assert.ok(r.ok, "expected a feasible result");
  assert.equal(r.totalCost, expectedCost);
  assert.equal(r.cues.length, N);
  for (let k = 0; k < N; k++) {
    assert.equal(r.cues[k].start, expectedStart(k), `start of cue ${k}`);
    assert.equal(r.cues[k].end, expectedEnd(k), `end of cue ${k}`);
  }

  // Hard constraints on the returned timeline.
  assert.ok(r.cues[0].start >= 0);
  assert.ok(r.cues[N - 1].end <= VIDEO);
  for (let k = 0; k < N; k++) {
    assert.ok(r.cues[k].end - r.cues[k].start >= MIN_DUR, `duration of cue ${k}`);
    if (k + 1 < N) {
      assert.ok(r.cues[k + 1].start - r.cues[k].end >= GAP, `gap after cue ${k}`);
    }
    if (cues[k].locked) {
      assert.equal(r.cues[k].start, cues[k].start);
      assert.equal(r.cues[k].end, cues[k].end);
    }
  }

  assert.ok(elapsedMs < 5000, `too slow: ${elapsedMs}ms`);
  assert.ok(memDeltaMiB < 256, `too much memory: ${memDeltaMiB} MiB`);
});
