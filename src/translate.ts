import { Utf8Decoder } from "./decoder.ts";
import type { Automaton, PhraseTable } from "./types.ts";

const CP_BITS = 0x200000;

/**
 * Translates an asynchronous UTF-8 byte stream, yielding UTF-8 byte chunks.
 *
 * Output, concatenated, is byte-identical to running left-to-right
 * longest-match translation over the whole input text, no matter how the
 * input is chunked. Output is produced incrementally: at most 2L + 4095
 * code points of read input remain uncommitted (L = longest source length),
 * within the required 4L + 4096 bound.
 *
 * Method: the automaton is built over reversed sources. For each window of
 * buffered, not-yet-committed input, a single right-to-left scan computes,
 * for every position p in the first half of the window, the longest source
 * starting at p (a reversed source ending at p in the scan). A greedy
 * forward pass then commits matches and literal code points. Every source
 * has length <= L, so any match starting in the first L code points ends
 * inside the 2L window: decisions made for that half are final.
 *
 * Per position the scan does O(1) amortized work (Aho-Corasick failure
 * links) and records only the single longest match via dictionary links,
 * so a translation pass is O(N + R) with O(L) extra space.
 */
export async function* translate(
  table: PhraseTable,
  chunks: AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const L = table.maxSourceLength;
  if (L === 0) {
    for await (const chunk of chunks) yield chunk;
    return;
  }

  const automaton = table.automaton;
  const decoder = new Utf8Decoder();
  const encoder = new TextEncoder();
  // Uncommitted input code points; length stays below 2L + 4096.
  let buffer: number[] = [];
  // Per-position longest-match scratch, reused across windows.
  const matchLength = new Int32Array(L);
  const matchEntry = new Int32Array(L);

  for await (const chunk of chunks) {
    const codePoints = decoder.push(chunk);
    for (const cp of codePoints) {
      buffer.push(cp);
      // Drain as soon as a full window is available, even if the caller
      // hands us an oversized chunk, so the buffer never exceeds 2L.
      if (buffer.length >= 2 * L) {
        const out = processWindow(automaton, buffer, L, matchLength, matchEntry);
        buffer = buffer.slice(out.committed);
        if (out.text.length > 0) yield encoder.encode(out.text);
      }
    }
  }
  decoder.finish();
  while (buffer.length > 0) {
    const limit = Math.min(L, buffer.length);
    const out = processWindow(automaton, buffer, limit, matchLength, matchEntry);
    buffer = buffer.slice(out.committed);
    if (out.text.length > 0) yield encoder.encode(out.text);
  }
}

interface WindowResult {
  /** Number of leading code points whose translation is final. */
  committed: number;
  /** Their translation. */
  text: string;
}

/**
 * Commits the first `limit` positions of `buffer` (the greedy pass may
 * consume up to L - 1 more to cover a match that starts before `limit`).
 * Requires every source starting below `limit` to end within `buffer`.
 */
function processWindow(
  automaton: Automaton,
  buffer: readonly number[],
  limit: number,
  matchLength: Int32Array,
  matchEntry: Int32Array,
): WindowResult {
  const { transitions, failure, dictLink, termLength, termEntry, targets } =
    automaton;

  // Right-to-left scan: after reading buffer[t..], the automaton state is
  // the longest reversed-source prefix that is a suffix of it; its
  // dictionary link gives the longest source starting at t.
  let state = 0;
  for (let t = buffer.length - 1; t >= 0; t--) {
    const cp = buffer[t]!;
    while (state !== 0 && !transitions.has(state * CP_BITS + cp)) {
      state = failure[state]!;
    }
    state = transitions.get(state * CP_BITS + cp) ?? 0;
    if (t < limit) {
      const terminal = dictLink[state]!;
      if (terminal >= 0) {
        matchLength[t] = termLength[terminal]!;
        matchEntry[t] = termEntry[terminal]!;
      } else {
        matchLength[t] = 0;
        matchEntry[t] = -1;
      }
    }
  }

  // Greedy left-to-right longest match over the committed region.
  const pieces: string[] = [];
  let anchor = 0;
  while (anchor < limit) {
    const length = matchLength[anchor]!;
    if (length > 0) {
      pieces.push(targets[matchEntry[anchor]!]!);
      anchor += length;
    } else {
      pieces.push(String.fromCodePoint(buffer[anchor]!));
      anchor += 1;
    }
  }
  return { committed: anchor, text: pieces.join("") };
}
