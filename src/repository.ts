import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { comparePrecedence, parseSemVer, SemVer } from './semver';
import type {
  ByteSource,
  Download,
  Hooks,
  RepositoryOptions,
  Stage,
  VersionInfo,
} from './types';

/** Download chunk size: at most 1 MiB buffered per read. */
const READ_CHUNK = 1 << 20;

const STAGES: readonly Stage[] = ['dev', 'staging', 'production'];

interface VersionRecord {
  uploadId: number;
  version: string;
  parsed: SemVer;
  stage: Stage;
  filePath: string;
  size: number;
  /** Monotonic publish order; larger means published later. */
  seq: number;
  retired: boolean;
  readers: number;
  deletePending: boolean;
  deleteScheduled: boolean;
  deleted: boolean;
  handle: Handle;
}

function snapshotInfo(record: VersionRecord): VersionInfo {
  return {
    version: record.version,
    uploadId: record.uploadId,
    stage: record.stage,
    size: record.size,
    seq: record.seq,
    path: record.filePath,
  };
}

/**
 * Opaque handle bound to one specific upload of a version string.
 * A handle becomes permanently invalid once its upload is logically retired,
 * even if the same version string is uploaded again afterwards.
 */
export class Handle {
  readonly id: string;
  readonly version: string;

  /** @internal */
  constructor(readonly record: VersionRecord) {
    this.version = record.version;
    this.id = `${record.version}#${record.uploadId}`;
  }
}

class FileDownload implements Download {
  private closed = false;

  constructor(
    private readonly fd: fsp.FileHandle,
    private readonly onClose: () => void,
  ) {}

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    try {
      let position = 0;
      for (;;) {
        if (this.closed) return;
        const buffer = Buffer.allocUnsafe(READ_CHUNK);
        const { bytesRead } = await this.fd.read(buffer, 0, READ_CHUNK, position);
        if (bytesRead === 0) return;
        position += bytesRead;
        yield buffer.subarray(0, bytesRead);
      }
    } finally {
      await this.close();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.fd.close();
    } finally {
      this.onClose();
    }
  }
}

/**
 * Single-repository version store with stage promotion and retention collection.
 *
 * Concurrency model: all metadata mutations happen synchronously between
 * awaits, so check-and-set sequences are atomic without locks. File I/O is
 * never serialized behind any repository-wide lock; a stalled upload,
 * download or deletion never blocks other operations.
 */
export class Repository {
  private readonly dir: string;
  private readonly blobDir: string;
  private readonly tmpDir: string;
  private readonly retainCount: number;
  private readonly hooks: Hooks;
  private readonly versions = new Map<string, VersionRecord>();
  private readonly pendingDeletes = new Set<Promise<void>>();
  private readonly deleteErrors: unknown[] = [];
  private nextUploadId = 1;
  private nextSeq = 1;
  private readonly ready: Promise<void>;

  constructor(options: RepositoryOptions) {
    if (!options || typeof options.dir !== 'string' || options.dir.length === 0) {
      throw new Error('RepositoryOptions.dir is required');
    }
    this.dir = options.dir;
    this.blobDir = path.join(this.dir, 'blobs');
    this.tmpDir = path.join(this.dir, 'tmp');
    this.retainCount = options.retainCount ?? 25;
    if (!Number.isInteger(this.retainCount) || this.retainCount < 0) {
      throw new Error('retainCount must be a non-negative integer');
    }
    this.hooks = options.hooks ?? {};
    const blobDir = this.blobDir;
    const tmpDir = this.tmpDir;
    this.ready = (async () => {
      await fsp.mkdir(blobDir, { recursive: true });
      await fsp.mkdir(tmpDir, { recursive: true });
    })();
  }

  /**
   * Upload one file for `version`. The version becomes visible only after the
   * stream has been fully consumed and persisted. Fails if the version string
   * is currently visible; never overwrites existing content.
   */
  async put(version: string, source: ByteSource): Promise<Handle> {
    const parsed = parseSemVer(version);
    await this.ready;
    const uploadId = this.nextUploadId++;
    const tmpPath = path.join(this.tmpDir, `${uploadId}.part`);
    const finalPath = path.join(this.blobDir, `${uploadId}.blob`);
    let size = 0;
    let fd: fsp.FileHandle | undefined;
    try {
      fd = await fsp.open(tmpPath, 'w');
      for await (const chunk of source) {
        const buf = toBuffer(chunk);
        if (buf.length === 0) continue;
        let written = 0;
        while (written < buf.length) {
          const { bytesWritten } = await fd.write(buf, written, buf.length - written);
          written += bytesWritten;
        }
        size += buf.length;
      }
      await fd.sync();
      await fd.close();
      fd = undefined;
      await fsp.rename(tmpPath, finalPath);
    } catch (err) {
      if (fd !== undefined) await fd.close().catch(() => undefined);
      await fsp.unlink(tmpPath).catch(() => undefined);
      await fsp.unlink(finalPath).catch(() => undefined);
      throw err;
    }
    // Synchronous check-and-set: at most one visible record per version string.
    if (this.versions.has(version)) {
      await fsp.unlink(finalPath).catch(() => undefined);
      throw new Error(`version already exists: ${version}`);
    }
    const record = {
      uploadId,
      version,
      parsed,
      stage: 'dev' as Stage,
      filePath: finalPath,
      size,
      seq: this.nextSeq++,
      retired: false,
      readers: 0,
      deletePending: false,
      deleteScheduled: false,
      deleted: false,
      handle: undefined as unknown as Handle,
    } as VersionRecord;
    const handle = new Handle(record);
    record.handle = handle;
    this.versions.set(version, record);
    return handle;
  }

