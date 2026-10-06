import { splitComponents } from "./pathUtils";

interface TrieNode {
  readonly children: Map<string, number>;
  /** True when a whitelist entry ends exactly at this node. */
  terminal: boolean;
}

/**
 * Trie over whitelist path components. Used to decide, for a candidate
 * access path built component by component, whether it is excluded
 * (identical to a whitelist entry or a descendant of one).
 *
 * Matching is purely on access-path components; once a path diverges
 * from every whitelist entry (DEAD_ID), no descendant can be excluded.
 */
export class WhitelistTrie {
  /** Id of the root node (empty path "/"). */
  static readonly ROOT_ID = 0;

  /** Id of the "dead" node: no whitelist entry can match here or below. */
  static readonly DEAD_ID = -1;

  private readonly nodes: TrieNode[] = [{ children: new Map(), terminal: false }];

  constructor(whitelistPaths: readonly string[]) {
    for (const path of whitelistPaths) {
      let nodeId = WhitelistTrie.ROOT_ID;
      for (const component of splitComponents(path)) {
        const node = this.nodes[nodeId]!;
        let next = node.children.get(component);
        if (next === undefined) {
          next = this.nodes.length;
          this.nodes.push({ children: new Map(), terminal: false });
          node.children.set(component, next);
        }
        nodeId = next;
      }
      this.nodes[nodeId]!.terminal = true;
    }
  }

  /**
   * Returns the node reached by appending one component, or DEAD_ID.
   * `excluded` is true when the resulting path is identical to a
   * whitelist entry (its whole subtree is then excluded as well).
   */
  descend(nodeId: number, component: string): { nodeId: number; excluded: boolean } {
    if (nodeId === WhitelistTrie.DEAD_ID) {
      return { nodeId: WhitelistTrie.DEAD_ID, excluded: false };
    }
    const next = this.nodes[nodeId]!.children.get(component);
    if (next === undefined) {
      return { nodeId: WhitelistTrie.DEAD_ID, excluded: false };
    }
    return { nodeId: next, excluded: this.nodes[next]!.terminal };
  }

  /**
   * Resolves the trie node for an existing absolute path (e.g. a scan
   * root). `excluded` is true when the path itself is a whitelist entry
   * or sits below one.
   */
  resolve(absolutePath: string): { nodeId: number; excluded: boolean } {
    let nodeId = WhitelistTrie.ROOT_ID;
    if (this.nodes[nodeId]!.terminal) {
      return { nodeId, excluded: true };
    }
    for (const component of splitComponents(absolutePath)) {
      const next = this.nodes[nodeId]!.children.get(component);
      if (next === undefined) {
        return { nodeId: WhitelistTrie.DEAD_ID, excluded: false };
      }
      nodeId = next;
      if (this.nodes[nodeId]!.terminal) {
        return { nodeId, excluded: true };
      }
    }
    return { nodeId, excluded: false };
  }
}
