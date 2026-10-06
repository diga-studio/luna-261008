import { test } from "node:test";
import assert from "node:assert/strict";
import { adjustTrack } from "../src/adjust";
import { CueInput } from "../src/types";

/**
 * Independent brute-force solver: dynamic programming over the chain of
 * 2n boundary variables in the offset (y) space, enumerating all candidate
 * values (original targets plus the two video bounds). Finds the exact
 * minimum cost and the lexicographically smallest optimal timeline.
 */
function bruteForceAdjust(
  cues: CueInput[],
  videoDuration: number,
  gapMs: number,
): { cues: { start: number; end: number }[]; cost: number } | null {
  const n = cues.length;
  if (n === 0) return { cues: [], cost: 0 };
  const m = 2 * n;
  const P = new Array<number>(m);
  P[0] = 0;
  for (let k = 0; k < n; k++) {
    P[2 * k + 1] = P[2 * k] + cues[k].minDuration;
    if (k + 1 < n) P[2 * k + 2] = P[2 * k + 1] + gapMs;
  }
  const target = new Array<number>(m);
  const weight = new Array<number>(m);
  const lockedEl = new Array<boolean>(m).fill(false);
  for (let k = 0; k < n; k++) {
    target[2 * k] = cues[k].start - P[2 * k];
    target[2 * k + 1] = cues[k].end - P[2 * k + 1];
    weight[2 * k] = cues[k].weight;
    weight[2 * k + 1] = cues[k].weight;
    if (cues[k].locked) {
      lockedEl[2 * k] = true;
      lockedEl[2 * k + 1] = true;
    }
  }
  const rightBound = videoDuration - P[m - 1];
  const candSet = new Set<number>(target);
  candSet.add(0);
  candSet.add(rightBound);
  const cand = [...candSet].sort((a, b) => a - b);

  const allowed: number[][] = [];
  for (let j = 0; j < m; j++) {
    let vals = lockedEl[j] ? [target[j]] : cand;
    if (j === 0) vals = vals.filter((v) => v >= 0);
    if (j === m - 1) vals = vals.filter((v) => v <= rightBound);
    allowed.push(vals);
  }

  // g[j][i] = min cost of positions j..m-1 with y[j] = allowed[j][i]
  const g: number[][] = allowed.map((vals) => new Array<number>(vals.length).fill(Infinity));
  for (let i = 0; i < allowed[m - 1].length; i++) {
    g[m - 1][i] = weight[m - 1] * Math.abs(allowed[m - 1][i] - target[m - 1]);
  }
  for (let j = m - 2; j >= 0; j--) {
    const next = allowed[j + 1];
    const suffMin = new Array<number>(next.length).fill(Infinity);
    let best = Infinity;
    for (let i = next.length - 1; i >= 0; i--) {
      best = Math.min(best, g[j + 1][i]);
      suffMin[i] = best;
    }
    for (let i = 0; i < allowed[j].length; i++) {
      const v = allowed[j][i];
      let lo = 0;
      let hi = next.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (next[mid] < v) lo = mid + 1;
        else hi = mid;
      }
      if (lo < next.length) {
        g[j][i] = weight[j] * Math.abs(v - target[j]) + suffMin[lo];
      }
    }
  }
  const total = Math.min(...g[0]);
  if (!isFinite(total)) return null;

  // Lexicographically smallest reconstruction.
  const y: number[] = [];
  let prev = -Infinity;
  let remaining = total;
  for (let j = 0; j < m; j++) {
    let chosen = NaN;
    for (let i = 0; i < allowed[j].length; i++) {
      const v = allowed[j][i];
      if (v < prev) continue;
      if (g[j][i] === remaining) {
        chosen = v;
        break;
      }
    }
    y.push(chosen);
    prev = chosen;
    remaining -= weight[j] * Math.abs(chosen - target[j]);
  }
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push({ start: y[2 * k] + P[2 * k], end: y[2 * k + 1] + P[2 * k + 1] });
  }
  return { cues: out, cost: total };
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test("adjustTrack matches brute force on random small tracks", () => {
  const rnd = makeRng(20261006);
  const cases = 3000;
  for (let t = 0; t < cases; t++) {
    const gapMs = 80;
    const n = 1 + Math.floor(rnd() * 6);
    const videoDuration = 200 + Math.floor(rnd() * 5800);
    const cues: CueInput[] = [];
    for (let k = 0; k < n; k++) {
      const start = Math.floor(rnd() * (videoDuration - 1));
      const end = start + 1 + Math.floor(rnd() * (videoDuration - start - 1));
      cues.push({
        start,
        end,
        minDuration: Math.floor(rnd() * 1200),
        weight: 1 + Math.floor(rnd() * 9),
        locked: rnd() < 0.25,
      });
    }
    const expected = bruteForceAdjust(cues, videoDuration, gapMs);
    const actual = adjustTrack(cues, videoDuration, gapMs);
    assert.equal(actual.ok, expected !== null, `feasibility mismatch at case ${t}`);
    if (expected !== null && actual.ok) {
      assert.equal(actual.totalCost, expected.cost, `cost mismatch at case ${t}`);
      assert.deepEqual(actual.cues, expected.cues, `timeline mismatch at case ${t}`);
    }
  }
});
