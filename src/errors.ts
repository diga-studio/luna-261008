export type RecoveryErrorCode =
  | "CORRUPT_RECORD"
  | "CORRUPT_ATTRIBUTE"
  | "CORRUPT_RUNLIST"
  | "OUT_OF_BOUNDS"
  | "UNSUPPORTED"
  | "NOT_DELETED"
  | "CLUSTERS_IN_USE"
  | "IO";

export class RecoveryError extends Error {
  readonly code: RecoveryErrorCode;
  constructor(code: RecoveryErrorCode, message: string) {
    super(message);
    this.name = "RecoveryError";
    this.code = code;
  }
}
