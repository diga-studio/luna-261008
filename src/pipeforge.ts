import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { readFileBuffer, sha256Buffer, sha256File, writeFileAtomic } from "./fsutil.js";
import {
  loadMeta,
  outputLayout,
  saveMeta,
  type OutputLayout,
  type OutputMeta,
  type RequestRecord,
} from "./store.js";
import type { Inspection } from "./types.js";

/** How many recent versions are retained per output, current included. */
export const RETAINED_VERSIONS = 20;

/**
 * PipeForge local delivery library.
 *
 * Publishes immutable source files as numbered versions of logical outputs,
 * keeps a stable delivery path pointing at the current version, retains the
 * most recent 20 versions, and makes requestIds permanently idempotent
 * per output. Business calls are expected to be serial.
 */
export class PipeForge {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  /** Publish sourcePath as a new version of output. Returns the version number. */
  async publish(output: string, requestId: string, sourcePath: string): Promise<number> {
    const { layout, meta } = await this.load(output, requestId);

    const existing = meta.requests[requestId];
    if (existing) {
      if (existing.kind !== "publish") {
        throw new Error(`requestId "${requestId}" was already committed as a rollback`);
      }
      const sourceSha256 = await sha256File(sourcePath);
      if (sourceSha256 !== existing.sourceSha256) {
        throw new Error(`requestId "${requestId}" was already committed with different content`);
      }
      return existing.version;
    }

    const bytes = await readFileBuffer(sourcePath);
    const record: RequestRecord = {
      kind: "publish",
      version: 0,
      sourceSha256: sha256Buffer(bytes),
    };
    return this.commit(layout, meta, requestId, record, bytes);
  }

  /** Publish the content of a retained historical version as a new version. */
  async rollback(output: string, requestId: string, version: number): Promise<number> {
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(`invalid version: ${version}`);
    }
    const { layout, meta } = await this.load(output, requestId);

    const existing = meta.requests[requestId];
    if (existing) {
      if (existing.kind !== "rollback" || existing.rollbackFrom !== version) {
        throw new Error(`requestId "${requestId}" was already committed with different parameters`);
      }
      return existing.version;
    }

    const target = meta.versions.find((v) => v.version === version);
    if (!target) {
      throw new Error(`version ${version} of output "${output}" is not retained`);
    }
    const bytes = await readFileBuffer(layout.versionFile(version));
    if (sha256Buffer(bytes) !== target.sha256) {
      throw new Error(`retained version ${version} of output "${output}" failed hash verification`);
    }

    const record: RequestRecord = { kind: "rollback", version: 0, rollbackFrom: version };
    return this.commit(layout, meta, requestId, record, bytes);
  }

  /** Inspect the current delivery file and all retained versions. */
  async inspect(output: string): Promise<Inspection> {
    this.checkName(output, "output");
    const layout = outputLayout(this.rootDir, output);
    const meta = await loadMeta(layout, output);
    return {
      output,
      currentVersion: meta.currentVersion,
      deliveryPath: layout.deliveryPath,
      versions: meta.versions.map((v) => ({ ...v })),
    };
  }

  private async load(
    output: string,
    requestId: string,
  ): Promise<{ layout: OutputLayout; meta: OutputMeta }> {
    this.checkName(output, "output");
    this.checkName(requestId, "requestId");
    const layout = outputLayout(this.rootDir, output);
    const meta = await loadMeta(layout, output);
    return { layout, meta };
  }

  private checkName(value: string, what: string): void {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${what} must be a non-empty string`);
    }
  }

  /**
   * Commit bytes as the next version: write the version file, repoint the
   * stable delivery file, record the request, prune old versions, and only
   * then persist metadata. The request is committed exactly when meta.json
   * is durably updated, so a crash before that leaves the request
   * uncommitted and safe to retry.
   */
  private async commit(
    layout: OutputLayout,
    meta: OutputMeta,
    requestId: string,
    record: RequestRecord,
    bytes: Buffer,
  ): Promise<number> {
    const version = meta.nextVersion;
    record.version = version;

    await writeFileAtomic(layout.versionFile(version), bytes);
    await writeFileAtomic(layout.deliveryPath, bytes);

    meta.versions.push({ version, sha256: sha256Buffer(bytes), size: bytes.length });
    meta.currentVersion = version;
    meta.nextVersion = version + 1;
    meta.requests[requestId] = record;

    const pruned = meta.versions.splice(0, Math.max(0, meta.versions.length - RETAINED_VERSIONS));
    await saveMeta(layout, meta);

    for (const old of pruned) {
      await unlink(layout.versionFile(old.version)).catch(() => undefined);
    }
    return version;
  }
}
