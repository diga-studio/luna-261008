/** Stable row-level error codes. */
export type RowErrorCode =
  | "FIELD_COUNT"
  | "EMPTY_RESOURCE_ID"
  | "INVALID_DATE"
  | "INVALID_QUANTITY"
  | "INVALID_UNIT_COST"
  | "INVALID_TOTAL_COST"
  | "TOTAL_MISMATCH"
  | "DUPLICATE_KEY";

/** Stable file-level error codes. */
export type FileErrorCode =
  | "INVALID_UTF8"
  | "CSV_SYNTAX"
  | "RECORD_TOO_LARGE"
  | "HEADER_MISMATCH"
  | "STREAM_ERROR";

export interface RowError {
  /** 1-based logical record number (header not counted). */
  line: number;
  code: RowErrorCode;
}

export type ImportResult =
  | { status: "ok"; imported: number }
  | { status: "row_errors"; errors: RowError[] };

/** A single committed billing record, amounts as exact decimal text. */
export interface BillingRecord {
  resourceId: string;
  usageDate: string;
  quantity: string;
  unitCost: string;
  totalCost: string;
}
