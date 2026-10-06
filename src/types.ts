/** A single audit record. seq is assigned by the module, starting at 1. */
export interface AuditRecord {
  seq: number;
  timestampMs: number;
  prevState: string;
  nextState: string;
}

/**
 * Seal credential: commits to the content and order of records 1..count.
 * Must be stored by the caller outside the module; a verifier trusts only
 * this credential, never anything inside an export package.
 */
export interface SealCredential {
  count: number;
  /** Hex-encoded head of the record hash chain over records 1..count. */
  head: string;
}

/** Half-open time window [startMs, endMs). */
export interface TimeWindow {
  startMs: number;
  endMs: number;
}

/** An export entry revealing the full record content (a window hit). */
export interface RevealedEntry {
  kind: "record";
  record: AuditRecord;
}

/**
 * An export entry for a non-hit position inside the sealed prefix.
 * Reveals only the timestamp and the content hash (both bound by the
 * chain); the state texts stay secret.
 */
export interface SealedEntry {
  kind: "sealed";
  seq: number;
  timestampMs: number;
  /** Hex-encoded content hash of the hidden record. */
  contentHash: string;
}

export type ExportEntry = RevealedEntry | SealedEntry;

/**
 * Export package for a time window against a sealed prefix.
 * `entries` covers every seq in 1..count exactly once, in seq order:
 * hits carry full content, all other positions carry only timestamp +
 * content hash. The package deliberately does NOT state the window or
 * the credential; the verifier supplies both.
 */
export interface ExportPackage {
  count: number;
  entries: ExportEntry[];
}
