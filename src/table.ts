/** A single phrase table entry. Both strings are non-empty valid Unicode. */
export interface Entry {
  readonly source: string;
  readonly target: string;
}

/**
 * Compiled phrase table: an Aho-Corasick automaton over Unicode code points.
 * Internal node structure is exposed only to the translate module.
 */
export interface AutomatonNode {
  /** children keyed by code point */
  readonly children: Map<number, AutomatonNode>;
  /** failure link; root's fail points to itself */
  fail: AutomatonNode;
  /** depth in code points (root = 0) */
  readonly depth: number;
  /** target string if this node is the end of a source phrase */
  target: string | null;
}

export interface CompiledTable {
  readonly root: AutomatonNode;
  /** max source length in code points (L); 0 when the table is empty */
  readonly maxSourceLength: number;
  readonly entryCount: number;
}

function makeNode(depth: number): AutomatonNode {
  return {
    children: new Map(),
    fail: null as unknown as AutomatonNode, // set during link construction
    depth,
    target: null,
  };
}

/**
 * Compile entries into a reusable table.
 * Time and space: O(M) where M = total length of all sources and targets.
 */
export function compile(entries: readonly Entry[]): CompiledTable {
  const root = makeNode(0);
  root.fail = root;

  let maxSourceLength = 0;

  // Build the trie. Total work is proportional to the summed source lengths.
  for (const entry of entries) {
    let node = root;
    let length = 0;
    for (const ch of entry.source) {
      const cp = ch.codePointAt(0)!;
      let next = node.children.get(cp);
      if (next === undefined) {
        next = makeNode(node.depth + 1);
        node.children.set(cp, next);
      }
      node = next;
      length++;
    }
    node.target = entry.target;
    if (length > maxSourceLength) maxSourceLength = length;
  }

  // Build failure links with a BFS from the root.
  // fail(v) = deepest proper suffix of v's string that is a trie node.
  const queue: AutomatonNode[] = [];
  for (const child of root.children.values()) {
    child.fail = root;
    queue.push(child);
  }
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const [cp, child] of node.children) {
      // Walk failure links until we find a state that can consume cp.
      let fallback = node.fail;
      while (fallback !== root && !fallback.children.has(cp)) {
        fallback = fallback.fail;
      }
      const candidate = fallback.children.get(cp);
      // Do not let a root child point to itself.
      child.fail = candidate !== undefined && candidate !== child ? candidate : root;
      queue.push(child);
    }
  }

  return { root, maxSourceLength, entryCount: entries.length };
}
