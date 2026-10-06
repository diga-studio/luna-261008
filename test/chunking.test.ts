import assert from "node:assert/strict";
import test from "node:test";
import type { ImportResult } from "../src/index.js";
import {
  HEADER,
  chunkBytes,
  csvBytes,
  freshLens,
  readAll,
  toStream,
} from "./helpers.js";

const BOM = "﻿";

// Rich CSV: BOM, multibyte chars, quoted commas, escaped quotes,
// quoted fields spanning physical lines (LF and CRLF).
const RICH_ROWS = [
  "plain-1,2024-01-15,2,3.005,6.01",
  '"res,with-comma",2024-01-16,1,1,1.00',
  '"multi\nline",2024-01-17,1,2,2.00',
  '"crlf\r\ninside",2024-01-18,1,3,3.00',
  '"quote""escaped",2024-01-19,1,4,4.00',
  "资源-多字节,2024-01-20,1,0.5,0.50",
  '"混合 mix,😀 emoji",2024-01-21,1.25,8,10.00',
];
const RICH_CSV = BOM + HEADER + "\r\n" + RICH_ROWS.join("\r\n") + "\r\n";

const EXPECTED_RECORDS = [
  { resourceId: "plain-1", usageDate: "2024-01-15", quantity: "2", unitCost: "3.005", totalCost: "6.01" },
  { resourceId: "res,with-comma", usageDate: "2024-01-16", quantity: "1", unitCost: "1", totalCost: "1.00" },
  { resourceId: "multi\nline", usageDate: "2024-01-17", quantity: "1", unitCost: "2", totalCost: "2.00" },
  { resourceId: "crlf\r\ninside", usageDate: "2024-01-18", quantity: "1", unitCost: "3", totalCost: "3.00" },
  { resourceId: 'quote"escaped', usageDate: "2024-01-19", quantity: "1", unitCost: "4", totalCost: "4.00" },
  { resourceId: "资源-多字节", usageDate: "2024-01-20", quantity: "1", unitCost: "0.5", totalCost: "0.50" },
  { resourceId: "混合 mix,😀 emoji", usageDate: "2024-01-21", quantity: "1.25", unitCost: "8", totalCost: "10.00" },
];

// CSV with row-level errors; embedded newlines inside quoted fields must
// not shift logical record numbers.
const BAD_ROWS = [
  "ok-1,2024-01-01,1,1,1.00", // line 1: valid
  '"bad\nquoted",2024-01-02,abc,1,1.00', // line 2: INVALID_QUANTITY
  "bad-date,2024-13-01,1,1,1.00", // line 3: INVALID_DATE
  "ok-1,2024-01-01,1,1,1.00", // line 4: DUPLICATE_KEY (line 1)
  "short,2024-01-01", // line 5: FIELD_COUNT
  ",2024-01-01,1,1,1.00", // line 6: EMPTY_RESOURCE_ID
  '"multi\r\nerr",2024-02-30,-1,1e5,1.005', // line 7: date, quantity, unit, total
  "ok-2,2024-01-03,2,2,4.00", // line 8: valid but rejected with the batch
];
const BAD_CSV = BOM + HEADER + "\n" + BAD_ROWS.join("\n") + "\n";

const EXPECTED_BAD_ERRORS = [
  { line: 2, code: "INVALID_QUANTITY" },
  { line: 3, code: "INVALID_DATE" },
  { line: 4, code: "DUPLICATE_KEY" },
  { line: 5, code: "FIELD_COUNT" },
  { line: 6, code: "EMPTY_RESOURCE_ID" },
  { line: 7, code: "INVALID_DATE" },
  { line: 7, code: "INVALID_QUANTITY" },
  { line: 7, code: "INVALID_UNIT_COST" },
  { line: 7, code: "INVALID_TOTAL_COST" },
];

const CHUNK_SIZES = [1, 2, 3, 5, 7, 13, 64, 1024, 65536, 1 << 20];

test("successful import is identical for every chunking", async () => {
  const results: ImportResult[] = [];
  const reads: unknown[] = [];
  for (const size of CHUNK_SIZES) {
    const { lens } = freshLens();
    const bytes = csvBytes(RICH_CSV);
    const result = await lens.importBilling("acct", toStream(chunkBytes(bytes, size)));
    results.push(result);
    reads.push(await readAll(lens, "acct"));
    await lens.close();
  }
  for (const result of results) {
    assert.deepEqual(result, { status: "ok", imported: EXPECTED_RECORDS.length });
  }
  for (const records of reads) {
    assert.deepEqual(records, EXPECTED_RECORDS);
  }
});

test("rejection list is identical for every chunking and store stays empty", async () => {
  const results: ImportResult[] = [];
  for (const size of CHUNK_SIZES) {
    const { lens } = freshLens();
    const bytes = csvBytes(BAD_CSV);
    const result = await lens.importBilling("acct", toStream(chunkBytes(bytes, size)));
    results.push(result);
    assert.deepEqual(await readAll(lens, "acct"), []);
    await lens.close();
  }
  for (const result of results) {
    assert.deepEqual(result, { status: "row_errors", errors: EXPECTED_BAD_ERRORS });
  }
});

test("chunk boundaries inside UTF-8, CRLF and escaped quotes", async () => {
  // Every possible 2-chunk split of a tricky input.
  const csv = BOM + HEADER + "\r\n" + '"a""b,😀",2024-01-01,1,1,1.00\r\n';
  const bytes = csvBytes(csv);
  for (let split = 0; split <= bytes.length; split++) {
    const { lens } = freshLens();
    const chunks = [bytes.subarray(0, split), bytes.subarray(split)].filter((c) => c.length > 0);
    const result = await lens.importBilling("acct", toStream(chunks));
    assert.deepEqual(result, { status: "ok", imported: 1 }, `split at ${split}`);
    assert.deepEqual(await readAll(lens, "acct"), [
      { resourceId: 'a"b,😀', usageDate: "2024-01-01", quantity: "1", unitCost: "1", totalCost: "1.00" },
    ]);
    await lens.close();
  }
});
