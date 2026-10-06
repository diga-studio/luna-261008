import assert from "node:assert/strict";
import test from "node:test";
import { HEADER, csvBytes, freshLens, readAll } from "./helpers.js";

test("concurrent calls are serialized", async () => {
  const { lens } = freshLens();

  async function* slow(rows: string[]): AsyncIterable<Uint8Array> {
    yield csvBytes(HEADER + "\n");
    for (const row of rows) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      yield csvBytes(row + "\n");
    }
  }

  const rowsA = Array.from({ length: 20 }, (_, i) => `a-${i},2024-01-01,1,1,1.00`);
  const rowsB = Array.from({ length: 20 }, (_, i) => `b-${i},2024-01-01,1,1,1.00`);
  // Second import reuses account A's keys: must see A's committed rows.
  const dupRows = rowsA.slice(0, 5);

  const [ra, rb, rd] = await Promise.all([
    lens.importBilling("acct", slow(rowsA)),
    lens.importBilling("acct", slow(rowsB)),
    lens.importBilling("acct", slow(dupRows)),
  ]);
  assert.deepEqual(ra, { status: "ok", imported: 20 });
  assert.deepEqual(rb, { status: "ok", imported: 20 });
  assert.equal(rd.status, "row_errors");
  if (rd.status === "row_errors") {
    assert.equal(rd.errors.length, 5);
    assert.ok(rd.errors.every((e) => e.code === "DUPLICATE_KEY"));
  }
  assert.equal((await readAll(lens, "acct")).length, 40);
  await lens.close();
});
