import type { AutomatonNode, CompiledTable } from "./table";

/**
 * Streaming translation: consumes an async UTF-8 byte stream and yields an
 * async UTF-8 byte stream. Chunk boundaries may split multi-byte characters.
 *
 * Output is byte-identical to running left-to-right longest-match over the
 * whole input, and determined output is emitted without waiting for EOF.
 *
 * Algorithm: an Aho-Corasick automaton scans the input once (amortized O(1)
 * per code point). A second "walk" pointer tracks the trie node for the
 * uncommitted suffix starting at commitPos; it is exactly the node of
 * depth == bufferedLength on the failure chain of the automaton state, so it
 * is maintained incrementally: child edges while it stays alive, failure
 * links when it must be relocated after a commit. The deepest terminal node
 * seen on the walk is the longest source starting at commitPos. A match is
 * committed as soon as it can no longer be extended (walk died, buffered
 * length reached L, or EOF); a position with no live trie prefix is emitted
 * verbatim. Failure-link steps during relocation are charged to the code
 * points consumed by the corresponding commit, keeping the total O(N).
 * Uncommitted input never exceeds L code points plus the current chunk.
 */
export async function* translate(
  table: CompiledTable,
  chunks: AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const { root } = table;
  const L = table.maxSourceLength;

  const decoder = new TextDecoder("utf-8");
  const encoder = new TextEncoder();

  // Automaton state after the last consumed code point (with failure links).
  let state: AutomatonNode = root;
  // Trie node for input[commitPos..p]; null when that string is not a trie
  // prefix (the walk "died"), meaning no source starts at commitPos and
  // extends past the current position.
  let walk: AutomatonNode | null = root;
  // Longest source starting at commitPos seen so far (0 = none).
  let candLen = 0;
  let candTarget: string | null = null;

  // Uncommitted code points: buf[head .. buf.length).
  let buf: number[] = [];
  let head = 0;

  let outParts: string[] = [];

  // Follow failure links from `node` to the unique chain node of depth
  // `remaining`, i.e. the trie node for the suffix of that length; null if
  // no such suffix is a trie prefix.
  const suffixNode = (node: AutomatonNode, remaining: number): AutomatonNode | null => {
    let cur: AutomatonNode = node;
    while (cur.depth > remaining) cur = cur.fail;
    return cur.depth === remaining ? cur : null;
  };

  const commitReady = (flushing: boolean): void => {
    for (;;) {
      const buffered = buf.length - head;
      if (buffered === 0) break;

      let advance: number;
      let piece: string;
      if (candLen > 0 && (flushing || walk === null || buffered >= L)) {
        advance = candLen;
        piece = candTarget!;
      } else if (candLen === 0 && (flushing || walk === null || buffered >= L)) {
        advance = 1;
        piece = String.fromCodePoint(buf[head]);
      } else {
        break;
      }

      outParts.push(piece);
      head += advance;
      candLen = 0;
      candTarget = null;

      // Relocate the walk to the new commitPos.
      const remaining = buf.length - head;
      if (remaining <= 0) {
        walk = root;
      } else if (walk !== null) {
        // The walk's string is a trie prefix; the new walk must represent
        // its suffix of length `remaining`, found on its failure chain.
        walk = suffixNode(walk, remaining);
      } else if (state.depth >= remaining) {
        // Revive from the automaton state, whose failure chain lists every
        // suffix of the scanned input that is a trie prefix.
        walk = suffixNode(state, remaining);
      } else {
        walk = null;
      }

      if (walk !== null && walk.target !== null) {
        candLen = walk.depth;
        candTarget = walk.target;
      }
    }
  };

  const feed = (text: string): void => {
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      buf.push(cp);

      // Aho-Corasick transition (amortized O(1)).
      let next = state.children.get(cp);
      while (next === undefined && state !== root) {
        state = state.fail;
        next = state.children.get(cp);
      }
      state = next !== undefined ? next : root;

      // Extend the walk from commitPos, if still alive.
      if (walk !== null) {
        walk = walk.children.get(cp) ?? null;
        if (walk !== null && walk.target !== null) {
          candLen = walk.depth;
          candTarget = walk.target;
        }
      }

      commitReady(false);
    }
  };

  for await (const chunk of chunks) {
    feed(decoder.decode(chunk, { stream: true }));
    if (head > 0) {
      // Compact the buffer; it never holds more than L code points anyway.
      buf = buf.slice(head);
      head = 0;
    }
    if (outParts.length > 0) {
      yield encoder.encode(outParts.join(""));
      outParts = [];
    }
  }

  feed(decoder.decode());
  commitReady(true);
  if (outParts.length > 0) {
    yield encoder.encode(outParts.join(""));
  }
}
