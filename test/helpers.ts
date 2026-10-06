import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Repository, Handle } from '../src/repository';
import type { ByteSource, Download, Hooks } from '../src/types';

export const CHUNK = 1 << 20; // 1 MiB

/** Deterministic byte pattern for a given upload seed. */
export function byteAt(index: number, seed: number): number {
  return (index * 31 + seed * 17 + ((index >> 8) * 7)) & 0xff;
}

/** Async byte source emitting `size` deterministic bytes in chunks of at most `chunkSize`. */
export async function* makeSource(
  size: number,
  seed: number,
  chunkSize = CHUNK,
): ByteSource {
  let offset = 0;
  while (offset < size) {
    const n = Math.min(chunkSize, size - offset);
    const buf = Buffer.allocUnsafe(n);
    for (let i = 0; i < n; i++) buf[i] = byteAt(offset + i, seed);
    offset += n;
    yield buf;
  }
}

/** Expected content of an upload with the given size/seed. */
export function expectedContent(size: number, seed: number): Buffer {
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) buf[i] = byteAt(i, seed);
  return buf;
}

/** Fully consume a download stream. */
export async function readAll(download: Download): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of download) {
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

/** A manually resolved promise, for deterministic interleaving in tests. */
export interface Gate {
  promise: Promise<void>;
  resolve(): void;
  reject(err: unknown): void;
  resolved: boolean;
}

export function makeGate(): Gate {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const gate: Gate = {
    promise: new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    }),
    resolve() {
      gate.resolved = true;
      resolve();
    },
    reject,
    resolved: false,
  };
  return gate;
}

export interface TestRepo {
  repo: Repository;
  dir: string;
  cleanup(): Promise<void>;
}

export async function makeRepo(hooks: Hooks = {}, retainCount?: number): Promise<TestRepo> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipeforge-test-'));
  const repo = new Repository({ dir, retainCount, hooks });
  return {
    repo,
    dir,
    async cleanup() {
      await fsp.rm(dir, { recursive: true, force: true });
    },
  };
}

/** Put a deterministic upload and return its handle. */
export async function putVersion(
  repo: Repository,
  version: string,
  size: number,
  seed: number,
): Promise<Handle> {
  return repo.put(version, makeSource(size, seed));
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}
