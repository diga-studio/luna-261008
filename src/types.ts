export type Clock = () => number;

export type TokenStatus = "pending" | "submitted" | "expired";

export interface CreateTokenResult {
  token: string;
  /** UTC milliseconds, 14 days after creation. */
  expiresAt: number;
}

export interface SubmitResult {
  ok: true;
  /** true when this call stored the letter, false for an idempotent retry. */
  stored: boolean;
}

export interface ReadResult {
  status: TokenStatus;
  /** Present only when status is "submitted": readable byte stream of the letter. */
  stream?: NodeJS.ReadableStream;
}

export interface VaultOptions {
  /** Path to the SQLite database file (use ":memory:" for ephemeral). */
  dbPath: string;
  /** Directory where submitted letter PDFs are stored. */
  storageDir: string;
  /** Injectable clock returning UTC milliseconds. */
  clock?: Clock;
}

export class VaultError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}
