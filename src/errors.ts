import type { FileErrorCode } from "./types.js";

/** Thrown for file-level failures; all writes are rolled back. */
export class FileImportError extends Error {
  readonly code: FileErrorCode;
  constructor(code: FileErrorCode, message: string) {
    super(message);
    this.name = "FileImportError";
    this.code = code;
  }
}
