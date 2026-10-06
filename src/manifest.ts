import { BLOCK_SIZE, type Manifest } from './types';

const HASH_RE = /^[0-9a-f]{64}$/;

/** 单个哈希在清单中的汇总信息。 */
export interface HashEntry {
  hash: string;
  length: number;
  /** 引用该哈希的版本标识（已去重、排序）。 */
  versions: string[];
}

/** 清单索引：按哈希聚合所有版本引用。 */
export interface ManifestIndex {
  manifest: Manifest;
  byHash: Map<string, HashEntry>;
  /** 版本标识 -> 该版本引用的哈希集合（已去重）。 */
  hashesByVersion: Map<string, Set<string>>;
}

function fail(message: string): never {
  throw new Error(`invalid manifest: ${message}`);
}

/**
 * 从清单构建索引，并校验清单合法性：
 * 哈希为 64 位小写 hex；长度为正且不超过 4 MiB；
 * 同一哈希在所有引用处的长度一致；版本标识不重复。
 */
export function buildManifestIndex(manifest: Manifest): ManifestIndex {
  if (!manifest || !Array.isArray(manifest.versions)) fail('versions must be an array');
  const byHash = new Map<string, HashEntry>();
  const hashesByVersion = new Map<string, Set<string>>();

  for (const version of manifest.versions) {
    if (!version || typeof version.id !== 'string' || version.id.length === 0) {
      fail('every version needs a non-empty string id');
    }
    if (hashesByVersion.has(version.id)) fail(`duplicate version id ${version.id}`);
    const versionHashes = new Set<string>();
    hashesByVersion.set(version.id, versionHashes);
    if (!Array.isArray(version.files)) fail(`version ${version.id}: files must be an array`);

    for (const file of version.files) {
      if (!file || !Array.isArray(file.blocks)) fail(`version ${version.id}: file blocks must be an array`);
      for (const block of file.blocks) {
        if (!block || typeof block.hash !== 'string' || !HASH_RE.test(block.hash)) {
          fail(`version ${version.id}: bad block hash ${String(block && block.hash)}`);
        }
        if (typeof block.length !== 'number' || !Number.isInteger(block.length) || block.length <= 0 || block.length > BLOCK_SIZE) {
          fail(`version ${version.id}: bad length for block ${block.hash}`);
        }
        versionHashes.add(block.hash);
        const existing = byHash.get(block.hash);
        if (existing) {
          if (existing.length !== block.length) {
            fail(`conflicting lengths for block ${block.hash}`);
          }
          if (!existing.versions.includes(version.id)) existing.versions.push(version.id);
        } else {
          byHash.set(block.hash, { hash: block.hash, length: block.length, versions: [version.id] });
        }
      }
    }
  }

  for (const entry of byHash.values()) entry.versions.sort();
  return { manifest, byHash, hashesByVersion };
}
