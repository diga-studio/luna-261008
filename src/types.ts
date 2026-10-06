export interface FieldRule {
  /** Field name carried through to candidates. */
  name: string;
  /** Literal keyword anchor; normalized with the same pipeline as pages. */
  anchor: string;
  /** Regex that must contain a named capture group "value". */
  pattern: RegExp;
}

/** Half-open [start, end) offsets in UTF-16 code units of the original page text. */
export interface EvidenceSpan {
  start: number;
  end: number;
}

export interface FieldCandidate {
  field: string;
  /** Normalized, non-empty captured value. */
  value: string;
  /** Zero-based page index. */
  page: number;
  /** Original-text evidence span of the anchor occurrence. */
  anchorSpan: EvidenceSpan;
  /** Original-text evidence span of the "value" capture. */
  valueSpan: EvidenceSpan;
}
