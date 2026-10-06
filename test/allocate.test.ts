import test from "node:test";
import assert from "node:assert/strict";
import {
  allocateCosts,
  type AllocationBatch,
  type AllocationResult,
} from "../src/index.js";

/** Parse decimal text to 1e-8 units for exact comparisons. */
function units8(text: string): bigint {
  const [intPart, fracPart = ""] = text.split(".");
  return BigInt(intPart) * 100_000_000n + BigInt((fracPart + "00000000").slice(0, 8));
}

/** Parse decimal text to 1e-4 units (text must have <= 4 fraction digits). */
function units4(text: string): bigint {
  const [intPart, fracPart = ""] = text.split(".");
  return BigInt(intPart) * 10_000n + BigInt((fracPart + "0000").slice(0, 4));
}

/** Check every business rule that any valid allocation must satisfy. */
function assertBusinessRules(batch: AllocationBatch, result: AllocationResult): void {
  const deptCount = batch.departments.length;
  assert.equal(result.details.length, batch.documents.length * deptCount);
  assert.equal(result.departments.length, deptCount);

  const detailByKey = new Map<string, (typeof result.details)[number]>();
  for (const detail of result.details) {
    detailByKey.set(`${detail.documentId}${detail.departmentId}`, detail);
  }

  // Per-cell rules: actual is floor or ceil of ideal at 1e-4; 4-decimal text.
  for (const detail of result.details) {
    assert.match(detail.actualAmount, /^\d+\.\d{4}$/);
    const ideal8 = units8(detail.idealAmount);
    const actual8 = units4(detail.actualAmount) * 10_000n;
    const floor = (ideal8 / 10_000n) * 10_000n;
    assert.ok(
      actual8 === floor || actual8 === floor + (ideal8 % 10_000n === 0n ? 0n : 10_000n),
      `actual ${detail.actualAmount} is not floor/ceil of ideal ${detail.idealAmount}`,
    );
    assert.equal(units8(detail.deviation), actual8 > ideal8 ? actual8 - ideal8 : ideal8 - actual8);
  }

  // Per-document rule: actual amounts sum exactly to the document amount.
  for (const doc of batch.documents) {
    let sum = 0n;
    for (const dept of batch.departments) {
      sum += units4(detailByKey.get(`${doc.documentId}${dept}`)!.actualAmount);
    }
    assert.equal(sum, units4(doc.amount), `document ${doc.documentId} total changed`);
  }

  // Per-department rules: summary matches details; sum is floor/ceil of ideal.
  for (const summary of result.departments) {
    let detailSum = 0n;
    for (const doc of batch.documents) {
      detailSum += units4(detailByKey.get(`${doc.documentId}${summary.departmentId}`)!.actualAmount);
    }
    assert.equal(units4(summary.actualAmount), detailSum, `summary inconsistent for ${summary.departmentId}`);
    const ideal8 = units8(summary.idealAmount);
    const actual8 = detailSum * 10_000n;
    const floor = (ideal8 / 10_000n) * 10_000n;
    assert.ok(
      actual8 === floor || actual8 === floor + (ideal8 % 10_000n === 0n ? 0n : 10_000n),
      `department ${summary.departmentId} sum is not floor/ceil of its ideal`,
    );
    assert.equal(
      units8(summary.deviation),
      actual8 > ideal8 ? actual8 - ideal8 : ideal8 - actual8,
    );
  }

  // Batch rule: total amount is neither created nor destroyed.
  const docTotal = batch.documents.reduce((sum, doc) => sum + units4(doc.amount), 0n);
  assert.equal(units4(result.totals.actualAmount), docTotal);
  assert.equal(units8(result.totals.idealAmount), docTotal * 10_000n);

  // Reported metrics match the details/summaries.
  const maxDept = result.departments.reduce((max, s) => {
    const d = units8(s.deviation);
    return d > max ? d : max;
  }, 0n);
  assert.equal(units8(result.totals.maxDepartmentDeviation), maxDept);
  const detailDeviation = result.details.reduce((sum, d) => sum + units8(d.deviation), 0n);
  assert.equal(units8(result.totals.totalDetailDeviation), detailDeviation);
}

test("three 0.0001 documents: optimal max department deviation is 0.00006, total detail deviation 0.00034", () => {
  const batch: AllocationBatch = {
    departments: ["A", "B", "C", "D", "E", "F"],
    documents: [
      {
        documentId: "doc-1",
        amount: "0.0001",
        weights: [
          { departmentId: "A", weight: 4000 },
          { departmentId: "B", weight: 4000 },
          { departmentId: "C", weight: 2000 },
        ],
      },
      {
        documentId: "doc-2",
        amount: "0.0001",
        weights: [
          { departmentId: "D", weight: 5000 },
          { departmentId: "E", weight: 1000 },
          { departmentId: "F", weight: 4000 },
        ],
      },
      {
        documentId: "doc-3",
        amount: "0.0001",
        weights: [
          { departmentId: "D", weight: 1000 },
          { departmentId: "E", weight: 5000 },
          { departmentId: "F", weight: 4000 },
        ],
      },
    ],
  };

  const result = allocateCosts(batch);

  assert.equal(result.totals.maxDepartmentDeviation, "0.00006");
  assert.equal(result.totals.totalDetailDeviation, "0.00034");
  assertBusinessRules(batch, result);

  // Spot-check the ideal shares of the first document.
  const ideal = (doc: string, dept: string) =>
    result.details.find((d) => d.documentId === doc && d.departmentId === dept)!.idealAmount;
  assert.equal(ideal("doc-1", "A"), "0.00004");
  assert.equal(ideal("doc-1", "C"), "0.00002");
  assert.equal(ideal("doc-2", "D"), "0.00005");
  assert.equal(ideal("doc-3", "E"), "0.00005");
});

