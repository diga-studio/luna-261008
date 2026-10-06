import { test } from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';
import { chunksOf, collect, encode, makeLens } from './helpers.js';

const HEADER = 'resource_id,usage_date,usage_quantity,unit_cost,total_cost';

// BOM, multibyte chars, quoted comma, multi-line quoted field, escaped
// quotes, CRLF and LF separators, plus three bad rows.
const REJECTED_CSV =
  '﻿' +
  HEADER + '\r\n' +
  '"res,天",2026-01-01,1,2,2\r\n' +
  '"multi\nline",2026-01-02,2.5,0.10,0.25\n' +
  '"say ""hi""",2026-01-03,3,1,3\r\n' +
  'too,few,fields,2026-01-04\r\n' +
  'bad-row,2026-13-40,1e5,0.10,0.10\n' +
  '"res,天",2026-01-01,9,9,81\r\n';

const EXPECTED_ERRORS = [
  { row: 4, code: 'FIELD_COUNT' },
  { row: 5, code: 'USAGE_DATE_INVALID' },
  { row: 5, code: 'USAGE_QUANTITY_INVALID' },
  { row: 6, code: 'DUPLICATE_KEY' },
];

const CHUNK_SIZES = [1, 2, 3, 5, 7, 16, 64, 1024, 1 << 20];

test('rejected import: identical diagnostics for every chunking', async () => {
  const data = encode(REJECTED_CSV);
  for (const size of CHUNK_SIZES) {
    const { lens, cleanup } = makeLens();
    try {
      const result = await lens.importBilling('acct', chunksOf(data, size));
      deepEqual(result, { ok: false, errors: EXPECTED_ERRORS }, `chunk size ${size}`);
      // Failed import must not change stored bills.
      deepEqual(await collect(lens.readBilling('acct')), [], `chunk size ${size}`);
    } finally {
      cleanup();
    }
  }
});

const SUCCESS_CSV =
  '﻿' +
  HEADER + '\r\n' +
  '"res,天",2026-01-01,1,2,2\r\n' +
  '"multi\nline",2026-01-02,2.5,0.10,0.25\n' +
  '"say ""hi""",2026-01-03,3,1,3\r\n' +
  'plain,2026-12-31,0.000001,0.00000001,0\n';

const EXPECTED_RECORDS = [
  {
    resourceId: 'res,天',
    usageDate: '2026-01-01',
    usageQuantity: '1',
    unitCost: '2',
    totalCost: '2',
  },
  {
    resourceId: 'multi\nline',
    usageDate: '2026-01-02',
    usageQuantity: '2.5',
    unitCost: '0.10',
    totalCost: '0.25',
  },
  {
    resourceId: 'say "hi"',
    usageDate: '2026-01-03',
    usageQuantity: '3',
    unitCost: '1',
    totalCost: '3',
  },
  {
    resourceId: 'plain',
    usageDate: '2026-12-31',
    usageQuantity: '0.000001',
    unitCost: '0.00000001',
    totalCost: '0',
  },
];

test('successful import: identical committed records for every chunking', async () => {
  const data = encode(SUCCESS_CSV);
  for (const size of CHUNK_SIZES) {
    const { lens, cleanup } = makeLens();
    try {
      const result = await lens.importBilling('acct', chunksOf(data, size));
      deepEqual(result, { ok: true, imported: 4 }, `chunk size ${size}`);
      deepEqual(await collect(lens.readBilling('acct')), EXPECTED_RECORDS, `chunk size ${size}`);
    } finally {
      cleanup();
    }
  }
});

test('accounts are isolated', async () => {
  const { lens, cleanup } = makeLens();
  try {
    const data = encode(SUCCESS_CSV);
    deepEqual(await lens.importBilling('a', chunksOf(data, 7)), { ok: true, imported: 4 });
    // Same keys under another account must not conflict.
    deepEqual(await lens.importBilling('b', chunksOf(data, 7)), { ok: true, imported: 4 });
    equal((await collect(lens.readBilling('a'))).length, 4);
    equal((await collect(lens.readBilling('b'))).length, 4);
  } finally {
    cleanup();
  }
});
