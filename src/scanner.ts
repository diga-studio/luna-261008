import { readdirSync } from "node:fs";
import {
  canonicalOf,
  entityOfPath,
  entryInfo,
  type EntityInfo,
} from "./fsresolve.js";
import { MinHeap } from "./heap.js";
import {
  compareCodePoints,
  compareRepresentative,
  compareTraversal,
  pathChild,
  pathFromString,
  pathToString,
  type PathNode,
} from "./pathNode.js";
import {
  buildWhitelistTrie,
  classifyPath,
  walkTrie,
  type TrieNode,
} from "./whitelistTrie.js";
import type { ScanManifest, ScanPlan, ScanRecord } from "./types.js";

const MAX_ROOTS = 20;
const MAX_WHITELIST = 200;

interface EntInfo {
  name: string;
  kind: EntityInfo["kind"];
  dev: number;
  ino: number;
}

interface QueueItem {
  key: string;
  path: PathNode;
  dev: number;
  ino: number;
}

function entityKey(dev: number, ino: number): string {
  return `${dev}:${ino}`;
}

function dirStateKey(dev: number, ino: number): string {
  return `d:${dev}:${ino}`;
}

function trieStateKey(id: number): string {
  return `t:${id}`;
}

/**
 * Traverse the local filesystem according to the plan and build the
 * in-memory scan manifest. Does not inspect file contents.
 *
 * Traversal runs a Dijkstra-style relaxation over directory *entities*
 * (dev+ino), not access paths, so exponentially many converging access
 * routes and link cycles cost the same as the underlying directory graph.
 * Whitelist handling is exact on access paths: a separate family of states
 * tracks paths that are proper prefixes of whitelist entries (at most one
 * path per trie node), while every other state is whitelist-clear and stays
 * so under extension.
 */
export function planScan(plan: ScanPlan): ScanManifest {
  if (plan.roots.length > MAX_ROOTS) {
    throw new RangeError(`at most ${MAX_ROOTS} scan roots allowed`);
  }
  if (plan.whitelist.length > MAX_WHITELIST) {
    throw new RangeError(`at most ${MAX_WHITELIST} whitelist paths allowed`);
  }

  const trie = buildWhitelistTrie(plan.whitelist);
  const trieNodes = new Map<number, TrieNode>();
  const collectTrieNodes = (node: TrieNode): void => {
    trieNodes.set(node.id, node);
    for (const child of node.children.values()) collectTrieNodes(child);
  };
  collectTrieNodes(trie.root);

  const best = new Map<string, PathNode>();
  const heap = new MinHeap<QueueItem>((a, b) => compareTraversal(a.path, b.path));
  const dirCache = new Map<string, EntInfo[]>();
  const files = new Map<string, { path: PathNode; dev: number; ino: number }>();

  const relax = (key: string, path: PathNode, dev: number, ino: number): void => {
    const current = best.get(key);
    if (current !== undefined && compareTraversal(current, path) <= 0) return;
    best.set(key, path);
    heap.push({ key, path, dev, ino });
  };

  const recordFile = (path: PathNode, dev: number, ino: number): void => {
    const key = entityKey(dev, ino);
    const current = files.get(key);
    if (current !== undefined && compareRepresentative(current.path, path) <= 0) return;
    files.set(key, { path, dev, ino });
  };

  const canonicalByEntity = new Map<string, string | null>();

  const canonicalFor = (dev: number, ino: number, path: PathNode): string | null => {
    const key = entityKey(dev, ino);
    const cached = canonicalByEntity.get(key);
    if (cached !== undefined) return cached;
    const canonical = canonicalOf(pathToString(path));
    canonicalByEntity.set(key, canonical);
    return canonical;
  };

  const entriesOf = (dev: number, ino: number, path: PathNode): EntInfo[] => {
    const key = entityKey(dev, ino);
    const cached = dirCache.get(key);
    if (cached !== undefined) return cached;
    const result: EntInfo[] = [];
    const canonical = canonicalFor(dev, ino, path);
    if (canonical !== null) {
      let names: string[] = [];
      try {
        names = readdirSync(canonical);
      } catch {
        names = [];
      }
      for (const name of names) {
        const info = entryInfo(canonical, name);
        if (info === null) continue;
        result.push({ name, kind: info.kind, dev: info.dev, ino: info.ino });
      }
    }
    dirCache.set(key, result);
    return result;
  };

  // Seed the traversal with the scan roots.
  for (const root of plan.roots) {
    const classification = classifyPath(trie, root);
    if (classification === "excluded") continue;
    const rootPath = pathFromString(root);
    const info = entityOfPath(pathToString(rootPath));
    if (info === null) continue;
    if (info.kind === "file") {
      recordFile(rootPath, info.dev, info.ino);
      continue;
    }
    if (info.kind !== "dir") continue;
    if (classification === "prefix") {
      const node = walkTrie(trie, root);
      if (node !== null) relax(trieStateKey(node.id), rootPath, info.dev, info.ino);
    } else {
      relax(dirStateKey(info.dev, info.ino), rootPath, info.dev, info.ino);
    }
  }

  // Relax states in traversal order until no improvement remains.
  for (;;) {
    const item = heap.pop();
    if (item === undefined) break;
    if (best.get(item.key) !== item.path) continue; // stale entry

    if (item.key.startsWith("t:")) {
      const trieNode = trieNodes.get(Number(item.key.slice(2)))!;
      for (const ent of entriesOf(item.dev, item.ino, item.path)) {
        const childPath = pathChild(item.path, ent.name);
        const trieChild = trieNode.children.get(ent.name);
        if (trieChild !== undefined) {
          if (trieChild.terminal) continue; // exact whitelist match: illegal
          if (ent.kind === "file") {
            // A proper whitelist prefix is a legal path; record the file.
            recordFile(childPath, ent.dev, ent.ino);
          } else if (ent.kind === "dir") {
            relax(trieStateKey(trieChild.id), childPath, ent.dev, ent.ino);
          }
        } else if (ent.kind === "file") {
          recordFile(childPath, ent.dev, ent.ino);
        } else if (ent.kind === "dir") {
          relax(dirStateKey(ent.dev, ent.ino), childPath, ent.dev, ent.ino);
        }
      }
    } else {
      // Whitelist-clear directory state: every extension stays legal.
      for (const ent of entriesOf(item.dev, item.ino, item.path)) {
        const childPath = pathChild(item.path, ent.name);
        if (ent.kind === "file") {
          recordFile(childPath, ent.dev, ent.ino);
        } else if (ent.kind === "dir") {
          relax(dirStateKey(ent.dev, ent.ino), childPath, ent.dev, ent.ino);
        }
      }
    }
  }

  const records: ScanRecord[] = [];
  for (const { path, dev, ino } of files.values()) {
    records.push({ path: pathToString(path), dev, ino });
  }
  records.sort((a, b) => compareCodePoints(a.path, b.path));
  return { files: records };
}
