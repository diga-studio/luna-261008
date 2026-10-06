import assert from "node:assert/strict";
import test from "node:test";
import { FileImportError } from "../src/index.js";
import type { FileErrorCode } from "../src/index.js";
import {
  HEADER,
  chunkBytes,
  csvBytes,
  freshLens,
  readAll,
  toStream,
} from "./helpers.js";

async function expectFileError(
  chunks: Uint8Array[] | AsyncIterable<Uint8Array>,
  code: FileErrorCode,
): Promise<void> {
  const { lens } = freshLens();
  const stream = Array.isArray(chunks) ? toStream(chunks) : chunks;
  await assert.rejects(
    lens.importBilling("acct", stream),
    (err: unknown) => err instanceof FileImportError && err.code === code,
  );
  assert.deepEqual(await readAll(lens, "acct"), []);
  await lens.close();
}

test("invalid UTF-8 is a file-level failure", async () => {
  const good = csvBytes(HEADER + "\nok,2024-01-01,1,1,1.00\n");
  const bad = new Uint8Array([0x72, 0x2d, 0x32, 0x2c, 0x32, 0x30, 0x32, 0x34, 0x2d, 0x30, 0x31, 0x2d, 0x30, 0x32, 0x2c, 0x31, 0x2c, 0x31, 0x2c, 0x31, 0x2e, 0x30, 0x30, 0x0a, 0x62, 0x61, 0x64, 0xff, 0x2c, 0x32, 0x30, 0x32, 0x34, 0x2d, 0x30, 0x31, 0x2d, 0x30, 0x33, 0x2c, 0x31, 0x2c, 0x31, 0x2c, 0x31, 0x2e, 0x30, 0x30, 0x0a]);
  await expectFileError([good, bad], "INVALID_UTF8");
});

test("wrong header is a file-level failure", async () => {
  await expectFileError([csvBytes("a,b,c,d,e\nr,2024-01-01,1,1,1.00\n")], "HEADER_MISMATCH");
  await expectFileError([csvBytes("resource_id,usage_date,usage_quantity,unit_cost\n")], "HEADER_MISMATCH");
  await expectFileError([csvBytes("")], "HEADER_MISMATCH");
});

test("broken CSV syntax is a file-level failure", async () => {
  await expectFileError([csvBytes(HEADER + '\n"unterminated,2024-01-01,1,1,1.00\n')], "CSV_SYNTAX");
  await expectFileError([csvBytes(HEADER + '\nplain"quote,2024-01-01,1,1,1.00\n')], "CSV_SYNTAX");
  await expectFileError([csvBytes(HEADER + '\n"closed"x,2024-01-01,1,1,1.00\n')], "CSV_SYNTAX");
  await expectFileError([csvBytes(HEADER + "\na,2024-01-01,1,1,1.00\rb,2024-01-02,1,1,1.00\n")], "CSV_SYNTAX");
});

test("record over 64 KiB is a file-level failure", async () => {
  const big = "x".repeat(64 * 1024);
  await expectFileError([csvBytes(HEADER + `\n${big},2024-01-01,1,1,1.00\n`)], "RECORD_TOO_LARGE");
});

test("stream exception aborts and rolls back earlier valid rows", async () => {
  async function* failing(): AsyncIterable<Uint8Array> {
    yield csvBytes(HEADER + "\nok,2024-01-01,1,1,1.00\n");
    throw new Error("network gone");
  }
  await expectFileError(failing(), "STREAM_ERROR");
});

test("file-level failure leaves previously committed data intact", async () => {
  const { lens } = freshLens();
  const good = HEADER + "\nkeep,2024-01-01,1,1,1.00\n";
  assert.deepEqual(await lens.importBilling("acct", toStream([csvBytes(good)])), {
    status: "ok",
    imported: 1,
  });
  await assert.rejects(
    lens.importBilling("acct", toStream([csvBytes("bad,header\n")])) ,
    (err: unknown) => err instanceof FileImportError && err.code === "HEADER_MISMATCH",
  );
  assert.deepEqual(await readAll(lens, "acct"), [
    { resourceId: "keep", usageDate: "2024-01-01", quantity: "1", unitCost: "1", totalCost: "1.00" },
  ]);
  await lens.close();
});

test("different accounts do not conflict", async () => {
  const { lens } = freshLens();
  const csv = HEADER + "\nsame-key,2024-01-01,1,1,1.00\n";
  assert.deepEqual(await lens.importBilling("a", toStream([csvBytes(csv)])), {
    status: "ok",
    imported: 1,
  });
  assert.deepEqual(await lens.importBilling("b", toStream([csvBytes(csv)])), {
    status: "ok",
    imported: 1,
  });
  assert.equal((await readAll(lens, "a")).length, 1);
  assert.equal((await readAll(lens, "b")).length, 1);
  await lens.close();
});

test("LF and CRLF separators can be mixed", async () => {
  const { lens } = freshLens();
  const csv = HEADER + "\r\nlf,2024-01-01,1,1,1.00\ncrlf,2024-01-02,1,1,1.00\r\n";
  const result = await lens.importBilling("acct", toStream(chunkBytes(csvBytes(csv), 3)));
  assert.deepEqual(result, { status: "ok", imported: 2 });
  await lens.close();
});

test("resource_id is compared exactly, no trimming or case folding", async () => {
  const { lens } = freshLens();
  const csv =
    HEADER +
    '\n" pad",2024-01-01,1,1,1.00\n"pad ",2024-01-01,1,1,1.00\nPAD,2024-01-01,1,1,1.00\npad,2024-01-01,1,1,1.00\n';
  const result = await lens.importBilling("acct", toStream([csvBytes(csv)]));
  assert.deepEqual(result, { status: "ok", imported: 4 });
  const dup = HEADER + "\npad,2024-01-01,1,1,1.00\n";
  const second = await lens.importBilling("acct", toStream([csvBytes(dup)]));
  assert.deepEqual(second, {
    status: "row_errors",
    errors: [{ line: 1, code: "DUPLICATE_KEY" }],
  });
  await lens.close();
});
