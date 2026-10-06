/** A single immutable audit record. */
export interface AuditRecord {
  /** Strictly increasing, never reused. Assigned by the ledger on append. */
  id: number;
  /** Millisecond UTC event time supplied by the caller. May arrive out of order. */
  eventTimeMs: number;
  /** JSON body supplied by the caller. Stored verbatim. */
  body: string;
}

export interface Page {
  /** Records in ascending id order. */
  records: AuditRecord[];
  /** Pass as `offset` to fetch the next page; null when no more records. */
  nextOffset: number | null;
}

export interface LedgerOptions {
  /** Directory holding the SQLite db and gzip archive files. Created if missing. */
  dir: string;
  /**
   * Test-only hook invoked at labelled points inside archive().
   * If it throws, archive() aborts as if the process died at that point.
   */
  crashHook?: (point: CrashPoint) => void;
}

/** Injection points used by crash-recovery tests. */
export type CrashPoint =
  | "afterTempFileWritten"
  | "afterTempFileSynced"
  | "afterRename"
  | "afterDirSync"
  | "beforeManifestCommit"
  | "afterManifestCommit";
