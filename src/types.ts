/** Stable row-level error codes. */
export type RowErrorCode =
  | 'FIELD_COUNT'
  | 'RESOURCE_ID_EMPTY'
  | 'USAGE_DATE_INVALID'
  | 'USAGE_QUANTITY_INVALID'
  | 'UNIT_COST_INVALID'
  | 'TOTAL_COST_INVALID'
  | 'TOTAL_COST_MISMATCH'
  | 'DUPLICATE_KEY';

/** Stable file-level error codes. */
export type FileErrorCode =
  | 'INVALID_UTF8'
  | 'CSV_SYNTAX'
  | 'INVALID_HEADER'
  | 'RECORD_TOO_LARGE'
  | 'STREAM_ERROR';

export interface RowError {
  /** 1-based logical record number (header excluded). */
  row: number;
  code: RowErrorCode;
}

export type ImportResult =
  | { ok: true; imported: number }
  | { ok: false; errors: RowError[] };

export interface BillingRecord {
  resourceId: string;
  usageDate: string;
  usageQuantity: string;
  unitCost: string;
  totalCost: string;
}

/** Thrown for file-level failures; all writes are rolled back. */
export class ImportFileError extends Error {
  readonly code: FileErrorCode;
  constructor(code: FileErrorCode, message: string) {
    super(message);
    this.name = 'ImportFileError';
    this.code = code;
  }
}
