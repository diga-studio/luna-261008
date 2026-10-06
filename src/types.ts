/** A single scan plan request. */
export interface ScanPlan {
  /** Up to 20 normalized absolute directory paths. */
  roots: string[];
  /** Up to 200 normalized absolute whitelist paths (excluded with descendants). */
  whitelist: string[];
}

/** One manifest record: a unique underlying file entity. */
export interface ScanRecord {
  /** Representative access path (fewest components, then UTF-8 byte order). */
  path: string;
  /** Device id of the underlying file entity. */
  dev: number;
  /** Inode number of the underlying file entity. */
  ino: number;
}

/** In-memory scan manifest. */
export interface ScanManifest {
  files: ScanRecord[];
}
