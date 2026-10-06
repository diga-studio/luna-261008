import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CostLens, type BillingRecord } from '../src/index.js';

export function makeLens(): { lens: CostLens; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'costlens-'));
  const lens = new CostLens(join(dir, 'billing.db'));
  return {
    lens,
    cleanup: () => {
      lens.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Split bytes into chunks of the given size (1 = byte-by-byte). */
export async function* chunksOf(
  data: Uint8Array,
  size: number,
): AsyncIterable<Uint8Array> {
  for (let i = 0; i < data.length; i += size) {
    yield data.subarray(i, Math.min(i + size, data.length));
  }
}

export async function collect(
  records: AsyncIterable<BillingRecord>,
): Promise<BillingRecord[]> {
  const out: BillingRecord[] = [];
  for await (const record of records) out.push(record);
  return out;
}
