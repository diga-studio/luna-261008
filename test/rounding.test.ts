import { test } from 'node:test';
import { deepEqual } from 'node:assert/strict';
import { chunksOf, collect, encode, makeLens } from './helpers.js';

const HEADER = 'resource_id,usage_date,usage_quantity,unit_cost,total_cost';

// Half-even midpoint cases and totals whose cent value exceeds
// Number.MAX_SAFE_INTEGER (9007199254740991).
const VALID_ROWS: Array<[string, string, string]> = [
  // quantity, unit_cost, total_cost (exact half-even expectation), note
  ['0.5', '0.05', '0.02'], // 0.025 -> 0.02 (2 even)
  ['1.5', '0.05', '0.08'], // 0.075 -> 0.08 (8 even)
  ['2.5', '0.05', '0.12'], // 0.125 -> 0.12 (2 even)
  ['3.5', '0.05', '0.18'], // 0.175 -> 0.18
  ['1', '-0.025', '-0.02'], // negative midpoint -> -0.02 (even)
  ['1', '-0.075', '-0.08'], // negative midpoint -> -0.08 (even)
  ['1', '-0.025001', '-0.03'], // just past midpoint rounds away
  ['2', '0.005', '0.01'], // 0.010 exact
  ['90071992547409.93', '1', '90071992547409.93'], // cents = 9007199254740993 > MAX_SAFE_INTEGER
  ['1', '9999999999999999.99', '9999999999999999.99'], // 16-digit integer part
  ['0.000001', '0.00000001', '0'], // tiny product rounds to zero
  ['1.005', '1', '1.00'], // 100.5 cents -> tie -> 100 (even)
];

test('half-even rounding: valid totals accepted and read back exactly', async () => {
  const { lens, cleanup } = makeLens();
  try {
    const rows = VALID_ROWS.map(
      ([q, u, t], i) => `r${i},2026-01-${String((i % 28) + 1).padStart(2, '0')},${q},${u},${t}`,
    );
    const csv = HEADER + '\n' + rows.join('\n') + '\n';
    const result = await lens.importBilling('acct', chunksOf(encode(csv), 3));
    deepEqual(result, { ok: true, imported: VALID_ROWS.length });
    const stored = await collect(lens.readBilling('acct'));
    deepEqual(
      stored.map((r) => [r.usageQuantity, r.unitCost, r.totalCost]),
      VALID_ROWS.map(([q, u, t]) => [q, u, t]),
    );
  } finally {
    cleanup();
  }
});

test('off-by-one-cent totals are rejected', async () => {
  const { lens, cleanup } = makeLens();
  try {
    const rows = [
      'a,2026-01-01,0.5,0.05,0.03', // true 0.02
      'b,2026-01-01,1.5,0.05,0.07', // true 0.08
      'c,2026-01-01,1,-0.025,-0.03', // true -0.02
      'd,2026-01-01,90071992547409.93,1,90071992547409.92', // one cent short
      'e,2026-01-01,90071992547409.93,1,90071992547409.94', // one cent over
    ];
    const csv = HEADER + '\n' + rows.join('\n') + '\n';
    const result = await lens.importBilling('acct', chunksOf(encode(csv), 5));
    deepEqual(result, {
      ok: false,
      errors: [
        { row: 1, code: 'TOTAL_COST_MISMATCH' },
        { row: 2, code: 'TOTAL_COST_MISMATCH' },
        { row: 3, code: 'TOTAL_COST_MISMATCH' },
        { row: 4, code: 'TOTAL_COST_MISMATCH' },
        { row: 5, code: 'TOTAL_COST_MISMATCH' },
      ],
    });
    deepEqual(await collect(lens.readBilling('acct')), []);
  } finally {
    cleanup();
  }
});

test('malformed decimals are rejected', async () => {
  const { lens, cleanup } = makeLens();
  try {
    const bad = ['1e3', '+1', ' 1', '1 ', '.5', '1.', '-0.5', '1.0000000', '12345678901234567'];
    const rows = bad.map((q, i) => `r${i},2026-01-01,${q},1,1`);
    const csv = HEADER + '\n' + rows.join('\n') + '\n';
    const result = await lens.importBilling('acct', chunksOf(encode(csv), 4));
    deepEqual(
      result,
      {
        ok: false,
        errors: bad.map((_, i) => ({ row: i + 1, code: 'USAGE_QUANTITY_INVALID' })),
      },
    );
    deepEqual(await collect(lens.readBilling('acct')), []);
  } finally {
    cleanup();
  }
});
