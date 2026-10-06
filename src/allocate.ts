import type { AllocationInput, AllocationResult } from "./types.js";
import {
  formatSignedSubUnits,
  formatSubUnits,
  formatUnits,
  parseAmountToUnits,
} from "./decimal.js";
import { MinCostCirculation } from "./flow.js";

const SUB_UNITS_PER_UNIT = 10000n;

/**
 * Allocate a batch of cost documents to departments.
 *
 * Every actual detail amount is the floor or ceil of its ideal amount to
 * 4 decimal places; each document still sums to its original amount; each
 * department total is the floor or ceil of its ideal total. Among all such
 * plans, the max absolute department deviation is minimized first, then the
 * sum of absolute detail deviations.
 */
export function allocateCosts(input: AllocationInput): AllocationResult {
  const departments = validateDepartments(input);
  const docCount = input.documents.length;
  const deptCount = departments.length;

  const amountUnits = input.documents.map((doc) => parseAmountToUnits(doc.amount));
  const weights = input.documents.map((doc, docIndex) =>
    validateWeights(doc.weights, departments, `documents[${docIndex}]`),
  );

  // Ideal allocations in exact 1e-8 sub-units: amountUnits * weight.
  const idealSub: bigint[][] = [];
  const floorUnits: number[][] = [];
  const fracSub: number[][] = [];
  const rowRemainder: number[] = [];
  for (let i = 0; i < docCount; i++) {
    idealSub.push([]);
    floorUnits.push([]);
    fracSub.push([]);
    let floorSum = 0;
    for (let j = 0; j < deptCount; j++) {
      const ideal = BigInt(amountUnits[i]) * BigInt(weights[i][j]);
      idealSub[i].push(ideal);
      const floor = Number(ideal / SUB_UNITS_PER_UNIT);
      floorUnits[i].push(floor);
      fracSub[i].push(Number(ideal % SUB_UNITS_PER_UNIT));
      floorSum += floor;
    }
    rowRemainder.push(amountUnits[i] - floorSum);
  }

  // Department ideal totals and their allowed rounding targets (in 1e-4 units).
  const deptIdealSub: bigint[] = new Array<bigint>(deptCount).fill(0n);
  const deptFracSub: number[] = new Array<number>(deptCount).fill(0);
  const deptLow: number[] = new Array<number>(deptCount).fill(0);
  const deptHigh: number[] = new Array<number>(deptCount).fill(0);
  for (let j = 0; j < deptCount; j++) {
    let total = 0n;
    let floorSum = 0;
    for (let i = 0; i < docCount; i++) {
      total += idealSub[i][j];
      floorSum += floorUnits[i][j];
    }
    deptIdealSub[j] = total;
    deptFracSub[j] = Number(total % SUB_UNITS_PER_UNIT);
    const low = Number(total / SUB_UNITS_PER_UNIT) - floorSum;
    deptLow[j] = low;
    deptHigh[j] = low + (deptFracSub[j] > 0 ? 1 : 0);
  }

  // Node layout: 0 = source, 1 = sink, then documents, then departments.
  const docNode = (i: number): number => 2 + i;
  const deptNode = (j: number): number => 2 + docCount + j;
  const nodeCount = 2 + docCount + deptCount;
  const totalRemainder = rowRemainder.reduce((sum, value) => sum + value, 0);

  const buildFlow = (maxDeviation: number, withCosts: boolean): {
    flow: MinCostCirculation;
    cellEdgeIndex: number[][];
  } | null => {
    const flow = new MinCostCirculation(nodeCount);
    for (let i = 0; i < docCount; i++) {
      flow.addEdge(0, docNode(i), rowRemainder[i], rowRemainder[i], 0);
    }
    const cellEdgeIndex: number[][] = [];
    for (let i = 0; i < docCount; i++) {
      cellEdgeIndex.push([]);
      for (let j = 0; j < deptCount; j++) {
        if (fracSub[i][j] === 0) {
          cellEdgeIndex[i].push(-1);
          continue;
        }
        // Cost of rounding this cell up: (1e4 - g) - g in sub-units.
        const edgeIndex = flow.addEdge(
          docNode(i),
          deptNode(j),
          0,
          1,
          withCosts ? 10000 - 2 * fracSub[i][j] : 0,
        );
        cellEdgeIndex[i].push(edgeIndex);
      }
    }
    for (let j = 0; j < deptCount; j++) {
      const canRoundDown = deptFracSub[j] <= maxDeviation;
      const canRoundUp =
        deptFracSub[j] > 0 && 10000 - deptFracSub[j] <= maxDeviation;
      if (!canRoundDown && !canRoundUp) {
        return null;
      }
      const low = canRoundDown ? deptLow[j] : deptHigh[j];
      const high = canRoundUp ? deptHigh[j] : deptLow[j];
      flow.addEdge(deptNode(j), 1, low, high, 0);
    }
    flow.addEdge(1, 0, 0, totalRemainder, 0);
    return { flow, cellEdgeIndex };
  };

  // Smallest feasible max department deviation, in 1e-8 sub-units.
  const candidates = new Set<number>();
  for (let j = 0; j < deptCount; j++) {
    if (deptFracSub[j] > 0) {
      candidates.add(deptFracSub[j]);
      candidates.add(10000 - deptFracSub[j]);
    }
  }
  const sortedCandidates = [...candidates].sort((a, b) => a - b);
  let bestDeviation = 0;
  if (sortedCandidates.length > 0) {
    let lo = 0;
    let hi = sortedCandidates.length - 1;
    bestDeviation = sortedCandidates[hi];
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const built = buildFlow(sortedCandidates[mid], false);
      if (built !== null && built.flow.solve() !== null) {
        bestDeviation = sortedCandidates[mid];
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
  }

  const built = buildFlow(bestDeviation, true);
  const solution = built === null ? null : built.flow.solve();
  if (solution === null) {
    throw new Error("no feasible allocation exists for this batch");
  }
  const { cellEdgeIndex } = built!;

  const actualUnits: number[][] = [];
  for (let i = 0; i < docCount; i++) {
    actualUnits.push([]);
    for (let j = 0; j < deptCount; j++) {
      const edgeIndex = cellEdgeIndex[i][j];
      const roundedUp = edgeIndex === -1 ? 0 : solution.flows[edgeIndex];
      actualUnits[i].push(floorUnits[i][j] + roundedUp);
    }
  }

  return buildResult(input, departments, idealSub, deptIdealSub, actualUnits, amountUnits);
}

function validateDepartments(input: AllocationInput): string[] {
  if (!Array.isArray(input.departments) || input.departments.length === 0) {
    throw new Error("departments must be a non-empty array");
  }
  if (!Array.isArray(input.documents) || input.documents.length === 0) {
    throw new Error("documents must be a non-empty array");
  }
  const seen = new Set<string>();
  for (const dept of input.departments) {
    if (typeof dept !== "string" || dept.length === 0) {
      throw new Error("department names must be non-empty strings");
    }
    if (seen.has(dept)) {
      throw new Error(`duplicate department "${dept}"`);
    }
    seen.add(dept);
  }
  const docIds = new Set<string>();
  for (const doc of input.documents) {
    if (typeof doc.id !== "string" || doc.id.length === 0) {
      throw new Error("document ids must be non-empty strings");
    }
    if (docIds.has(doc.id)) {
      throw new Error(`duplicate document id "${doc.id}"`);
    }
    docIds.add(doc.id);
  }
  return [...input.departments];
}

function validateWeights(
  weights: Record<string, number>,
  departments: string[],
  label: string,
): number[] {
  const result: number[] = [];
  let sum = 0;
  for (const dept of departments) {
    const weight = weights[dept];
    if (typeof weight !== "number" || !Number.isInteger(weight) || weight < 0) {
      throw new Error(`${label}: weight for department "${dept}" must be a non-negative integer`);
    }
    result.push(weight);
    sum += weight;
  }
  for (const key of Object.keys(weights)) {
    if (!departments.includes(key)) {
      throw new Error(`${label}: unknown department "${key}" in weights`);
    }
  }
  if (sum !== 10000) {
    throw new Error(`${label}: weights must sum to 10000, got ${sum}`);
  }
  return result;
}

function buildResult(
  input: AllocationInput,
  departments: string[],
  idealSub: bigint[][],
  deptIdealSub: bigint[],
  actualUnits: number[][],
  amountUnits: number[],
): AllocationResult {
  const details = [];
  for (let i = 0; i < input.documents.length; i++) {
    let rowSum = 0;
    for (let j = 0; j < departments.length; j++) {
      rowSum += actualUnits[i][j];
      details.push({
        documentId: input.documents[i].id,
        department: departments[j],
        idealAmount: formatSubUnits(idealSub[i][j]),
        amount: formatUnits(actualUnits[i][j]),
      });
    }
    if (rowSum !== amountUnits[i]) {
      throw new Error("internal error: document total changed during allocation");
    }
  }

  const departmentSummaries = [];
  let maxDeviation = 0n;
  for (let j = 0; j < departments.length; j++) {
    let actual = 0;
    for (let i = 0; i < input.documents.length; i++) {
      actual += actualUnits[i][j];
    }
    const deviationSub = BigInt(actual) * SUB_UNITS_PER_UNIT - deptIdealSub[j];
    const absDeviation = deviationSub < 0n ? -deviationSub : deviationSub;
    if (absDeviation > maxDeviation) {
      maxDeviation = absDeviation;
    }
    departmentSummaries.push({
      department: departments[j],
      idealAmount: formatSubUnits(deptIdealSub[j]),
      amount: formatUnits(actual),
      deviation: formatSignedSubUnits(deviationSub),
    });
  }

  return {
    details,
    departmentSummaries,
    totalAmount: formatUnits(amountUnits.reduce((sum, value) => sum + value, 0)),
    maxDepartmentDeviation: formatSubUnits(maxDeviation),
  };
}
