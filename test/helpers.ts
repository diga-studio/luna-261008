import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BLOCK_SIZE, type VersionEntry } from "../src/index.js";

export function sha256hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** 确定性伪随机字节（mulberry32），便于重建“原始内容”。 */
export function makeBytes(seed: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[i] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
  }
  return out;
}

export interface BlockSpec {
  seed: number;
  length: number;
}

export interface Fixture {
  versions: VersionEntry[];
  /** hash -> 正确正文 */
  bodies: Map<string, Uint8Array>;
}

/**
 * 构造清单：每个版本由若干 (seed, length) 块组成。
 * 同一 seed 生成同一正文，因此跨版本与同版本内的重复引用自然共享哈希。
 */
export function buildFixture(layout: BlockSpec[][]): Fixture {
  const bodies = new Map<string, Uint8Array>();
  const cache = new Map<string, { hash: string; body: Uint8Array }>();
  const versions: VersionEntry[] = layout.map((specs, i) => ({
    id: `v${i + 1}`,
    blocks: specs.map((spec) => {
      const key = `${spec.seed}:${spec.length}`;
      let entry = cache.get(key);
      if (entry === undefined) {
        const body = makeBytes(spec.seed, spec.length);
        entry = { hash: sha256hex(body), body };
        cache.set(key, entry);
      }
      if (!bodies.has(entry.hash)) bodies.set(entry.hash, entry.body);
      return { hash: entry.hash, length: spec.length };
    }),
  }));
  return { versions, bodies };
}

export async function makeRepoDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "repair-repo-"));
}

export async function removeRepoDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/** 按清单从仓库块文件重组一个版本的完整字节。 */
export async function reassemble(
  blockPathOf: (hash: string) => string,
  version: VersionEntry,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (const ref of version.blocks) {
    parts.push(await fs.readFile(blockPathOf(ref.hash)));
  }
  return concat(parts);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** 版本的原始字节（按清单顺序拼接正确正文）。 */
export function originalBytes(fixture: Fixture, version: VersionEntry): Uint8Array {
  return concat(
    version.blocks.map((ref) => {
      const body = fixture.bodies.get(ref.hash);
      if (body === undefined) throw new Error(`fixture 缺少块 ${ref.hash}`);
      return body;
    }),
  );
}

/** 把字节切成逐段到达的异步块流。 */
export async function* chunkStream(
  data: Uint8Array,
  chunkSize: number,
): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    yield data.subarray(offset, Math.min(offset + chunkSize, data.length));
  }
}

/** 模拟“只写了一部分就进程终止”的补传流。 */
export async function* brokenStream(
  data: Uint8Array,
  bytesBeforeCrash: number,
): AsyncIterable<Uint8Array> {
  let sent = 0;
  for await (const chunk of chunkStream(data, 256 * 1024)) {
    if (sent + chunk.length > bytesBeforeCrash) {
      yield chunk.subarray(0, bytesBeforeCrash - sent);
      throw new Error("模拟进程终止：补传流中断");
    }
    yield chunk;
    sent += chunk.length;
  }
}

export const FULL_BLOCK = BLOCK_SIZE;
