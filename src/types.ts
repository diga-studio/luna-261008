/** Lifecycle stage of a published version. */
export type Stage = 'dev' | 'staging' | 'production';

/** Async byte stream used as upload source. */
export type ByteSource = AsyncIterable<Uint8Array>;

/** Async download stream. Must be closed (explicitly or by full consumption) to release resources. */
export interface Download extends AsyncIterable<Uint8Array> {
  /** Abort the download early and release the underlying file. Idempotent. */
  close(): Promise<void>;
}

/** Read-only snapshot of a version's metadata, passed to test hooks. */
export interface VersionInfo {
  version: string;
  uploadId: number;
  stage: Stage;
  size: number;
  /** Monotonic publish order; larger means published later. */
  seq: number;
  /** Absolute path of the backing file. */
  path: string;
}

/**
 * Deterministic interleaving hooks. All hooks are optional and may be async;
 * the repository awaits them at the exact point described.
 */
export interface Hooks {
  /** Called inside Collect after excess candidates are selected, before any retirement. */
  afterCollectCandidates?(candidates: VersionInfo[]): void | Promise<void>;
  /** Called inside Collect right before a single candidate is logically retired. */
  beforeRetire?(candidate: VersionInfo): void | Promise<void>;
  /** Called right before the backing file of a retired version is unlinked. */
  beforePhysicalDelete?(info: VersionInfo): void | Promise<void>;
  /** Called after the backing file of a retired version has been unlinked. */
  afterPhysicalDelete?(info: VersionInfo): void | Promise<void>;
}

export interface RepositoryOptions {
  /** Local directory used to store blobs. Created if missing. */
  dir: string;
  /** Number of non-production versions retained by Collect. Defaults to 25. */
  retainCount?: number;
  hooks?: Hooks;
}
