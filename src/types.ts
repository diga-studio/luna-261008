/** A single immutable audit record. */
export interface AuditRecord {
  /** Strictly increasing, never reused. Assigned by the library on append. */
  id: number;
  /** Millisecond-precision UTC event time supplied by the caller. May arrive out of order. */
  eventTimeMs: number;
  /** JSON body supplied by the caller. Stored verbatim. */
  body: unknown;
}

/** Options for opening an audit archive. */
export interface OpenOptions {
  /** Directory that holds the library state: ledger.sqlite plus archive segments. */
  dir: string;
  /**
   * Test-only fault injection hooks. Called synchronously at specific points
   * of the archive pipeline; a hook may throw or terminate the process.
   */
  hooks?: ArchiveHooks;
}

export interface ArchiveHooks {
  /** Fired after the segment file has been fully written, fsynced and renamed to its final name, before the SQLite commit. */
  afterSegmentSealed?: () => void;
  /** Fired after the SQLite commit that publishes the segment and removes archived bodies. */
  afterCommit?: () => void;
}

/** Result of one archive pass. */
export interface ArchiveResult {
  /** Number of records moved from SQLite into a gzip segment in this pass. */
  archivedCount: number;
  /** Segment file name (relative to the archive dir), or null when nothing qualified. */
  segmentFile: string | null;
}

/** A page of records in ascending id order, spanning online and archived records. */
export interface Page {
  records: AuditRecord[];
  /** Pass as `cursor` to read the next page; null when no more records exist. */
  nextCursor: number | null;
}
