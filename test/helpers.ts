import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewStore } from '../src/store.js';

/** 把字符串编码为 UTF-8，并按指定块大小切成一次性字节流。 */
export function toStream(text: string, chunkSize = 1024): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return toByteStream(bytes, chunkSize);
}

export function toByteStream(bytes: Uint8Array, chunkSize = 1024): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (let i = 0; i < bytes.length; i += chunkSize) {
      yield bytes.subarray(i, i + chunkSize);
    }
  })();
}

export function makeStore(): { store: ReviewStore; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'review-importer-'));
  const dbPath = join(dir, 'reviews.db');
  return { store: new ReviewStore(dbPath), dbPath };
}

export const HEADER = 'channel,reviewer_name,text,timestamp\n';
