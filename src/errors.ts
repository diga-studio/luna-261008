/** Error codes thrown by VaultTerm. */
export type VaultTermErrorCode =
  | "EVENT_CONFLICT"
  | "SESSION_SEALED"
  | "INTEGRITY_FAILURE"
  | "INVALID_KEY"
  | "INVALID_ARGUMENT";

export class VaultTermError extends Error {
  readonly code: VaultTermErrorCode;
  constructor(code: VaultTermErrorCode, message: string) {
    super(message);
    this.name = "VaultTermError";
    this.code = code;
  }
}
