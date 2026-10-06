import type { Automaton, PhraseEntry } from "./types.ts";

/** Code points fit in 21 bits; transition key = node * 2^21 + codePoint. */
const CP_BITS = 0x200000;

function transitionKey(node: number, codePoint: number): number {
  return node * CP_BITS + codePoint;
}

/**
 * Builds the reversed-pattern Aho-Corasick automaton.
 *
 * Patterns are reversed before insertion, so that scanning the (reversed)
 * input right-to-left reports, at each position, the longest source that
 * starts there. Time and space are O(M) where M is the total source length
 * in code points: the trie has at most M + 1 nodes, and failure-link
 * computation is linear by the standard depth argument.
 */
export function buildAutomaton(entries: readonly PhraseEntry[]): Automaton {
  const transitions = new Map<number, number>();
  // Per-node child lists, needed only during construction.
  const children: Array<Array<[number, number]>> = [[]];
  const failure: number[] = [0];
  const termLength: number[] = [0];
  const termEntry: number[] = [-1];

  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    const source = entries[entryIndex]!.source;
    const codePoints: number[] = [];
    for (const ch of source) codePoints.push(ch.codePointAt(0)!);
    let node = 0;
    for (let i = codePoints.length - 1; i >= 0; i--) {
      const cp = codePoints[i]!;
      const key = transitionKey(node, cp);
      let next = transitions.get(key);
      if (next === undefined) {
        next = children.length;
        transitions.set(key, next);
        children[node]!.push([cp, next]);
        children.push([]);
        failure.push(0);
        termLength.push(0);
        termEntry.push(-1);
      }
      node = next;
    }
    termLength[node] = codePoints.length;
    termEntry[node] = entryIndex;
  }

  // BFS to compute failure links and dictionary (nearest-terminal) links.
  const nodeCount = children.length;
  const dictLink = new Int32Array(nodeCount).fill(-1);
  const queue: number[] = [];
  for (const [, child] of children[0]!) {
    failure[child] = 0;
    dictLink[child] = termEntry[child]! >= 0 ? child : -1;
    queue.push(child);
  }
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head]!;
    for (const [cp, u] of children[v]!) {
      queue.push(u);
      let f = failure[v]!;
      while (f !== 0 && !transitions.has(transitionKey(f, cp))) {
        f = failure[f]!;
      }
      const target = transitions.get(transitionKey(f, cp));
      failure[u] = target === undefined ? 0 : target;
      dictLink[u] = termEntry[u]! >= 0 ? u : dictLink[failure[u]!]!;
    }
  }

  const targets: string[] = [];
  for (const entry of entries) targets.push(entry.target);

  return {
    transitions,
    failure: Int32Array.from(failure),
    dictLink,
    termLength: Int32Array.from(termLength),
    termEntry: Int32Array.from(termEntry),
    nodeCount,
    targets,
  };
}
