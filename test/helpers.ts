import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Manifest } from '../src/index.js';

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 确定性伪随机数据：同样 seed 同样长度得到同样字节。 */
export function makeData(seed: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  let counter = 0;
  while (offset < length) {
    const block = createHash('sha256').update(`${seed}:${counter}`).digest();
    const n = Math.min(block.length, length - offset);
    out.set(block.subarray(0, n), offset);
    offset += n;
    counter += 1;
  }
  return out;
}

export interface TestBlock {
  hash: string;
  data: Uint8Array;
}

export function makeBlock(seed: string, length: number): TestBlock {
  const data = makeData(seed, length);
  return { hash: sha256Hex(data), data };
}

/** 创建临时仓库目录。 */
export async function makeRepoDir(prefix = 'backup-repair-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeRepoDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/** 按清单顺序从仓库 blocks 目录重组某个版本的全部字节。 */
export async function reassembleVersion(
  repoDir: string,
  manifest: Manifest,
  versionId: string,
): Promise<Uint8Array> {
  const version = manifest.versions.find((v) => v.id === versionId);
  if (!version) throw new Error(`no such version ${versionId}`);
  const parts: Uint8Array[] = [];
  for (const file of version.files) {
    for (const ref of file.blocks) {
      const data = await fs.readFile(path.join(repoDir, 'blocks', ref.hash));
      if (data.length !== ref.length) throw new Error(`bad length for ${ref.hash}`);
      parts.push(data);
    }
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** 把若干 Uint8Array 拼成一个。 */
export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** 把字节切成若干段，模拟逐段到达的补传数据。 */
export function* chunkEvery(data: Uint8Array, size: number): Generator<Uint8Array> {
  for (let offset = 0; offset < data.length; offset += size) {
    yield data.subarray(offset, Math.min(offset + size, data.length));
  }
}
