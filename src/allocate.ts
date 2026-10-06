import { MinCostFlow } from "./minCostFlow.js";
import { formatAmount4, formatAmount8, parseAmount4 } from "./decimal.js";
import type {
  AllocationBatch,
  AllocationDetail,
  AllocationResult,
  DepartmentSummary,
} from "./types.js";

/**
 * Allocate one batch of cost documents to departments.
 *
 * Model (all integer arithmetic; ideals kept at 1e-8 precision, actual
 * amounts at 1e-4 precision):
 *  - Each cell (document i, department j) has ideal share
 *    ideal = amount_i * weight_ij / 10000. Its actual value must be
 *    floor or ceil of the ideal at 1e-4 precision, i.e. floor plus an
 *    optional +1 "round-up" unit (only for cells with a fractional ideal).
 *  - Each document must receive exactly ceilCount_i round-up units so its
 *    actual total equals the original amount.
 *  - Each department column must receive between low_j and high_j round-up
 *    units so its actual total stays within floor/ceil of the ideal
 *    department total and the total deviation stays <= D.
 *  - The smallest feasible D is found by binary search (first objective),
 *    then a min-cost flow minimizes the sum of cell deviations (second
 *    objective). Cost of rounding a cell up is (1 - 2 * frac) at 1e-4
 *    scale; rounding down contributes a constant, so the flow optimum is
 *    exactly the second objective.
 */
