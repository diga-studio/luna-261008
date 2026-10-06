import type { ConfigNode, Path, PathSegment, RawDiff, Severity } from './types.js';

const MISSING = Symbol('missing');
type ResolveResult = ConfigNode | typeof MISSING;

/** Lazily built key -> value indexes for object nodes, shared across resolves. */
const objectIndexes = new WeakMap<
  Extract<ConfigNode, { type: 'object' }>,
  Map<string, ConfigNode>
>();

function objectLookup(
  node: Extract<ConfigNode, { type: 'object' }>,
  key: string,
): ConfigNode | undefined {
  let index = objectIndexes.get(node);
  if (!index) {
    index = new Map<string, ConfigNode>();
    for (const [k, v] of node.entries) index.set(k, v);
    objectIndexes.set(node, index);
  }
  return index.get(key);
}

/** Resolves a registry path; MISSING when any segment cannot be reached. */
function resolvePath(root: ConfigNode, path: Path): ResolveResult {
  let node = root;
  for (const seg of path) {
    if (typeof seg === 'string') {
      if (node.type !== 'object') return MISSING;
      const next = objectLookup(node, seg);
      if (next === undefined) return MISSING;
      node = next;
    } else {
      if (node.type !== 'array') return MISSING;
      if (!Number.isInteger(seg) || seg < 0 || seg >= node.items.length) return MISSING;
      node = node.items[seg];
    }
  }
  return node;
}

interface TrieNode {
  children: Map<PathSegment, TrieNode>;
  /** Some diff path ends exactly here. */
  terminal: boolean;
}

function newTrieNode(): TrieNode {
  return { children: new Map(), terminal: false };
}

/** Returns true when some diff path equals or descends from `path`. */
function trieHasAtOrBelow(root: TrieNode, path: Path): boolean {
  let node = root;
  for (const seg of path) {
    const next = node.children.get(seg);
    if (!next) return false;
    node = next;
  }
  return true;
}

interface RegNode {
  children: Map<PathSegment, RegNode>;
  /** A changed registered path ends exactly here. */
  changedHere: boolean;
  /** A changed registered path ends strictly below here. */
  changedBelow: boolean;
}

function newRegNode(): RegNode {
  return { children: new Map(), changedHere: false, changedBelow: false };
}

/**
 * Assigns severities to raw diffs given the critical-field registry.
 * A diff is Critical when it has an ancestor/descendant/equal relation with
 * a registered path whose value actually changed (missing on both sides does
 * not count as a change); other modified diffs are Medium, and added/removed
 * diffs are Low.
 */
export function classifyDiffs(
  diffs: readonly RawDiff[],
  baseline: ConfigNode,
  current: ConfigNode,
  registry: readonly Path[],
): Severity[] {
  // Index diff paths so "value at P changed" can be decided without
  // re-comparing subtrees: when P resolves on both sides, its subtree
  // differs iff some diff path equals or descends from P.
  const diffTrie = newTrieNode();
  for (const diff of diffs) {
    let node = diffTrie;
    for (const seg of diff.path) {
      let next = node.children.get(seg);
      if (!next) {
        next = newTrieNode();
        node.children.set(seg, next);
      }
      node = next;
    }
    node.terminal = true;
  }

  // Decide for each registered path whether its value actually changed.
  const regRoot = newRegNode();
  for (const path of registry) {
    const before = resolvePath(baseline, path);
    const after = resolvePath(current, path);
    let changed: boolean;
    if (before === MISSING && after === MISSING) {
      changed = false;
    } else if (before === MISSING || after === MISSING) {
      changed = true;
    } else {
      changed = trieHasAtOrBelow(diffTrie, path);
    }
    if (!changed) continue;
    const ancestors: RegNode[] = [];
    let node = regRoot;
    for (const seg of path) {
      ancestors.push(node);
      let next = node.children.get(seg);
      if (!next) {
        next = newRegNode();
        node.children.set(seg, next);
      }
      node = next;
    }
    node.changedHere = true;
    for (const ancestor of ancestors) ancestor.changedBelow = true;
  }

  // Classify: a diff is Critical iff some changed registered path is an
  // ancestor (prefix met along the walk) or a descendant (below the endpoint)
  // of the diff path, or equal to it.
  return diffs.map((diff) => {
    let node: RegNode | undefined = regRoot;
    let critical = regRoot.changedHere;
    for (const seg of diff.path) {
      if (critical || node === undefined) break;
      node = node.children.get(seg);
      if (node !== undefined && node.changedHere) critical = true;
    }
    if (!critical && node !== undefined && node.changedBelow) critical = true;
    if (critical) return 'critical';
    return diff.kind === 'modified' ? 'medium' : 'low';
  });
}
