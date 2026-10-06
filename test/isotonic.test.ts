import { test } from "node:test";
import assert from "node:assert/strict";
import { isotonicL1Min } from "../src/isotonic";

/**
 * Independent brute force: DP over candidate values (the targets themselves;
 * an L1 isotonic optimum always exists at data points), with lexicographically
 * smallest reconstruction.
 */
function bruteForce(target: number[], weight: number[]): { y: number[]; cost: number } {
  const m = target.length;
  const vals = [...new Set(target)].sort((a, b) => a - b);
  const V = vals.length;
  // g[j][vi] = min cost of suffix j..m-1 given y[j] = vals[vi]
  const g: number[][] = Array.from({ length: m }, () => new Array<number>(V).fill(0));
  for (let vi = 0; vi < V; vi++) {
    g[m - 1][vi] = weight[m - 1] * Math.abs(vals[vi] - target[m - 1]);
  }
  for (let j = m - 2; j >= 0; j--) {
    let best = Infinity;
    for (let vi = V - 1; vi >= 0; vi--) {
      best = Math.min(best, g[j + 1][vi]);
      g[j][vi] = weight[j] * Math.abs(vals[vi] - target[j]) + best;
    }
  }
  const total = Math.min(...g[0]);
  const y: number[] = [];
  let prev = -Infinity;
  let remaining = total;
  for (let j = 0; j < m; j++) {
    for (let vi = 0; vi < V; vi++) {
      if (vals[vi] < prev) continue;
      if (g[j][vi] === remaining) {
        y.push(vals[vi]);
        prev = vals[vi];
        remaining -= weight[j] * Math.abs(vals[vi] - target[j]);
        break;
      }
    }
  }
  return { y, cost: total };
}

function costOf(target: number[], weight: number[], y: number[]): number {
  let c = 0;
  for (let i = 0; i < target.length; i++) c += weight[i] * Math.abs(y[i] - target[i]);
  return c;
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test("isotonicL1Min matches brute force on random small chains", () => {
  const rnd = makeRng(20261006);
  const cases = 5000;
  for (let t = 0; t < cases; t++) {
    const m = 1 + Math.floor(rnd() * 8);
    const target: number[] = [];
    const weight: number[] = [];
    for (let i = 0; i < m; i++) {
      target.push(Math.floor(rnd() * 21) - 5);
      // occasionally a huge weight, simulating locked elements
      weight.push(rnd() < 0.1 ? 1e12 : 1 + Math.floor(rnd() * 3));
    }
    const y = isotonicL1Min(target, weight);
    for (let i = 1; i < m; i++) {
      assert.ok(y[i] >= y[i - 1], `monotonicity violated at case ${t}`);
    }
    const brute = bruteForce(target, weight);
    assert.equal(costOf(target, weight, y), brute.cost, `cost mismatch at case ${t}`);
    assert.deepEqual(y, brute.y, `lex-min mismatch at case ${t}`);
  }
});

test("isotonicL1Min handles empty and singleton inputs", () => {
  assert.deepEqual(isotonicL1Min([], []), []);
  assert.deepEqual(isotonicL1Min([42], [7]), [42]);
});

test("isotonicL1Min picks the lexicographically smallest optimum", () => {
  // Any constant value in [0, 10] is optimal; the smallest one wins.
  assert.deepEqual(isotonicL1Min([10, 0], [1, 1]), [0, 0]);
  // Already monotone: nothing moves.
  assert.deepEqual(isotonicL1Min([0, 5, 10], [1, 1, 1]), [0, 5, 10]);
});
