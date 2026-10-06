import type { SourceRange } from './types.js';

/** Characters removed before grapheme clustering (zero-width + BOM). */
export const IGNORED_CODE_POINTS: ReadonlySet<number> = new Set([
  0x200b, 0x200c, 0x200d, 0xfeff,
]);

/** A decoded visible character tied to its original source range. */
export interface SourceChar {
  /** The decoded character (may be a surrogate pair). */
  char: string;
  /** Original source range in UTF-16 code units. */
  range: SourceRange;
}

/**
 * One extended grapheme cluster of visible text, carrying the original
 * ranges of every source character that belongs to it.
 */
export interface GraphemeUnit {
  /** Ranges of the cluster's source characters, in source order. */
  ranges: SourceRange[];
}

/**
 * A normalized text segment: matching happens per segment, segments never
 * join across boundaries (paragraphs, line breaks, code regions).
 */
export interface NormalizedSegment {
  /** Normalized text (NFKC + lowercase per grapheme cluster). */
  text: string;
  /**
   * For each UTF-16 offset in `text`, the index of the grapheme cluster
   * (into `clusters`) that produced the character at that offset.
   */
  clusterAt: number[];
  /** Grapheme clusters of this segment, in text order. */
  clusters: GraphemeUnit[];
}

/** Remove ignored invisible characters from a decoded character stream. */
export function stripIgnored(chars: SourceChar[]): SourceChar[] {
  return chars.filter((c) => !IGNORED_CODE_POINTS.has(c.char.codePointAt(0)!));
}

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
});

/**
 * Cluster visible characters into grapheme units, then normalize each
 * cluster (NFKC + locale-independent lowercase) and build the segment's
 * normalized text with cluster back-references.
 */
export function normalizeSegment(chars: SourceChar[]): NormalizedSegment {
  const visible = stripIgnored(chars);

  // Concatenate the visible text, remembering which source char produced
  // each UTF-16 unit, so clusters can be mapped back to source ranges.
  let joined = '';
  const charIndexAt: number[] = [];
  visible.forEach((c, i) => {
    joined += c.char;
    for (let k = 0; k < c.char.length; k++) charIndexAt.push(i);
  });

  const clusters: GraphemeUnit[] = [];
  const textParts: string[] = [];
  const clusterAt: number[] = [];

  for (const part of graphemeSegmenter.segment(joined)) {
    const clusterIndex = clusters.length;
    const ranges: SourceRange[] = [];
    for (let i = part.index; i < part.index + part.segment.length; i++) {
      const range = visible[charIndexAt[i]].range;
      if (ranges.length === 0 || ranges[ranges.length - 1] !== range) {
        ranges.push(range);
      }
    }
    clusters.push({ ranges });

    const normalized = part.segment.normalize('NFKC').toLowerCase();
    textParts.push(normalized);
    for (let k = 0; k < normalized.length; k++) clusterAt.push(clusterIndex);
  }

  return { text: textParts.join(''), clusterAt, clusters };
}

/** Normalize a plain-text lexicon word with the same rules. */
export function normalizeWord(word: string): string {
  const chars: SourceChar[] = [];
  for (let i = 0; i < word.length; i++) {
    const cp = word.codePointAt(i)!;
    const char = String.fromCodePoint(cp);
    chars.push({ char, range: { start: i, end: i + char.length } });
    i += char.length - 1;
  }
  return normalizeSegment(chars).text;
}
