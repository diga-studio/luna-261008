/** A single phrase table entry. Both strings are non-empty valid Unicode. */
export interface PhraseEntry {
  readonly source: string;
  readonly target: string;
}

/**
 * Compiled, immutable phrase table. Produced by `compile`, reusable across
 * any number of `translate` calls.
 */
export interface PhraseTable {
  /** Longest source length in code points (0 when the table is empty). */
  readonly maxSourceLength: number;
  /** Number of entries. */
  readonly size: number;
  /** Internal automaton state. */
  readonly automaton: Automaton;
}

/**
 * Aho-Corasick automaton built over the *reversed* source strings,
 * indexed by Unicode code points.
 */
export interface Automaton {
  /** Transition map: key = fromNode * 2^21 + codePoint, value = toNode. */
  readonly transitions: Map<number, number>;
  /** failure[node] = failure-link target node. */
  readonly failure: Int32Array;
  /**
   * dictLink[node] = nearest terminal node reachable via failure links
   * (including node itself), or -1. Following it yields the longest
   * pattern that is a suffix of the scanned text.
   */
  readonly dictLink: Int32Array;
  /** termLength[node] = pattern length in code points if terminal, else 0. */
  readonly termLength: Int32Array;
  /** termEntry[node] = entry index if terminal, else -1. */
  readonly termEntry: Int32Array;
  /** Number of automaton nodes (node 0 is the root). */
  readonly nodeCount: number;
  /** Target strings, indexed by entry index. */
  readonly targets: readonly string[];
}
