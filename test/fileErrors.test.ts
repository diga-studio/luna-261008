import { test } from 'node:test';
import { deepEqual, rejects } from 'node:assert/strict';
import { ImportFileError } from '../src/index.js';
import { chunksOf, collect, encode, makeLens } from './helpers.js';

const HEADER = 'resource_id,usage_date,usage_quantity,unit_cost,total_cost';
const SEED = HEADER + '\n' + 'seed,2026-01-01,1,1,1\n';
const SEED_RECORD = {
  resourceId: 'seed',
  usageDate: '2026-01-01',
  usageQuantity: '1',
  unitCost: '1',
  totalCost: '1',
};

async function expectFileError(
  chunks: AsyncIterable<Uint8Array>,
  code: string,
): Promise<void> {
  const { lens, cleanup } = makeLens();
  try {
    await lens.importBilling('acct', chunksOf(encode(SEED), 3));
    await rejects(
      () => lens.importBilling('acct', chunks),
      (e: unknown) => e instanceof ImportFileError && e.code === code,
    );
    // Committed data survives every file-level failure.
    deepEqual(await collect(lens.readBilling('acct')), [SEED_RECORD]);
  } finally {
    cleanup();
  }
}

test('invalid UTF-8 mid-stream', async () => {
  async function* bad(): AsyncIterable<Uint8Array> {
    yield encode(HEADER + '\n' + 'a,2026-01-01,1,1,1\n');
    yield new Uint8Array([0xe5, 0xa4]); // truncated multibyte sequence
    yield encode('more,2026-01-02,1,1,1\n');
  }
  await expectFileError(bad(), 'INVALID_UTF8');
});

test('invalid UTF-8 bytes', async () => {
  async function* bad(): AsyncIterable<Uint8Array> {
    yield encode(HEADER + '\n');
    yield new Uint8Array([0xff, 0xfe, 0x41]);
  }
  await expectFileError(bad(), 'INVALID_UTF8');
});

test('character after closing quote', async () => {
  const csv = HEADER + '\n' + '"abc"x,2026-01-01,1,1,1\n';
  await expectFileError(chunksOf(encode(csv), 2), 'CSV_SYNTAX');
});

test('unterminated quoted field', async () => {
  const csv = HEADER + '\n' + '"abc,2026-01-01,1,1,1\n';
  await expectFileError(chunksOf(encode(csv), 2), 'CSV_SYNTAX');
});

test('wrong header', async () => {
  const csv = 'resource_id,usage_date,usage_quantity,unit_cost,total\n' + 'a,2026-01-01,1,1,1\n';
  await expectFileError(chunksOf(encode(csv), 3), 'INVALID_HEADER');
});

test('missing header (empty input)', async () => {
  await expectFileError(chunksOf(encode(''), 1), 'INVALID_HEADER');
});

test('input stream throws', async () => {
  async function* bad(): AsyncIterable<Uint8Array> {
    yield encode(HEADER + '\n' + 'a,2026-01-01,1,1,1\n');
    throw new Error('network gone');
  }
  await expectFileError(bad(), 'STREAM_ERROR');
});

test('record exceeding 64 KiB', async () => {
  const csv = HEADER + '\n' + 'x'.repeat(70 * 1024) + ',2026-01-01,1,1,1\n';
  await expectFileError(chunksOf(encode(csv), 4096), 'RECORD_TOO_LARGE');
});
