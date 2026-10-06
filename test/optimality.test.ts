import test from "node:test";
import assert from "node:assert/strict";
import { allocateCosts, type AllocationBatch } from "../src/index.js";

/** Deterministic PRNG so failures are reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SmallCase {
  amounts4: number[]; // document amounts in 1e-4 units
  weights: number[][]; // weights[i][j], each row sums to 10000
}

/**
 * Exhaustive optimum: enumerate every per-document choice of round-up
 * cells, keep assignments whose column sums are floor/ceil of the ideal
 * column sums, and find the lexicographic optimum of
 * (max department deviation, total cell deviation) in 1e-8 units.
 */
function bruteForceOptimum(input: SmallCase): [bigint, bigint] {
  const docCount = input.amounts4.length;
  const deptCount = input.weights[0].length;

  // ideals in 1e-8 units
  const ideal: number[][] = input.amounts4.map((amount, i) =>
    input.weights[i].map((w) => amount * w),
  );
  const floorRow: number[][] = ideal.map((row) => row.map((v) => Math.floor(v / 10_000)));
  const fracCells: number[][] = ideal.map((row, i) =>
    row.flatMap((v, j) => (v % 10_000 > 0 ? [j] : [])),
  );
  const need: number[] = input.amounts4.map(
    (amount, i) => amount - floorRow[i].reduce((a, b) => a + b, 0),
  );
  const colIdeal: number[] = new Array<number>(deptCount).fill(0);
  const colBase: number[] = new Array<number>(deptCount).fill(0);
  for (let j = 0; j < deptCount; j++) {
    for (let i = 0; i < docCount; i++) {
      colIdeal[j] += ideal[i][j];
      colBase[j] += floorRow[i][j];
    }
  }

  // Per document: all combinations of round-up cells of size need[i].
  const combosPerDoc: number[][][] = fracCells.map((cells, i) => {
    const combos: number[][] = [];
    const pick: number[] = [];
    const walk = (start: number) => {
      if (pick.length === need[i]) {
        combos.push([...pick]);
        return;
      }
      for (let c = start; c < cells.length; c++) {
        pick.push(cells[c]);
        walk(c + 1);
        pick.pop();
      }
    };
    walk(0);
    return combos;
  });

  let best: [bigint, bigint] | null = null;
  const chosen: number[][] = [];
  const consider = (): void => {
    // Column sums must be floor/ceil of the ideal column sums.
    const colUp = new Array<number>(deptCount).fill(0);
    for (const combo of chosen) {
      for (const j of combo) colUp[j]++;
    }
    let maxDev = 0n;
    for (let j = 0; j < deptCount; j++) {
      const actual8 = BigInt(colBase[j] + colUp[j]) * 10_000n;
      const dev =
        actual8 > BigInt(colIdeal[j])
          ? actual8 - BigInt(colIdeal[j])
          : BigInt(colIdeal[j]) - actual8;
      if (dev > 10_000n) return; // not a floor/ceil rounding of the column
      if (dev > maxDev) maxDev = dev;
    }
    let totalDev = 0n;
    for (let i = 0; i < docCount; i++) {
      const up = new Set(chosen[i]);
      for (let j = 0; j < deptCount; j++) {
        const actual8 = BigInt(floorRow[i][j] + (up.has(j) ? 1 : 0)) * 10_000n;
        const dev =
          actual8 > BigInt(ideal[i][j])
            ? actual8 - BigInt(ideal[i][j])
            : BigInt(ideal[i][j]) - actual8;
        totalDev += dev;
      }
    }
    if (best === null || maxDev < best[0] || (maxDev === best[0] && totalDev < best[1])) {
      best = [maxDev, totalDev];
    }
  };
  const walk = (i: number): void => {
    if (i === docCount) {
      consider();
      return;
    }
    for (const combo of combosPerDoc[i]) {
      chosen.push(combo);
      walk(i + 1);
      chosen.pop();
    }
  };
  walk(0);
  assert.ok(best !== null, "brute force found no valid assignment");
  return best;
}

function randomCase(rand: () => number): AllocationBatch {
  const deptCount = 2 + Math.floor(rand() * 3); // 2..4 departments
  const docCount = 2 + Math.floor(rand() * 2); // 2..3 documents
  const departments = Array.from({ length: deptCount }, (_, j) => `D${j}`);
  const documents = Array.from({ length: docCount }, (_, i) => {
    // Random integer weights summing to 10000.
    const cuts = [0, 10_000];
    for (let j = 1; j < deptCount; j++) cuts.push(Math.floor(rand() * 10_001));
    cuts.sort((a, b) => a - b);
    const weights = departments.map((departmentId, j) => ({
      departmentId,
      weight: cuts[j + 1] - cuts[j],
    }));
    const amountUnits = 1 + Math.floor(rand() * 20); // 0.0001 .. 0.0020
    return { documentId: `doc${i}`, amount: `0.${String(amountUnits).padStart(4, "0")}`, weights };
  });
  return { departments, documents };
}

test("matches exhaustive-search optimum on 300 random small batches", () => {
  const rand = mulberry32(20261006);
  for (let trial = 0; trial < 300; trial++) {
    const batch = randomCase(rand);
    const result = allocateCosts(batch);
    const [optMax, optTotal] = bruteForceOptimum({
      amounts4: batch.documents.map((d) => Number(d.amount.split(".")[1])),
      weights: batch.documents.map((d) =>
        batch.departments.map(
          (dept) => d.weights.find((w) => w.departmentId === dept)?.weight ?? 0,
        ),
      ),
    });
    const parse8 = (text: string): bigint => {
      const [intPart, fracPart = ""] = text.split(".");
      return BigInt(intPart) * 100_000_000n + BigInt((fracPart + "00000000").slice(0, 8));
    };
    assert.equal(
      parse8(result.totals.maxDepartmentDeviation),
      optMax,
      `trial ${trial}: max department deviation not optimal`,
    );
    assert.equal(
      parse8(result.totals.totalDetailDeviation),
      optTotal,
      `trial ${trial}: total detail deviation not optimal`,
    );
  }
});
