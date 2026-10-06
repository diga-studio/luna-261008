/** Kind of destructive operation detected. */
export type OperationType = "dropTable" | "truncate" | "dropColumn";

/** A single detected destructive operation. */
export interface Hit {
  /** What kind of destructive operation was found. */
  operation: OperationType;
  /**
   * Qualified table name, one element per name level (e.g. ["public", "t"]).
   * Unquoted identifiers are ASCII-lowercased; quoted identifiers keep their
   * case with doubled quotes unescaped.
   */
  table: string[];
  /** Affected column, present only for dropColumn hits. */
  column?: string;
  /** UTF-8 byte offset (from 0) of the destructive keyword in the input. */
  offset: number;
}

/** Whether the event could be fully determined. */
export type AnalysisStatus = "ok" | "incomplete";

/** Final result of analyzing one event. */
export interface AnalysisResult {
  /**
   * "ok" when every lexical structure was closed and all statements were
   * fully determined; "incomplete" when the event ended inside a string,
   * quoted identifier or block comment (result cannot be deemed safe).
   */
  status: AnalysisStatus;
  /**
   * Hits from fully completed statements. When status is "incomplete",
   * hits from the unfinished trailing statement are excluded.
   */
  hits: Hit[];
}
