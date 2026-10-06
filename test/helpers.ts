import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { LocalFileStore, type FileStore } from "../src/storage.js";
import type { Repository, UploadHandle } from "../src/repository.js";

export class Deferred<T> {
  readonly promise: Promise<T>;
  private resolveFn!: (value: T) => void;
  private rejectFn!: (err: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
  }

  resolve(value: T): void {
    this.resolveFn(value);
  }

  reject(err: unknown): void {
    this.rejectFn(err);
  }
}

export function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pipeforge-test-"));
}

export async function* chunksOf(
  data: Uint8Array,
  chunkSize: number,
): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    yield data.subarray(offset, Math.min(offset + chunkSize, data.length));
  }
}

export function patternBytes(length: number): Buffer {
  const buf = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    buf[i] = i % 251;
  }
  return buf;
}

export async function readAll(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) {
    parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

export async function putVersions(
  repo: Repository,
  versions: string[],
): Promise<Map<string, UploadHandle>> {
  const handles = new Map<string, UploadHandle>();
  for (const version of versions) {
    const data = Buffer.from(`content-of-${version}`);
    handles.set(version, await repo.put(version, chunksOf(data, 7)));
  }
  return handles;
}

export class HookedStore implements FileStore {
  private readonly inner: LocalFileStore;
  readonly deletedKeys: string[] = [];
  private deleteGate: Promise<void> | null = null;
  private deleteStarted: Deferred<string> | null = null;

  constructor(readonly directory: string) {
    this.inner = new LocalFileStore(directory);
  }

  put(fileKey: string, source: AsyncIterable<Uint8Array>): Promise<void> {
    return this.inner.put(fileKey, source);
  }

  openRead(fileKey: string): Readable {
    return this.inner.openRead(fileKey);
  }

  async delete(fileKey: string): Promise<void> {
    this.deleteStarted?.resolve(fileKey);
    if (this.deleteGate) {
      await this.deleteGate;
    }
    await this.inner.delete(fileKey);
    this.deletedKeys.push(fileKey);
  }

  expectNextDelete(): Promise<string> {
    this.deleteStarted = new Deferred<string>();
    return this.deleteStarted.promise;
  }

  setDeleteGate(gate: Promise<void> | null): void {
    this.deleteGate = gate;
  }

  fileExists(fileKey: string): boolean {
    return fs.existsSync(path.join(this.directory, fileKey));
  }
}
