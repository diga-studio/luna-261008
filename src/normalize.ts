import type { Span } from "./types";

/**
 * A segment maps a normalized UTF-16 range [nStart, nEnd) back to the
 * original UTF-16 range [oStart, oEnd) of the grapheme cluster(s) it
 * came from. Segments tile the whole normalized text in order.
 */
export interface Segment {
  nStart: number;
  nEnd: number;
  oStart: number;
  oEnd: number;
}

/** Normalized form of one page plus its reverse mapping. */
export interface NormalizedPage {
  text: string;
  segments: Segment[];
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Unicode White_Space property exactly (unlike JS \s, which also matches U+FEFF).
const WHITE_SPACE = /\p{White_Space}/u;

// Soft hyphen is removed after NFKC.
const SOFT_HYPHEN = /\u00AD/g;

/**
 * Normalize one page: NFKC, remove U+00AD soft hyphens, then collapse
 * every run of Unicode White_Space to a single U+0020 (leading and
 * trailing collapsed spaces are kept).
 *
 * Normalization is applied per extended grapheme cluster, which keeps
 * composition, decomposition and canonical reordering identical to a
 * whole-string NFKC while giving a precise reverse mapping: any hit on
 * a cluster's normalized output makes the whole cluster contribute.
 */
export function normalizePage(raw: string): NormalizedPage {
  // Step 1+2: per-cluster NFKC, then drop soft hyphens.
  const pieces: { text: string; oStart: number; oEnd: number }[] = [];
  for (const { segment, index } of graphemeSegmenter.segment(raw)) {
    const cleaned = segment.normalize("NFKC").replace(SOFT_HYPHEN, "");
    if (cleaned.length === 0) continue;
    pieces.push({ text: cleaned, oStart: index, oEnd: index + segment.length });
  }

  // Step 3: collapse White_Space runs, merging the original ranges of
  // every cluster that contributed whitespace to the run.
  let text = "";
  const segments: Segment[] = [];
  let wsStart = -1;
  let wsEnd = -1;
  const flushWhitespace = (): void => {
    if (wsStart < 0) return;
    segments.push({ nStart: text.length, nEnd: text.length + 1, oStart: wsStart, oEnd: wsEnd });
    text += " ";
    wsStart = -1;
  };
  for (const piece of pieces) {
    let i = 0;
    while (i < piece.text.length) {
      if (WHITE_SPACE.test(piece.text[i])) {
        if (wsStart < 0) wsStart = piece.oStart;
        wsEnd = piece.oEnd;
        i += 1;
      } else {
        flushWhitespace();
        let j = i + 1;
        while (j < piece.text.length && !WHITE_SPACE.test(piece.text[j])) j += 1;
        const run = piece.text.slice(i, j);
        segments.push({
          nStart: text.length,
          nEnd: text.length + run.length,
          oStart: piece.oStart,
          oEnd: piece.oEnd,
        });
        text += run;
        i = j;
      }
    }
  }
  flushWhitespace();
  return { text, segments };
}

/**
 * Map a normalized range [nStart, nEnd) to the minimal original span
 * covering every contributing character, aligned to extended grapheme
 * cluster boundaries.
 */
export function toOriginalSpan(page: NormalizedPage, nStart: number, nEnd: number): Span {
  const { segments, text } = page;
  if (segments.length === 0) return { start: 0, end: 0 };
  const from = Math.max(0, Math.min(nStart, text.length));
  const to = Math.max(from, Math.min(nEnd, text.length));
  if (from >= to) {
    // Empty range: collapse to the original boundary at this position.
    for (const seg of segments) {
      if (from < seg.nEnd) return { start: seg.oStart, end: seg.oStart };
    }
    const last = segments[segments.length - 1];
    return { start: last.oEnd, end: last.oEnd };
  }
  let start = -1;
  let end = -1;
  for (const seg of segments) {
    if (seg.nStart < to && from < seg.nEnd) {
      if (start < 0) start = seg.oStart;
      end = seg.oEnd;
    }
  }
  if (start < 0) {
    const last = segments[segments.length - 1];
    return { start: last.oEnd, end: last.oEnd };
  }
  return { start, end };
}
