/** A single decrypted audit record returned by read(). */
export interface AuditRecord {
  /** 1-based contiguous sequence number. */
  seq: number;
  /** Caller-supplied event identifier. */
  eventId: string;
  /** Raw keystroke bytes. */
  bytes: Uint8Array;
}

/** Public handle for an opened audit session. */
export interface VaultTermSession {
  /** Append one record; retries with identical bytes return the original seq. */
  append(eventId: string, bytes: Uint8Array): number;
  /** Permanently seal the session; repeated calls are no-ops. */
  seal(): void;
  /** Verify integrity and return all committed records in order. */
  read(): AuditRecord[];
  /** Whether the session has been sealed. */
  readonly sealed: boolean;
  /** Close the underlying log file handle. */
  close(): void;
}
