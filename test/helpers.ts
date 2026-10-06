import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewLibrary, type ReviewLibrary } from '../src/index.ts';

export const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

export const HEADER = 'channel,reviewer_name,text,timestamp\n';

export interface TestLib {
  lib: ReviewLibrary;
  cleanup: () => void;
}

export function makeLib(): TestLib {
  const dir = mkdtempSync(join(tmpdir(), 'review-csv-'));
  const lib = createReviewLibrary(join(dir, 'reviews.db'));
  return {
    lib,
    cleanup: () => {
      lib.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
