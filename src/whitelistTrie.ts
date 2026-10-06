/** Prefix trie over whitelist path components. */
export interface TrieNode {
  readonly id: number;
  readonly children: Map<string, TrieNode>;
  /** True when a whitelist path ends exactly at this node. */
  terminal: boolean;
}

export interface WhitelistTrie {
  readonly root: TrieNode;
}

function splitComponents(path: string): string[] {
  return path.split("/").filter((p) => p.length > 0);
}

export function buildWhitelistTrie(paths: string[]): WhitelistTrie {
  let nextId = 1;
  const root: TrieNode = { id: 0, children: new Map(), terminal: false };
  for (const path of paths) {
    let node = root;
    for (const part of splitComponents(path)) {
      let child = node.children.get(part);
      if (child === undefined) {
        child = { id: nextId++, children: new Map(), terminal: false };
        node.children.set(part, child);
      }
      node = child;
    }
    node.terminal = true;
  }
  return { root };
}

/**
 * Classify an absolute path against the trie.
 * - "excluded": the path equals or descends from a whitelist entry.
 * - "prefix": the path is a proper prefix of some whitelist entry.
 * - "clear": unrelated to every whitelist entry.
 */
export function classifyPath(
  trie: WhitelistTrie,
  path: string,
): "excluded" | "prefix" | "clear" {
  let node = trie.root;
  if (node.terminal) return "excluded";
  for (const part of splitComponents(path)) {
    const child = node.children.get(part);
    if (child === undefined) return "clear";
    node = child;
    if (node.terminal) return "excluded";
  }
  return node.children.size > 0 ? "prefix" : "clear";
}

/**
 * Locate the trie node reached by walking the given absolute path, or null
 * when some component is absent from the trie. Does not consider terminals.
 */
export function walkTrie(trie: WhitelistTrie, path: string): TrieNode | null {
  let node = trie.root;
  for (const part of splitComponents(path)) {
    const child = node.children.get(part);
    if (child === undefined) return null;
    node = child;
  }
  return node;
}
