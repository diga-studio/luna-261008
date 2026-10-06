/** Information about a single retained version of an output. */
export interface VersionInfo {
  /** Monotonic version number, starts at 1 for each output. */
  version: number;
  /** Lowercase hex SHA-256 of the version's exact bytes. */
  sha256: string;
  /** Size in bytes. */
  size: number;
}

/** Snapshot returned by inspect(). */
export interface Inspection {
  /** Logical output name. */
  output: string;
  /** Version number the stable delivery path currently serves, or null if none. */
  currentVersion: number | null;
  /** Absolute path of the stable delivery file. */
  deliveryPath: string;
  /** All retained versions, ascending by version number. */
  versions: VersionInfo[];
}
