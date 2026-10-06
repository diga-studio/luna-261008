import type { Readable } from "node:stream";
import type { FileStore } from "./storage.js";
import { parseSemVer, compareSemVer, type ParsedSemVer } from "./semver.js";
import {
  HandleRetiredError,
  InvalidPromotionError,
  UnknownHandleError,
  VersionExistsError,
} from "./errors.js";

export type Stage = "dev" | "staging" | "production";

export interface UploadHandle {
  readonly id: string;
  readonly version: string;
}

export interface RepositoryHooks {
  onCollectCandidates?(candidates: readonly UploadHandle[]): void | Promise<void>;
}

export interface RepositoryOptions {
  store: FileStore;
  retainCount?: number;
  hooks?: RepositoryHooks;
}

export interface VersionRecord {
  readonly uploadId: string;
  readonly version: string;
  readonly parsed: ParsedSemVer;
  stage: Stage;
  readonly publishSeq: number;
  readonly fileKey: string;
  readonly handle: UploadHandle;
  openStreams: number;
  retired: boolean;
}

export class Repository {
  private readonly store: FileStore;
  private readonly retainCount: number;
  private readonly hooks: RepositoryHooks;
  private readonly visibleByVersion = new Map<string, VersionRecord>();
  private readonly recordsById = new Map<string, VersionRecord>();
  private readonly pendingDeletes = new Set<Promise<void>>();
  private uploadCounter = 0;
  private publishSeqCounter = 0;

  constructor(options: RepositoryOptions) {
    this.store = options.store;
    this.retainCount = options.retainCount ?? 25;
    this.hooks = options.hooks ?? {};
  }

  async put(
    version: string,
    source: AsyncIterable<Uint8Array>,
  ): Promise<UploadHandle> {
    const parsed = parseSemVer(version);
    const uploadId = `upload-${++this.uploadCounter}`;
    const fileKey = `${uploadId}.bin`;
    await this.store.put(fileKey, source);
    if (this.visibleByVersion.has(version)) {
      await this.store.delete(fileKey);
      throw new VersionExistsError(`version already exists: ${version}`);
    }
    const handle: UploadHandle = { id: uploadId, version };
    const record: VersionRecord = {
      uploadId,
      version,
      parsed,
      stage: "dev",
      publishSeq: ++this.publishSeqCounter,
      fileKey,
      handle,
      openStreams: 0,
      retired: false,
    };
    this.visibleByVersion.set(version, record);
    this.recordsById.set(uploadId, record);
    return handle;
  }

  promote(handle: UploadHandle, targetStage: Stage): void {
    const record = this.lookup(handle);
    const order: Record<Stage, number> = { dev: 0, staging: 1, production: 2 };
    if (order[targetStage] !== order[record.stage] + 1) {
      throw new InvalidPromotionError(
        `cannot promote ${record.version} from ${record.stage} to ${targetStage}`,
      );
    }
    record.stage = targetStage;
  }

  open(handle: UploadHandle): Readable {
    const record = this.lookup(handle);
    record.openStreams++;
    let stream: Readable;
    try {
      stream = this.store.openRead(record.fileKey);
    } catch (err) {
      record.openStreams--;
      throw err;
    }
    stream.on("close", () => {
      record.openStreams--;
      this.maybeRelease(record);
    });
    return stream;
  }

  async collect(): Promise<UploadHandle[]> {
    const retired: UploadHandle[] = [];
    for (;;) {
      const excess = this.computeExcess();
      if (excess.length === 0) break;
      await this.hooks.onCollectCandidates?.(excess.map((r) => r.handle));
      for (const candidate of excess) {
        if (this.tryRetire(candidate)) {
          retired.push(candidate.handle);
        }
      }
    }
    return retired;
  }

  async settled(): Promise<void> {
    await Promise.all([...this.pendingDeletes]);
  }

  private lookup(handle: UploadHandle): VersionRecord {
    const record = this.recordsById.get(handle.id);
    if (!record) {
      throw new UnknownHandleError(`unknown handle: ${handle.id}`);
    }
    if (record.retired) {
      throw new HandleRetiredError(`handle retired: ${handle.id} (${record.version})`);
    }
    return record;
  }

  private computeExcess(): VersionRecord[] {
    const retained: VersionRecord[] = [];
    for (const record of this.visibleByVersion.values()) {
      if (record.stage !== "production") retained.push(record);
    }
    retained.sort((a, b) => {
      const byPrecedence = compareSemVer(b.parsed, a.parsed);
      if (byPrecedence !== 0) return byPrecedence;
      return b.publishSeq - a.publishSeq;
    });
    return retained.slice(this.retainCount);
  }

  private tryRetire(candidate: VersionRecord): boolean {
    const record = this.recordsById.get(candidate.uploadId);
    if (!record || record.retired) return false;
    if (record.stage === "production") return false;
    if (this.visibleByVersion.get(record.version) !== record) return false;
    if (!this.computeExcess().includes(record)) return false;
    record.retired = true;
    this.visibleByVersion.delete(record.version);
    this.maybeRelease(record);
    return true;
  }

  private maybeRelease(record: VersionRecord): void {
    if (!record.retired || record.openStreams > 0) return;
    const tracked = this.store.delete(record.fileKey).catch(() => {});
    this.pendingDeletes.add(tracked);
    void tracked.finally(() => this.pendingDeletes.delete(tracked));
  }
}
