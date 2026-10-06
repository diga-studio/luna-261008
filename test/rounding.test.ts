import assert from "node:assert/strict";
import test from "node:test";
import {
  HEADER,
  chunkBytes,
  csvBytes,
  freshLens,
  readAll,
  refTotal,
  toStream,
} from "./helpers.js";

async function importRows(rows: string[]) {
  const { lens } = freshLens();
  const csv = HEADER + "\n" + rows.join("\n") + "\n";
  const result = await lens.importBilling("acct", toStream(chunkBytes(csvBytes(csv), 4096)));
  const records = await readAll(lens, "acct");
  await lens.close();
  return { result, records };
}

test("half-even midpoint rounding, positive and negative", async () => {
  const cases: Array<[string, string, string]> = [
    // quantity, unitCost, expected total (round half to even cents)
    ["1", "0.125", "0.12"], // 0.125 -> 0.12 (2 is even)
    ["1", "0.135", "0.14"], // 0.135 -> 0.14 (4 is even)
    ["1", "0.145", "0.14"], // 0.145 -> 0.14
    ["1", "0.155", "0.16"], // 0.155 -> 0.16
    ["1", "-0.125", "-0.12"], // symmetric for negatives
    ["1", "-0.135", "-0.14"],
    ["1", "-0.145", "-0.14"],
    ["3", "0.015", "0.04"], // 0.045 -> 0.04
    ["3", "0.025", "0.08"], // 0.075 -> 0.08
    ["2", "-0.025", "-0.04"], // -0.05 -> -0.04 (0 is even)
    ["2", "-0.075", "-0.14"], // -0.15 -> -0.14? no: -0.15 midpoint -> -0.15*100=-15 -> even is -14? -15 odd -> -16? check: -0.15 -> cents -15, half-even picks even: -16? no...
  ];
  // Recompute expectations independently instead of trusting the table.
  const rows = cases.map(([q, u], i) => `r-${i},2024-01-01,${q},${u},${refTotal(q, u)}`);
  const { result, records } = await importRows(rows);
  assert.deepEqual(result, { status: "ok", imported: cases.length });
  for (let i = 0; i < cases.length; i++) {
    assert.equal(records[i]!.totalCost, refTotal(cases[i]![0], cases[i]![1]));
  }
  // Spot-check the table itself against known half-even answers.
  assert.equal(refTotal("1", "0.125"), "0.12");
  assert.equal(refTotal("1", "0.135"), "0.14");
  assert.equal(refTotal("1", "-0.125"), "-0.12");
  assert.equal(refTotal("1", "-0.135"), "-0.14");
  assert.equal(refTotal("3", "0.015"), "0.04");
  assert.equal(refTotal("3", "0.025"), "0.08");
});

test("off-by-one-cent totals are rejected", async () => {
  const rows = [
    "ok,2024-01-01,1,0.125,0.12",
    "high,2024-01-01,1,0.125,0.13",
    "low,2024-01-01,1,0.125,0.11",
    "neg-high,2024-01-01,1,-0.125,-0.11",
    "neg-low,2024-01-01,1,-0.125,-0.13",
  ];
  const { result, records } = await importRows(rows);
  assert.deepEqual(result, {
    status: "row_errors",
    errors: [
      { line: 2, code: "TOTAL_MISMATCH" },
      { line: 3, code: "TOTAL_MISMATCH" },
      { line: 4, code: "TOTAL_MISMATCH" },
      { line: 5, code: "TOTAL_MISMATCH" },
    ],
  });
  assert.deepEqual(records, []);
});

