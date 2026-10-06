import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { ArchiveStore } from "../src/index";
import type { StoreOptions, Tier } from "../src/index";

export interface TestContext {
  root: string;
  options: StoreOptions;
  store: ArchiveStore;
}

export function makeStore(capacities: Record<Tier, number>): TestContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tiered-store-"));
  const options: StoreOptions = {
    dbPath: path.join(root, "meta.sqlite"),
    tiers: {
      hot: { dir: path.join(root, "hot"), capacityBytes: capacities.hot },
      warm: { dir: path.join(root, "warm"), capacityBytes: capacities.warm },
      cold: { dir: path.join(root, "cold"), capacityBytes: capacities.cold },
    },
  };
  return { root, options, store: ArchiveStore.open(options) };
}

export function cleanup(ctx: TestContext): void {
  try {
    ctx.store.close();
  } catch {
    // already closed
  }
  fs.rmSync(ctx.root, { recursive: true, force: true });
}

export function bytesOf(...chunks: string[]): Buffer {
  return Buffer.concat(chunks.map((c) => Buffer.from(c, "utf8")));
}

/** Deterministic pseudo-random content of the given length. */
export function contentOf(length: number, seed = 1): Buffer {
  const buf = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) >>> 0;
    buf[i] = (state >>> 16) & 0xff;
  }
  return buf;
}

export async function* streamOf(
  content: Buffer,
  chunkSize = 4096,
): AsyncGenerator<Buffer> {
  for (let offset = 0; offset < content.length; offset += chunkSize) {
    yield content.subarray(offset, Math.min(offset + chunkSize, content.length));
  }
}

/** A stream that yields `chunks` and then throws. */
export async function* failingStream(
  chunks: Buffer[],
  error: Error,
): AsyncGenerator<Buffer> {
  for (const chunk of chunks) yield chunk;
  throw error;
}

export function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Sum of byte sizes of all files directly inside a directory. */
export function dirBytes(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir)) {
    const stat = fs.statSync(path.join(dir, entry));
    if (stat.isFile()) total += stat.size;
  }
  return total;
}

export function dirFiles(dir: string): string[] {
  return fs.readdirSync(dir).sort();
}
