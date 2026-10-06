import { test } from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';
import { chunksOf, collect, encode, makeLens } from './helpers.js';

const HEADER = 'resource_id,usage_date,usage_quantity,unit_cost,total_cost';
const TOTAL = 50000;

function dateFor(i: number): string {
  const month = String((i % 12) + 1).padStart(2, '0');
  const day = String((i % 28) + 1).padStart(2, '0');
  return `2026-${month}-${day}`;
}

test('50000-record import: full diagnostics, committed data untouched', async () => {
  const { lens, cleanup } = makeLens();
  try {
    // Seed 50000 committed records.
    const seedRows: string[] = [];
    for (let i = 1; i <= TOTAL; i++) {
      seedRows.push(`res1-${i},${dateFor(i)},1,1,1`);
    }
    const seed = HEADER + '\n' + seedRows.join('\n') + '\n';
    deepEqual(await lens.importBilling('acct', chunksOf(encode(seed), 4096)), {
      ok: true,
      imported: TOTAL,
    });
    const before = await collect(lens.readBilling('acct'));
    equal(before.length, TOTAL);

    // Second import: 50000 records with a mix of failures.
    const rows: string[] = [];
    for (let i = 1; i <= TOTAL; i++) {
      if (i === 100 || i === 200 || i === 300) {
        // Conflicts with already-committed bills.
        rows.push(`res1-${i},${dateFor(i)},1,1,1`);
      } else if (i === 400) {
        // Valid key, wrong amount: still claims the key for this batch.
        rows.push(`dup-key,2026-06-15,2,0.10,0.99`);
      } else if (i === 40000) {
        // Same key as row 400 -> duplicate even though row 400 was bad.
        rows.push(`dup-key,2026-06-15,2,0.10,0.20`);
      } else if (i === TOTAL) {
        // Last row is also erroneous (wrong field count).
        rows.push('last,row,only-three-fields');
      } else {
        rows.push(`res2-${i},${dateFor(i)},2,0.10,0.20`);
      }
    }
    const csv = HEADER + '\n' + rows.join('\n') + '\n';
    const result = await lens.importBilling('acct', chunksOf(encode(csv), 8192));
    deepEqual(result, {
      ok: false,
      errors: [
        { row: 100, code: 'DUPLICATE_KEY' },
        { row: 200, code: 'DUPLICATE_KEY' },
        { row: 300, code: 'DUPLICATE_KEY' },
        { row: 400, code: 'TOTAL_COST_MISMATCH' },
        { row: 40000, code: 'DUPLICATE_KEY' },
        { row: 50000, code: 'FIELD_COUNT' },
      ],
    });

    // Stored bills must be byte-identical to before the failed import.
    deepEqual(await collect(lens.readBilling('acct')), before);
  } finally {
    cleanup();
  }
});