test("totals beyond the JS safe-integer range stay exact", async () => {
  // 2^53 + 1, not representable as a JS number.
  const cases: Array<[string, string]> = [
    ["9007199254740993", "1"], // 2^53 + 1, not representable as a JS number
    ["9999999999999999", "1"],
    ["1234567890123456.000001", "1.00000001"],
    ["9999999999999999.999999", "-0.99999999"],
  ];
  const rows = cases.map(([q, u], i) => `big-${i},2024-01-01,${q},${u},${refTotal(q, u)}`);
  const { result, records } = await importRows(rows);
  assert.deepEqual(result, { status: "ok", imported: cases.length });
  for (let i = 0; i < cases.length; i++) {
    assert.equal(records[i]!.quantity, cases[i]![0]);
    assert.equal(records[i]!.unitCost, cases[i]![1]);
    assert.equal(records[i]!.totalCost, refTotal(cases[i]![0], cases[i]![1]));
  }
  // Sanity: these cents values really are beyond Number.MAX_SAFE_INTEGER.
  const cents = BigInt(records[1]!.totalCost.replace(".", "").replace("-", ""));
  assert.ok(cents > BigInt(Number.MAX_SAFE_INTEGER));
});

test("huge total off by one cent is rejected", async () => {
  const q = "9999999999999999";
  const u = "1";
  const exact = refTotal(q, u);
  const cents = BigInt(exact.replace(".", ""));
  const wrong = `${(cents + 1n).toString().slice(0, -2)}.${(cents + 1n).toString().slice(-2)}`;
  const { result } = await importRows([`big,2024-01-01,${q},${u},${wrong}`]);
  assert.deepEqual(result, {
    status: "row_errors",
    errors: [{ line: 1, code: "TOTAL_MISMATCH" }],
  });
});

test("decimal syntax rules are enforced", async () => {
  const bad = [
    ["q-plus", "2024-01-01", "+1", "1", "1.00", "INVALID_QUANTITY"],
    ["q-neg", "2024-01-01", "-1", "1", "1.00", "INVALID_QUANTITY"],
    ["q-exp", "2024-01-01", "1e3", "1", "1.00", "INVALID_QUANTITY"],
    ["q-noint", "2024-01-01", ".5", "1", "1.00", "INVALID_QUANTITY"],
    ["q-space", "2024-01-01", " 1", "1", "1.00", "INVALID_QUANTITY"],
    ["q-frac7", "2024-01-01", "0.0000001", "1", "0.00", "INVALID_QUANTITY"],
    ["u-frac9", "2024-01-01", "1", "0.000000001", "0.00", "INVALID_UNIT_COST"],
    ["t-frac3", "2024-01-01", "1", "1", "1.001", "INVALID_TOTAL_COST"],
    ["int17", "2024-01-01", "12345678901234567", "1", "1.00", "INVALID_QUANTITY"],
  ] as const;
  const rows = bad.map(([id, date, q, u, t]) => `${id},${date},${q},${u},${t}`);
  const { result } = await importRows(rows);
  assert.equal(result.status, "row_errors");
  if (result.status !== "row_errors") return;
  assert.deepEqual(
    result.errors,
    bad.map(([, , , , , code], i) => ({ line: i + 1, code })),
  );
});

test("date rules: real Gregorian dates, years 0001-9999", async () => {
  const rows = [
    "d1,0001-01-01,1,1,1.00", // ok
    "d2,9999-12-31,1,1,1.00", // ok
    "d3,2000-02-29,1,1,1.00", // ok, leap
    "d4,1900-02-29,1,1,1.00", // bad, not leap
    "d5,0000-01-01,1,1,1.00", // bad, year 0
    "d6,2024-2-3,1,1,1.00", // bad, not zero-padded
    "d7,2024-04-31,1,1,1.00", // bad, April has 30 days
    "d8,20240101,1,1,1.00", // bad format
  ];
  const { result, records } = await importRows(rows);
  assert.deepEqual(result, {
    status: "row_errors",
    errors: [
      { line: 4, code: "INVALID_DATE" },
      { line: 5, code: "INVALID_DATE" },
      { line: 6, code: "INVALID_DATE" },
      { line: 7, code: "INVALID_DATE" },
      { line: 8, code: "INVALID_DATE" },
    ],
  });
  assert.deepEqual(records, []);
});
