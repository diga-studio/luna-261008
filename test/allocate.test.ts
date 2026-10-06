import { describe, expect, it } from "vitest";
import { allocateCosts } from "../src/index.js";
import type { AllocationInput, AllocationResult } from "../src/index.js";

const SUB = 100000000n;

function toSub(text: string): bigint {
  const negative = text.startsWith("-");
  const body = negative ? text.slice(1) : text;
  const dot = body.indexOf(".");
  const intPart = dot === -1 ? body : body.slice(0, dot);
  const fracPart = dot === -1 ? "" : body.slice(dot + 1);
  const value = BigInt(intPart) * SUB + BigInt((fracPart + "00000000").slice(0, 8));
  return negative ? -value : value;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function floor4(value: bigint): bigint {
  return (value / 10000n) * 10000n;
}

function ceil4(value: bigint): bigint {
  return value % 10000n === 0n ? value : floor4(value) + 10000n;
}

function sumDetailDeviations(result: AllocationResult): bigint {
  return result.details.reduce(
    (sum, detail) => sum + abs(toSub(detail.amount) - toSub(detail.idealAmount)),
    0n,
  );
}

function checkBusinessRules(input: AllocationInput, result: AllocationResult): void {
  // Every detail keeps its source document id and rounds the ideal amount
  // to the floor or ceil at 4 decimal places.
  const docIds = new Set(input.documents.map((doc) => doc.id));
  for (const detail of result.details) {
    expect(docIds.has(detail.documentId)).toBe(true);
    const ideal = toSub(detail.idealAmount);
    const actual = toSub(detail.amount);
    expect(actual === floor4(ideal) || actual === ceil4(ideal)).toBe(true);
    expect(detail.amount).toMatch(/^-?\d+\.\d{4}$/);
  }

  // Each document's actual amounts sum to its original amount.
  for (const doc of input.documents) {
    const total = result.details
      .filter((detail) => detail.documentId === doc.id)
      .reduce((sum, detail) => sum + toSub(detail.amount), 0n);
    expect(total).toBe(toSub(doc.amount));
  }

  // Department summaries match the details and stay within floor/ceil of
  // the ideal department totals.
  for (const summary of result.departmentSummaries) {
    const fromDetails = result.details
      .filter((detail) => detail.department === summary.department)
      .reduce((sum, detail) => sum + toSub(detail.amount), 0n);
    expect(fromDetails).toBe(toSub(summary.amount));
    const ideal = toSub(summary.idealAmount);
    const actual = toSub(summary.amount);
    expect(actual === floor4(ideal) || actual === ceil4(ideal)).toBe(true);
    expect(toSub(summary.deviation)).toBe(actual - ideal);
  }

  // The batch total is preserved.
  const docTotal = input.documents.reduce((sum, doc) => sum + toSub(doc.amount), 0n);
  const summaryTotal = result.departmentSummaries.reduce(
    (sum, summary) => sum + toSub(summary.amount),
    0n,
  );
  expect(toSub(result.totalAmount)).toBe(docTotal);
  expect(summaryTotal).toBe(docTotal);
}

describe("specified three-document batch", () => {
  const input: AllocationInput = {
    departments: ["A", "B", "C", "D", "E", "F"],
    documents: [
      {
        id: "doc-1",
        amount: "0.0001",
        weights: { A: 4000, B: 4000, C: 2000, D: 0, E: 0, F: 0 },
      },
      {
        id: "doc-2",
        amount: "0.0001",
        weights: { A: 0, B: 0, C: 0, D: 5000, E: 1000, F: 4000 },
      },
      {
        id: "doc-3",
        amount: "0.0001",
        weights: { A: 0, B: 0, C: 0, D: 1000, E: 5000, F: 4000 },
      },
    ],
  };

  it("achieves max department deviation of 0.00006", () => {
    const result = allocateCosts(input);
    expect(result.maxDepartmentDeviation).toBe("0.00006");
  });

  it("achieves total detail deviation of 0.00034", () => {
    const result = allocateCosts(input);
    expect(sumDetailDeviations(result)).toBe(34000n);
  });

  it("satisfies all business rules", () => {
    checkBusinessRules(input, allocateCosts(input));
  });
});

describe("batches with ideals exact at 4 decimal places", () => {
  it("keeps exact ideals untouched", () => {
    const input: AllocationInput = {
      departments: ["X", "Y"],
      documents: [
        { id: "d1", amount: "10.0000", weights: { X: 2500, Y: 7500 } },
        { id: "d2", amount: "0.0001", weights: { X: 10000, Y: 0 } },
        { id: "d3", amount: "3.1400", weights: { X: 5000, Y: 5000 } },
      ],
    };
    const result = allocateCosts(input);
    expect(result.maxDepartmentDeviation).toBe("0.0000");
    expect(sumDetailDeviations(result)).toBe(0n);
    for (const detail of result.details) {
      expect(detail.amount).toBe(detail.idealAmount);
    }
    checkBusinessRules(input, result);
  });

  it("handles zero amounts", () => {
    const input: AllocationInput = {
      departments: ["X", "Y"],
      documents: [{ id: "d1", amount: "0.0000", weights: { X: 3000, Y: 7000 } }],
    };
    const result = allocateCosts(input);
    expect(result.totalAmount).toBe("0.0000");
    expect(result.maxDepartmentDeviation).toBe("0.0000");
    checkBusinessRules(input, result);
  });
});

describe("input validation", () => {
  const base: AllocationInput = {
    departments: ["A", "B"],
    documents: [{ id: "d1", amount: "1.0000", weights: { A: 5000, B: 5000 } }],
  };

  it("rejects weights that do not sum to 10000", () => {
    expect(() =>
      allocateCosts({
        departments: ["A", "B"],
        documents: [{ id: "d1", amount: "1.0000", weights: { A: 5000, B: 5001 } }],
      }),
    ).toThrow(/10000/);
  });

  it("rejects malformed amounts", () => {
    for (const amount of ["-1.0000", "1.00001", "1e3", "abc", "1.", ".5"]) {
      expect(() =>
        allocateCosts({
          departments: ["A", "B"],
          documents: [{ id: "d1", amount, weights: { A: 5000, B: 5000 } }],
        }),
      ).toThrow(/amount/);
    }
  });

  it("rejects duplicate document ids", () => {
    expect(() =>
      allocateCosts({
        departments: ["A"],
        documents: [
          { id: "d1", amount: "1.0000", weights: { A: 10000 } },
          { id: "d1", amount: "2.0000", weights: { A: 10000 } },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  it("rejects unknown departments in weights", () => {
    expect(() =>
      allocateCosts({
        departments: ["A"],
        documents: [{ id: "d1", amount: "1.0000", weights: { A: 5000, B: 5000 } }],
      }),
    ).toThrow(/unknown department/);
  });

  it("accepts the base input", () => {
    checkBusinessRules(base, allocateCosts(base));
  });
});

describe("optimality against brute force", () => {
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

  function randomInput(
    rand: () => number,
    index: number,
    maxAmountUnits: number,
  ): AllocationInput {
    const deptCount = 2 + Math.floor(rand() * 3);
    const departments = Array.from({ length: deptCount }, (_, i) => `D${i}`);
    const docCount = 1 + Math.floor(rand() * 3);
    const documents = [];
    for (let i = 0; i < docCount; i++) {
      const amountUnits = 1 + Math.floor(rand() * maxAmountUnits);
      const cuts = new Set<number>([0, 10000]);
      while (cuts.size < deptCount + 1) {
        cuts.add(Math.floor(rand() * 10001));
      }
      const sorted = [...cuts].sort((a, b) => a - b);
      const weights: Record<string, number> = {};
      for (let j = 0; j < deptCount; j++) {
        weights[`D${j}`] = sorted[j + 1] - sorted[j];
      }
      documents.push({
        id: `doc-${index}-${i}`,
        amount: `${Math.floor(amountUnits / 10000)}.${String(amountUnits % 10000).padStart(4, "0")}`,
        weights,
      });
    }
    return { departments, documents };
  }

  interface Cell {
    doc: number;
    dept: number;
    frac: bigint;
  }

  function bruteForce(input: AllocationInput): { maxDev: bigint; sumDev: bigint } {
    const deptCount = input.departments.length;
    const amountUnits = input.documents.map((doc) => toSub(doc.amount) / 10000n);
    const cells: Cell[] = [];
    const rowRemainder: bigint[] = [];
    const deptIdeal = new Array<bigint>(deptCount).fill(0n);
    const deptFloorSum = new Array<bigint>(deptCount).fill(0n);
    for (let i = 0; i < input.documents.length; i++) {
      let floorSum = 0n;
      for (let j = 0; j < deptCount; j++) {
        const ideal = amountUnits[i] * BigInt(input.documents[i].weights[input.departments[j]]);
        deptIdeal[j] += ideal;
        const frac = ideal % 10000n;
        floorSum += (ideal - frac) / 10000n;
        deptFloorSum[j] += (ideal - frac) / 10000n;
        if (frac > 0n) {
          cells.push({ doc: i, dept: j, frac });
        }
      }
      rowRemainder.push(amountUnits[i] - floorSum);
    }
    const deptLow = deptIdeal.map((ideal, j) => ideal / 10000n - deptFloorSum[j]);
    const deptHigh = deptLow.map((low, j) => low + (deptIdeal[j] % 10000n > 0n ? 1n : 0n));

    let best: { maxDev: bigint; sumDev: bigint } | null = null;
    const y = new Array<bigint>(cells.length).fill(0n);
    const enumerate = (k: number): void => {
      if (k === cells.length) {
        const rowSum = new Array<bigint>(input.documents.length).fill(0n);
        const deptSum = new Array<bigint>(deptCount).fill(0n);
        let sumDev = 0n;
        for (let c = 0; c < cells.length; c++) {
          rowSum[cells[c].doc] += y[c];
          deptSum[cells[c].dept] += y[c];
          sumDev += y[c] === 1n ? 10000n - cells[c].frac : cells[c].frac;
        }
        for (let i = 0; i < rowSum.length; i++) {
          if (rowSum[i] !== rowRemainder[i]) {
            return;
          }
        }
        let maxDev = 0n;
        for (let j = 0; j < deptCount; j++) {
          if (deptSum[j] < deptLow[j] || deptSum[j] > deptHigh[j]) {
            return;
          }
          const dev = abs((deptFloorSum[j] + deptSum[j]) * 10000n - deptIdeal[j]);
          if (dev > maxDev) {
            maxDev = dev;
          }
        }
        if (
          best === null ||
          maxDev < best.maxDev ||
          (maxDev === best.maxDev && sumDev < best.sumDev)
        ) {
          best = { maxDev, sumDev };
        }
        return;
      }
      y[k] = 0n;
      enumerate(k + 1);
      y[k] = 1n;
      enumerate(k + 1);
    };
    enumerate(0);
    if (best === null) {
      throw new Error("brute force found no feasible solution");
    }
    return best;
  }

  function checkRandomBatches(seed: number, maxAmountUnits: number, cases: number): void {
    const rand = mulberry32(seed);
    let tested = 0;
    for (let index = 0; tested < cases && index < cases * 20; index++) {
      const input = randomInput(rand, index, maxAmountUnits);
      const fractionalCells = input.documents.reduce(
        (count, doc) =>
          count +
          input.departments.filter(
            (dept) =>
              ((toSub(doc.amount) / 10000n) * BigInt(doc.weights[dept])) % 10000n > 0n,
          ).length,
        0,
      );
      if (fractionalCells === 0 || fractionalCells > 18) {
        continue;
      }
      tested++;
      const result = allocateCosts(input);
      const expected = bruteForce(input);
      expect(toSub(result.maxDepartmentDeviation)).toBe(expected.maxDev);
      expect(sumDetailDeviations(result)).toBe(expected.sumDev);
      checkBusinessRules(input, result);
    }
    expect(tested).toBe(cases);
  }

  it("matches brute-force optima on random small batches", () => {
    checkRandomBatches(20261006, 50, 40);
  });

  it("matches brute-force optima on random larger batches", () => {
    checkRandomBatches(777, 500000, 30);
  });
});