export function allocateCosts(batch: AllocationBatch): AllocationResult {
  const departments = validateBatch(batch);
  const docCount = batch.documents.length;
  const deptCount = departments.length;
  const deptIndex = new Map(departments.map((id, index) => [id, index]));

  // Ideals at 1e-8 precision: amount4 * weight.
  const amount4 = batch.documents.map((doc) => parseAmount4(doc.amount));
  const ideal8: bigint[][] = batch.documents.map((doc, i) => {
    const row = new Array<bigint>(deptCount).fill(0n);
    for (const { departmentId, weight } of doc.weights) {
      row[deptIndex.get(departmentId) as number] = amount4[i] * BigInt(weight);
    }
    return row;
  });

  // Per cell: floor at 1e-4 and remainder rem in [0, 9999] (1e-8 units).
  const floor4: bigint[][] = ideal8.map((row) => row.map((v) => v / 10_000n));
  const rem: number[][] = ideal8.map((row) => row.map((v) => Number(v % 10_000n)));

  // Round-up units each document row must place.
  const rowNeed: number[] = amount4.map((amount, i) =>
    Number(amount - floor4[i].reduce((sum, v) => sum + v, 0n)),
  );

  // Column ideal sums and their floor/ceil round-up targets.
  const colIdeal8: bigint[] = new Array<bigint>(deptCount).fill(0n);
  const colBase: bigint[] = new Array<bigint>(deptCount).fill(0n);
  for (let j = 0; j < deptCount; j++) {
    for (let i = 0; i < docCount; i++) {
      colIdeal8[j] += ideal8[i][j];
      colBase[j] += floor4[i][j];
    }
  }
  const colRem: number[] = colIdeal8.map((sum) => Number(sum % 10_000n));
  const colDown: number[] = colIdeal8.map((sum, j) =>
    Number(sum / 10_000n - colBase[j]),
  );

  // Candidate deviation bounds (1e-8 units) for the first objective.
  const candidates = new Set<number>();
  for (let j = 0; j < deptCount; j++) {
    if (colRem[j] > 0) {
      candidates.add(colRem[j]);
      candidates.add(10_000 - colRem[j]);
    }
  }
  const sorted = [...candidates].sort((a, b) => a - b);

  // Column round-up bounds [low, high] feasible at deviation limit d.
  const columnBounds = (d: number): Array<[number, number]> =>
    colDown.map((down, j) => {
      if (colRem[j] === 0) return [down, down];
      const low = colRem[j] <= d ? down : down + 1;
      const high = 10_000 - colRem[j] <= d ? down + 1 : down;
      return [low, high];
    });

  // Returns null when the deviation limit d rules out both rounding
  // directions of some department (column bounds become empty).
  const buildFlow = (d: number, withCosts: boolean): MinCostFlow | null => {
    const flow = new MinCostFlow();
    const sink = docCount + deptCount;
    const bounds = columnBounds(d);
    let totalLow = 0;
    for (let i = 0; i < docCount; i++) {
      flow.setBalance(i, rowNeed[i]);
      for (let j = 0; j < deptCount; j++) {
        if (rem[i][j] > 0) {
          flow.addEdge(i, docCount + j, 1, withCosts ? 10_000 - 2 * rem[i][j] : 0);
        }
      }
    }
    for (let j = 0; j < deptCount; j++) {
      const [low, high] = bounds[j];
      if (low > high) return null;
      flow.setBalance(docCount + j, -low);
      flow.addEdge(docCount + j, sink, high - low, 0);
      totalLow += low;
    }
    const totalNeed = rowNeed.reduce((sum, v) => sum + v, 0);
    if (totalNeed < totalLow) return null;
    flow.setBalance(sink, -(totalNeed - totalLow));
    return flow;
  };

  // First objective: smallest feasible max department deviation.
  let best = -1;
  if (sorted.length > 0) {
    let lo = 0;
    let hi = sorted.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const probe = buildFlow(sorted[mid], false);
      if (probe !== null && probe.solve() !== null) {
        best = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    if (best < 0) {
      // Unreachable: at the largest candidate every column may round both
      // ways, and a controlled rounding always exists.
      throw new Error("no feasible allocation found");
    }
  }
  const maxDeviation = best >= 0 ? sorted[best] : 0;

  // Second objective: minimize total cell deviation at that bound.
  const finalFlow = buildFlow(maxDeviation, true);
  const flows = finalFlow === null ? null : finalFlow.solve();
  if (flows === null) {
    throw new Error("no feasible allocation found");
  }

  // Read round-up decisions back from the fractional-cell edges.
  const roundUp: boolean[][] = ideal8.map((row) => row.map(() => false));
  let edgeIndex = 0;
  for (let i = 0; i < docCount; i++) {
    for (let j = 0; j < deptCount; j++) {
      if (rem[i][j] > 0) {
        roundUp[i][j] = flows[edgeIndex] === 1;
        edgeIndex++;
      }
    }
  }

  const details: AllocationDetail[] = [];
  let totalDetailDeviation = 0n;
  for (let i = 0; i < docCount; i++) {
    for (let j = 0; j < deptCount; j++) {
      const actual4 = floor4[i][j] + (roundUp[i][j] ? 1n : 0n);
      const deviation8 =
        actual4 * 10_000n > ideal8[i][j]
          ? actual4 * 10_000n - ideal8[i][j]
          : ideal8[i][j] - actual4 * 10_000n;
      totalDetailDeviation += deviation8;
      details.push({
        documentId: batch.documents[i].documentId,
        departmentId: departments[j],
        idealAmount: formatAmount8(ideal8[i][j]),
        actualAmount: formatAmount4(actual4),
        deviation: formatAmount8(deviation8),
      });
    }
  }

  const summaries: DepartmentSummary[] = [];
  let totalActual4 = 0n;
  let totalIdeal8 = 0n;
  for (let j = 0; j < deptCount; j++) {
    let actual4 = colBase[j];
    for (let i = 0; i < docCount; i++) {
      if (roundUp[i][j]) actual4 += 1n;
    }
    const idealSum8 = colIdeal8[j];
    const deviation8 =
      actual4 * 10_000n > idealSum8
        ? actual4 * 10_000n - idealSum8
        : idealSum8 - actual4 * 10_000n;
    totalActual4 += actual4;
    totalIdeal8 += idealSum8;
    summaries.push({
      departmentId: departments[j],
      idealAmount: formatAmount8(idealSum8),
      actualAmount: formatAmount4(actual4),
      deviation: formatAmount8(deviation8),
    });
  }

  return {
    details,
    departments: summaries,
    totals: {
      idealAmount: formatAmount8(totalIdeal8),
      actualAmount: formatAmount4(totalActual4),
      maxDepartmentDeviation: formatAmount8(BigInt(maxDeviation)),
      totalDetailDeviation: formatAmount8(totalDetailDeviation),
    },
  };
}

function validateBatch(batch: AllocationBatch): string[] {
  if (!Array.isArray(batch.departments) || !Array.isArray(batch.documents)) {
    throw new Error("batch must contain departments and documents arrays");
  }
  const departments = batch.departments;
  const seenDepartments = new Set<string>();
  for (const id of departments) {
    if (typeof id !== "string" || id === "") {
      throw new Error("department ids must be non-empty strings");
    }
    if (seenDepartments.has(id)) {
      throw new Error(`duplicate department id "${id}"`);
    }
    seenDepartments.add(id);
  }
  const known = new Set(departments);
  const seenDocuments = new Set<string>();
  for (const doc of batch.documents) {
    if (typeof doc.documentId !== "string" || doc.documentId === "") {
      throw new Error("document ids must be non-empty strings");
    }
    if (seenDocuments.has(doc.documentId)) {
      throw new Error(`duplicate document id "${doc.documentId}"`);
    }
    seenDocuments.add(doc.documentId);
    parseAmount4(doc.amount); // validates format
    const seenWeights = new Set<string>();
    let weightSum = 0;
    for (const { departmentId, weight } of doc.weights) {
      if (!known.has(departmentId)) {
        throw new Error(
          `document "${doc.documentId}" references unknown department "${departmentId}"`,
        );
      }
      if (seenWeights.has(departmentId)) {
        throw new Error(
          `document "${doc.documentId}" lists department "${departmentId}" twice`,
        );
      }
      seenWeights.add(departmentId);
      if (!Number.isInteger(weight) || weight < 0 || weight > 10_000) {
        throw new Error(
          `document "${doc.documentId}" has invalid weight ${weight} for department "${departmentId}"`,
        );
      }
      weightSum += weight;
    }
    if (weightSum !== 10_000) {
      throw new Error(
        `document "${doc.documentId}" weights sum to ${weightSum}, expected 10000`,
      );
    }
  }
  return departments;
}
