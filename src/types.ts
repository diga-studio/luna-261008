/**
 * A half-open interval [start, end) of UTF-16 code unit offsets
 * into the original (un-normalized) text of a single page.
 */
export interface Span {
  start: number;
  end: number;
}

/**
 * One field extraction rule. The anchor is a literal keyword;
 * the pattern must define a named capture group "value".
 */
export interface FieldRule {
  name: string;
  anchor: string;
  pattern: RegExp;
}

/** A single extracted field candidate with original-text evidence. */
export interface FieldCandidate {
  /** Field name, copied from the rule. */
  field: string;
  /** Non-empty normalized value captured by the "value" group. */
  value: string;
  /** Zero-based index of the page the candidate was found on. */
  page: number;
  /** Evidence span of the anchor keyword in the original page text. */
  anchor: Span;
  /** Evidence span of the captured value in the original page text. */
  valueSpan: Span;
}

export interface ExtractResult {
  /** Normalized per-page match text (pages are never joined). */
  pages: string[];
  /** All non-empty candidates, in page then reading order. */
  candidates: FieldCandidate[];
}