  /**
   * Advance a version exactly one stage: dev -> staging -> production.
   * Synchronous metadata update; throws if the handle is stale or retired.
   */
  promote(handle: Handle, target: Stage): void {
    const record = this.requireActiveRecord(handle);
    if (!STAGES.includes(target) || target === 'dev') {
      throw new Error(`invalid target stage: ${String(target)}`);
    }
    const next: Record<Stage, Stage | null> = {
      dev: 'staging',
      staging: 'production',
      production: null,
    };
    if (next[record.stage] !== target) {
      throw new Error(`illegal stage transition: ${record.stage} -> ${target}`);
    }
    record.stage = target;
  }

  /**
   * Open a download stream for a still-valid handle. Once this call resolves,
   * the stream is guaranteed to observe the complete original bytes of that
   * upload, regardless of later collection.
   */
  async open(handle: Handle): Promise<Download> {
    const record = this.requireActiveRecord(handle);
    // Increment synchronously with the validity check so a concurrent
    // Collect cannot retire-and-delete underneath us.
    record.readers += 1;
    let fd: fsp.FileHandle;
    try {
      fd = await fsp.open(record.filePath, 'r');
    } catch (err) {
      record.readers -= 1;
      this.maybeScheduleDelete(record);
      throw err;
    }
    return new FileDownload(fd, () => this.releaseReader(record));
  }

  /**
   * Retire excess non-production versions. Keeps the `retainCount` versions
   * with the highest SemVer precedence (build metadata ignored; ties broken
   * by later publish first). Production versions are exempt and do not count
   * towards the retention budget. Returns the handles retired by this call.
   */
  async collect(): Promise<Handle[]> {
    await this.ready;
    const candidates = this.selectExcess();
    if (this.hooks.afterCollectCandidates) {
      await this.hooks.afterCollectCandidates(candidates.map(snapshotInfo));
    }
    const retired: Handle[] = [];
    for (const record of candidates) {
      if (this.hooks.beforeRetire) {
        await this.hooks.beforeRetire(snapshotInfo(record));
      }
      // Selection does not freeze eligibility: re-validate at retirement time.
      if (!this.isRetirable(record)) continue;
      record.retired = true;
      if (this.versions.get(record.version) === record) {
        this.versions.delete(record.version);
      }
      retired.push(record.handle);
      this.maybeScheduleDelete(record);
    }
    return retired;
  }

  /** Test helper: resolves once all scheduled physical deletions have finished. */
  async whenIdle(): Promise<void> {
    for (;;) {
      const pending = [...this.pendingDeletes];
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }

  /** Errors observed by background physical deletions (for diagnostics/tests). */
  get physicalDeleteErrors(): readonly unknown[] {
    return this.deleteErrors;
  }

  private requireActiveRecord(handle: Handle): VersionRecord {
    if (!(handle instanceof Handle)) {
      throw new Error('invalid handle');
    }
    const record = handle.record;
    if (record.retired || this.versions.get(record.version) !== record) {
      throw new Error(`handle is no longer valid: ${handle.id}`);
    }
    return record;
  }

  private releaseReader(record: VersionRecord): void {
    record.readers -= 1;
    if (record.readers === 0 && record.deletePending) {
      this.maybeScheduleDelete(record);
    }
  }

  /**
   * Retention priority: higher SemVer precedence wins; equal precedence keeps
   * the later-published upload. Returns negative if a should be kept over b.
   */
  private compareRetention(a: VersionRecord, b: VersionRecord): number {
    const byPrecedence = comparePrecedence(a.parsed, b.parsed);
    if (byPrecedence !== 0) return byPrecedence;
    return a.seq - b.seq;
  }

  /** Visible non-production records beyond the retention budget, lowest priority first. */
  private selectExcess(): VersionRecord[] {
    const eligible = [...this.versions.values()].filter(
      (record) => record.stage !== 'production',
    );
    eligible.sort((a, b) => this.compareRetention(b, a));
    return eligible.slice(this.retainCount).reverse();
  }

  private isRetirable(record: VersionRecord): boolean {
    if (record.retired) return false;
    if (this.versions.get(record.version) !== record) return false;
    if (record.stage === 'production') return false;
    return !this.topRetained().has(record);
  }

  private topRetained(): Set<VersionRecord> {
    const eligible = [...this.versions.values()].filter(
      (record) => record.stage !== 'production',
    );
    eligible.sort((a, b) => this.compareRetention(b, a));
    return new Set(eligible.slice(0, this.retainCount));
  }

  private maybeScheduleDelete(record: VersionRecord): void {
    if (!record.retired || record.deleteScheduled) return;
    if (record.readers > 0) {
      record.deletePending = true;
      return;
    }
    record.deleteScheduled = true;
    const info = snapshotInfo(record);
    const task = (async () => {
      try {
        if (this.hooks.beforePhysicalDelete) {
          await this.hooks.beforePhysicalDelete(info);
        }
        await fsp.unlink(record.filePath);
        record.deleted = true;
        if (this.hooks.afterPhysicalDelete) {
          await this.hooks.afterPhysicalDelete(info);
        }
      } catch (err) {
        this.deleteErrors.push(err);
      }
    })();
    this.pendingDeletes.add(task);
    task.then(
      () => this.pendingDeletes.delete(task),
      () => this.pendingDeletes.delete(task),
    );
  }
}

function toBuffer(chunk: Uint8Array): Buffer {
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new TypeError('source must yield Uint8Array chunks');
}
