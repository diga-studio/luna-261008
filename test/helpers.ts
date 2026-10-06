import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempDir {
  path: string;
  file(name: string): string;
  cleanup(): void;
}

export function tempDir(): TempDir {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-test-"));
  return {
    path: dir,
    file: (name: string) => join(dir, name),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Deterministic pseudo-random bytes so bodies are distinguishable. */
export function makeBody(seed: number, size = 64): Uint8Array {
  const body = new Uint8Array(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    body[i] = (x >>> 16) & 0xff;
  }
  return body;
}
