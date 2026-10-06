import assert from "node:assert/strict";
import test from "node:test";
import type { RowError } from "../src/index.js";
import {
  HEADER,
  chunkBytes,
  csvBytes,
  freshLens,
  readAll,
  toStream,
} from "./helpers.js";

const TOTAL = 50000;

test("50000-record import: complete diagnostics, store untouched on failure", async (t) => {
  const { lens } = freshLens();

  // Pre-existing committed billing for two accounts.
  const preRows: string[] = [];
  for (let i = 0; i < 200; i++) preRows.push(`pre-${i},2024-01-01,1,1,1.00`);
  const preCsv = HEADER + "\n" + preRows.join("\n") + "\n";
  assert.deepEqual(await lens.importBilling("acct", toStream(chunkBytes(csvBytes(preCsv), 8192))), {
    status: "ok",
    imported: 200,
  });
  assert.deepEqual(
    await lens.importBilling("other", toStream(chunkBytes(csvBytes(preCsv), 8192))),
    { status: "ok", imported: 200 },
  );
  const before = await readAll(lens, "acct");
  const beforeOther = await readAll(lens, "other");

  // Build the 50000-row CSV and the expected diagnostics.
  const rows: string[] = [];
  const expected: RowError[] = [];
  for (let i = 0; i < TOTAL; i++) {
    const line = i + 1;
    if (i === TOTAL - 1) {
      rows.push(`last,2024-02-30,1,1,1.00`); // invalid date on the final row
      expected.push({ line, code: "INVALID_DATE" });
    } else if (i % 1000 === 0) {
      // Conflicts with already-committed billing.
      rows.push(`pre-${i / 1000},2024-01-01,2,2,4.00`);
      expected.push({ line, code: "DUPLICATE_KEY" });
    } else if (i % 500 === 250) {
      // Amount error but valid key: still participates in batch dedup.
      rows.push(`badamt-${i},2024-03-05,1,1,9.99`);
      expected.push({ line, code: "TOTAL_MISMATCH" });
    } else if (i % 500 === 251) {
      // Same key as the previous (amount-error) row: must be a duplicate.
      rows.push(`badamt-${i - 1},2024-03-05,1,1,1.00`);
      expected.push({ line, code: "DUPLICATE_KEY" });
    } else {
      const day = String((i % 28) + 1).padStart(2, "0");
      rows.push(`bulk-${i},2024-03-${day},1.5,2,3.00`);
    }
  }
  expected.sort((a, b) => a.line - b.line);

  const csv = HEADER + "\n" + rows.join("\n") + "\n";
  const result = await lens.importBilling("acct", toStream(chunkBytes(csvBytes(csv), 65536)));

  assert.equal(result.status, "row_errors");
  if (result.status !== "row_errors") return;
  assert.equal(result.errors.length, expected.length);
  assert.deepEqual(result.errors, expected);

  // Nothing was committed; both accounts are exactly as before.
  assert.deepEqual(await readAll(lens, "acct"), before);
  assert.deepEqual(await readAll(lens, "other"), beforeOther);
  await lens.close();
});

test("50000 valid records import cleanly with no duplicates", async () => {
  const { lens } = freshLens();
  const rows: string[] = [];
  for (let i = 0; i < TOTAL; i++) {
    const day = String((i % 28) + 1).padStart(2, "0");
    rows.push(`ok-${i},2024-05-${day},2.5,4,10.00`);
  }
  const csv = HEADER + "\n" + rows.join("\n") + "\n";
  const result = await lens.importBilling("acct", toStream(chunkBytes(csvBytes(csv), 1 << 20)));
  assert.deepEqual(result, { status: "ok", imported: TOTAL });
  const records = await readAll(lens, "acct");
  assert.equal(records.length, TOTAL);
  assert.deepEqual(records[0], {
    resourceId: "ok-0",
    usageDate: "2024-05-01",
    quantity: "2.5",
    unitCost: "4",
    totalCost: "10.00",
  });
  await lens.close();
});

test("re-importing the same file reports every row as duplicate", async () => {
  const { lens } = freshLens();
  const rows: string[] = [];
  for (let i = 0; i < 500; i++) rows.push(`r-${i},2024-06-01,1,1,1.00`);
  const csv = HEADER + "\n" + rows.join("\n") + "\n";
  assert.deepEqual(await lens.importBilling("acct", toStream(chunkBytes(csvBytes(csv), 4096))), {
    status: "ok",
    imported: 500,
  });
  const again = await lens.importBilling("acct", toStream(chunkBytes(csvBytes(csv), 4096)));
  assert.equal(again.status, "row_errors");
  if (again.status !== "row_errors") return;
  assert.equal(again.errors.length, 500);
  assert.deepEqual(again.errors[0], { line: 1, code: "DUPLICATE_KEY" });
  assert.deepEqual(again.errors[499], { line: 500, code: "DUPLICATE_KEY" });
  assert.equal((await readAll(lens, "acct")).length, 500);
  await lens.close();
});
