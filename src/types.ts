/** A single scan plan request. All paths are normalized absolute paths. */
export interface ScanPlan {
  /** Scan root directories. At most 20. */
  readonly roots: readonly string[];
  /** Whitelisted (excluded) paths. At most 200. */
  readonly whitelist: readonly string[];
}

/** One entry of the in-memory scan manifest. */
export interface ManifestEntry {
  /**
   * Representative access path for this file entity: among all legal
   * candidate paths, the one with the fewest path components; ties are
   * broken by UTF-8 byte order of the full path.
   */
  readonly path: string;
  /** Identity of the underlying file entity (st_dev). */
  readonly dev: bigint;
  /** Identity of the underlying file entity (st_ino). */
  readonly ino: bigint;
}

/** Result of planning a scan: the in-memory manifest. */
export interface ScanManifest {
  /** Entries sorted by representative path in UTF-8 byte order. No duplicates. */
  readonly files: readonly ManifestEntry[];
}
