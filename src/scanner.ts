import { lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { compareUtf8, joinPath, splitComponents } from "./pathUtils";
import type { ManifestEntry, ScanManifest, ScanPlan } from "./types";
import { WhitelistTrie } from "./whitelistTrie";

const MAX_ROOTS = 20;
const MAX_WHITELIST_ENTRIES = 200;
const MAX_LINK_HOPS = 64;

/**
 * A traversal state: one underlying directory entity reached under one
 * whitelist-trie node, together with the Pareto frontier of its best
 * access paths (all with the minimal component count).
 */
interface DirState {
  readonly dirKey: string;
  readonly trieNodeId: number;
  readonly depth: number;
  /** Symlink-free location used for file system operations. */
  readonly realPath: string;
  /** Pareto-optimal access paths, deduplicated by the dominance rule. */
  readonly paths: string[];
}

interface FileCandidate {
  path: string;
  dev: bigint;
  ino: bigint;
  depth: number;
}

/**
 * True when `a` dominates `b`: for every possible suffix sigma,
 * a + sigma compares <= b + sigma in UTF-8 byte order.
 *
 * If neither path is a byte-prefix of the other, their comparison is
 * decided before any suffix. If `a` is a proper prefix of `b`, the
 * comparison after appending a suffix is decided by the byte right
 * after `a` inside `b` versus the '/' that `a`'s suffix would add.
 */
function dominates(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  if (compareUtf8(a, b) > 0) {
    return false;
  }
  if (a.length < b.length && b.startsWith(a)) {
    return b.charCodeAt(a.length) > 0x2f; // '/'
  }
  return true;
}

/** Inserts `path` into a Pareto frontier, dropping dominated entries. */
function addToFrontier(frontier: string[], path: string): void {
  for (const existing of frontier) {
    if (dominates(existing, path)) {
      return;
    }
  }
  let kept = 0;
  for (const existing of frontier) {
    if (!dominates(path, existing)) {
      frontier[kept] = existing;
      kept += 1;
    }
  }
  frontier.length = kept;
  frontier.push(path);
}

function entityKey(dev: bigint, ino: bigint): string {
  return dev.toString(36) + ":" + ino.toString(36);
}

function stateKey(trieNodeId: number, dirKey: string): string {
  return trieNodeId + "|" + dirKey;
}

function componentDepth(absolutePath: string): number {
  return splitComponents(absolutePath).length;
}

interface EntityStat {
  readonly dev: bigint;
  readonly ino: bigint;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

function tryLstat(path: string): EntityStat | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch {
    return null;
  }
}

/**
 * Resolves a symlink chain hop by hop, returning a symlink-free absolute
 * path and its stat, or null when the chain is dangling, unresolvable,
 * or loops. Hop-by-hop resolution avoids the kernel's per-lookup
 * symlink limit (ELOOP) on long accumulated access paths.
 */
function resolveLinkChain(start: string): { path: string; stat: EntityStat } | null {
  let current = start;
  for (let hop = 0; hop < MAX_LINK_HOPS; hop += 1) {
    const stat = tryLstat(current);
    if (stat === null) {
      return null;
    }
    if (!stat.isSymbolicLink()) {
      return { path: current, stat };
    }
    let target: string;
    try {
      target = readlinkSync(current);
    } catch {
      return null;
    }
    current = resolve(dirname(current), target);
  }
  return null;
}

/**
 * Plans a scan: walks the file system from the given roots, applies the
 * whitelist to access paths, deduplicates underlying file entities, and
 * returns the in-memory manifest. Does not read file contents.
 *
 * Traversal is a level-order search over (directory entity, whitelist
 * trie node) states, so link cycles and exponentially many converging
 * access routes are collapsed: work is proportional to the number of
 * distinct states, not to the number of access routes.
 */
export function planScan(plan: ScanPlan): ScanManifest {
  if (plan.roots.length > MAX_ROOTS) {
    throw new RangeError(`too many scan roots: ${plan.roots.length} > ${MAX_ROOTS}`);
  }
  if (plan.whitelist.length > MAX_WHITELIST_ENTRIES) {
    throw new RangeError(
      `too many whitelist entries: ${plan.whitelist.length} > ${MAX_WHITELIST_ENTRIES}`,
    );
  }

  const trie = new WhitelistTrie(plan.whitelist);
  const dirCache = new Map<string, readonly string[]>();
  const queuedStates = new Set<string>();
  const files = new Map<string, FileCandidate>();
  const pending = new Map<number, Map<string, DirState>>();

  const offerDirectory = (
    trieNodeId: number,
    dirKey: string,
    depth: number,
    realPath: string,
    path: string,
  ): void => {
    const key = stateKey(trieNodeId, dirKey);
    if (queuedStates.has(key)) {
      return;
    }
    let bucket = pending.get(depth);
    if (bucket === undefined) {
      bucket = new Map();
      pending.set(depth, bucket);
    }
    const existing = bucket.get(key);
    if (existing !== undefined) {
      addToFrontier(existing.paths, path);
      return;
    }
    bucket.set(key, { dirKey, trieNodeId, depth, realPath, paths: [path] });
  };

  const offerFile = (
    dev: bigint,
    ino: bigint,
    depth: number,
    path: string,
  ): void => {
    const key = entityKey(dev, ino);
    const existing = files.get(key);
    if (existing !== undefined) {
      if (depth < existing.depth) {
        existing.depth = depth;
        existing.path = path;
      } else if (depth === existing.depth && compareUtf8(path, existing.path) < 0) {
        existing.path = path;
      }
      return;
    }
    files.set(key, { path, dev, ino, depth });
  };

  const readDirNames = (dirKey: string, realPath: string): readonly string[] => {
    const cached = dirCache.get(dirKey);
    if (cached !== undefined) {
      return cached;
    }
    const names: readonly string[] = readdirSync(realPath);
    dirCache.set(dirKey, names);
    return names;
  };

  // Seed the scan roots. Roots may sit at different depths; pending
  // buckets are always drained in ascending depth order, which yields a
  // level-order (min-component-count-first) traversal.
  for (const root of plan.roots) {
    const resolved = trie.resolve(root);
    if (resolved.excluded) {
      continue;
    }
    const realPath = realpathSync(root);
    const stat = tryLstat(realPath);
    if (stat === null) {
      continue;
    }
    const depth = componentDepth(root);
    if (stat.isDirectory()) {
      offerDirectory(resolved.nodeId, entityKey(stat.dev, stat.ino), depth, realPath, root);
    } else if (stat.isFile()) {
      offerFile(stat.dev, stat.ino, depth, root);
    }
  }

  while (pending.size > 0) {
    let depth = -1;
    for (const candidate of pending.keys()) {
      if (depth === -1 || candidate < depth) {
        depth = candidate;
      }
    }
    const bucket = pending.get(depth)!;
    pending.delete(depth);
    for (const state of bucket.values()) {
      const key = stateKey(state.trieNodeId, state.dirKey);
      if (queuedStates.has(key)) {
        continue;
      }
      queuedStates.add(key);
      const names = readDirNames(state.dirKey, state.realPath);
      for (const name of names) {
        const next = trie.descend(state.trieNodeId, name);
        if (next.excluded) {
          continue;
        }
        const entry = resolveLinkChain(join(state.realPath, name));
        if (entry === null) {
          continue; // dangling or looping symlink
        }
        if (entry.stat.isFile()) {
          for (const prefix of state.paths) {
            offerFile(entry.stat.dev, entry.stat.ino, depth + 1, joinPath(prefix, name));
          }
        } else if (entry.stat.isDirectory()) {
          const dirKey = entityKey(entry.stat.dev, entry.stat.ino);
          for (const prefix of state.paths) {
            offerDirectory(
              next.nodeId,
              dirKey,
              depth + 1,
              entry.path,
              joinPath(prefix, name),
            );
          }
        }
      }
    }
  }

  const entries: ManifestEntry[] = [...files.values()].map((candidate) => ({
    path: candidate.path,
    dev: candidate.dev,
    ino: candidate.ino,
  }));
  entries.sort((a, b) => compareUtf8(a.path, b.path));
  return { files: entries };
}
