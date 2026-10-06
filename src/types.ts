/** Half-open range over the original Markdown source, counted in UTF-16 code units. */
export interface SourceRange {
  start: number;
  end: number;
}

/** A single occurrence of a lexicon word in the checked content. */
export interface MatchHit {
  /** The lexicon entry exactly as it appeared in the word file. */
  word: string;
  /**
   * Original-source ranges of the grapheme clusters participating in the hit.
   * Sorted by source order; overlapping or adjacent ranges are merged.
   * May be discontinuous (format markers, link destinations and ignored
   * invisible characters are never included).
   */
  ranges: SourceRange[];
}

/** A loaded, normalized moderation lexicon. */
export interface Lexicon {
  /** Original word entries (duplicates removed, order preserved). */
  readonly words: readonly string[];
}