test("batch whose ideals are exactly 4-decimal allocates with zero deviation", () => {
  const batch: AllocationBatch = {
    departments: ["PHARM", "LAB", "NURSE"],
    documents: [
      {
        documentId: "inv-1",
        amount: "12.3400",
        weights: [
          { departmentId: "PHARM", weight: 5000 },
          { departmentId: "LAB", weight: 2500 },
          { departmentId: "NURSE", weight: 2500 },
        ],
      },
      {
        documentId: "inv-2",
        amount: "0.0001",
        weights: [{ departmentId: "LAB", weight: 10000 }],
      },
      {
        documentId: "inv-3",
        amount: "100",
        weights: [
          { departmentId: "PHARM", weight: 10000 },
          { departmentId: "LAB", weight: 0 },
          { departmentId: "NURSE", weight: 0 },
        ],
      },
    ],
  };

  const result = allocateCosts(batch);

  assert.equal(result.totals.maxDepartmentDeviation, "0");
  assert.equal(result.totals.totalDetailDeviation, "0");
  for (const detail of result.details) {
    assert.equal(detail.deviation, "0");
    assert.equal(units4(detail.actualAmount) * 10_000n, units8(detail.idealAmount));
  }
  assertBusinessRules(batch, result);

  const summary = (dept: string) => result.departments.find((s) => s.departmentId === dept)!;
  assert.equal(summary("PHARM").actualAmount, "106.1700");
  assert.equal(summary("LAB").actualAmount, "3.0851");
  assert.equal(summary("NURSE").actualAmount, "3.0850");
  assert.equal(result.totals.actualAmount, "112.3401");
});

test("empty batch allocates nothing and keeps every department at zero", () => {
  const batch: AllocationBatch = { departments: ["A", "B"], documents: [] };
  const result = allocateCosts(batch);
  assert.equal(result.details.length, 0);
  assert.deepEqual(
    result.departments.map((s) => s.actualAmount),
    ["0.0000", "0.0000"],
  );
  assert.equal(result.totals.actualAmount, "0.0000");
  assert.equal(result.totals.maxDepartmentDeviation, "0");
});

test("larger mixed batch satisfies all business rules", () => {
  const departments = ["D1", "D2", "D3", "D4"];
  const documents = [
    { documentId: "a", amount: "7.5319", weights: [1234, 3456, 3210, 2100] },
    { documentId: "b", amount: "0.0003", weights: [3333, 3333, 3334, 0] },
    { documentId: "c", amount: "42", weights: [0, 0, 5000, 5000] },
    { documentId: "d", amount: "1.0007", weights: [2500, 2500, 2500, 2500] },
    { documentId: "e", amount: "0", weights: [10000, 0, 0, 0] },
  ].map((doc) => ({
    ...doc,
    weights: doc.weights.map((weight, i) => ({ departmentId: departments[i], weight })),
  }));
  const batch: AllocationBatch = { departments, documents };
  const result = allocateCosts(batch);
  assertBusinessRules(batch, result);
});

test("invalid input is rejected", () => {
  const base: AllocationBatch = {
    departments: ["A", "B"],
    documents: [
      {
        documentId: "x",
        amount: "1.0000",
        weights: [
          { departmentId: "A", weight: 5000 },
          { departmentId: "B", weight: 5000 },
        ],
      },
    ],
  };
  const clone = (): AllocationBatch => JSON.parse(JSON.stringify(base)) as AllocationBatch;

  allocateCosts(clone()); // sane batch must not throw

  const badAmount = clone();
  badAmount.documents[0].amount = "1.00001";
  assert.throws(() => allocateCosts(badAmount), /invalid amount/);

  const negative = clone();
  negative.documents[0].amount = "-1";
  assert.throws(() => allocateCosts(negative), /invalid amount/);

  const badSum = clone();
  badSum.documents[0].weights[0].weight = 5001;
  assert.throws(() => allocateCosts(badSum), /sum/);

  const unknownDept = clone();
  unknownDept.documents[0].weights[0].departmentId = "ZZ";
  assert.throws(() => allocateCosts(unknownDept), /unknown department/);

  const duplicateWeight = clone();
  duplicateWeight.documents[0].weights.push({ departmentId: "A", weight: 0 });
  assert.throws(() => allocateCosts(duplicateWeight), /twice/);

  const duplicateDoc = clone();
  duplicateDoc.documents.push(clone().documents[0]);
  assert.throws(() => allocateCosts(duplicateDoc), /duplicate document/);

  const fractionalWeight = clone();
  fractionalWeight.documents[0].weights[0].weight = 5000.5;
  assert.throws(() => allocateCosts(fractionalWeight), /invalid weight/);
});
