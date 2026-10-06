import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { InspectResult } from "./types";
import {
  OutputMeta,
  RequestRecord,
  emptyMeta,
  loadMeta,
  saveMeta,
} from "./meta";

/** 每个输出最多保留的版本数（含当前版本） */
export const MAX_RETAINED_VERSIONS = 20;

function sha256Of(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** 原子写文件：先写临时文件再 rename，保证目标路径始终指向完整内容。 */
function writeFileAtomic(target: string, data: Buffer): void {
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.tmp`,
  );
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);
}

export class PipeForge {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  private outputDir(output: string): string {
    if (!output) throw new Error("output must be a non-empty string");
    // 逻辑输出名编码为目录名，避免路径分隔符等问题
    return path.join(this.rootDir, "outputs", encodeURIComponent(output));
  }

  private metaPath(output: string): string {
    return path.join(this.outputDir(output), "meta.json");
  }

  private versionPath(output: string, version: number): string {
    return path.join(this.outputDir(output), "versions", String(version));
  }

  currentPath(output: string): string {
    return path.join(this.outputDir(output), "current");
  }

  private loadOrInit(output: string): OutputMeta {
    return loadMeta(this.metaPath(output)) ?? emptyMeta();
  }

  /**
   * 检查幂等记录。已提交且参数一致 -> 返回记录；参数不一致 -> 抛错；未提交 -> 返回 null。
   */
  private matchRequest(
    meta: OutputMeta,
    requestId: string,
    expected: Omit<RequestRecord, "resultVersion">,
  ): RequestRecord | null {
    const rec = meta.requests[requestId];
    if (!rec) return null;
    if (
      rec.op !== expected.op ||
      rec.sourcePath !== expected.sourcePath ||
      rec.rollbackVersion !== expected.rollbackVersion
    ) {
      throw new Error(
        `requestId "${requestId}" already committed with different parameters`,
      );
    }
    return rec;
  }

  /** 将 content 提交为新版本：写版本文件、更新 current、裁剪旧版本、落盘元数据。 */
  private commit(output: string, meta: OutputMeta, content: Buffer): number {
    const dir = this.outputDir(output);
    fs.mkdirSync(path.join(dir, "versions"), { recursive: true });

    const newVersion = meta.currentVersion + 1;
    const entry = {
      version: newVersion,
      sha256: sha256Of(content),
      size: content.length,
    };

    // 1. 写新版本文件
    writeFileAtomic(this.versionPath(output, newVersion), content);
    // 2. 更新当前交付文件（路径稳定，普通文件）
    writeFileAtomic(this.currentPath(output), content);
    // 3. 更新元数据并裁剪：只保留最近 MAX_RETAINED_VERSIONS 个版本
    meta.currentVersion = newVersion;
    meta.versions.push(entry);
    while (meta.versions.length > MAX_RETAINED_VERSIONS) {
      const evicted = meta.versions.shift()!;
      fs.rmSync(this.versionPath(output, evicted.version), { force: true });
    }
    // 4. 持久化元数据
    saveMeta(this.metaPath(output), meta);
    return newVersion;
  }

  async publish(
    output: string,
    requestId: string,
    sourcePath: string,
  ): Promise<number> {
    const meta = this.loadOrInit(output);
    const existing = this.matchRequest(meta, requestId, {
      op: "publish",
      sourcePath,
    });
    if (existing) return existing.resultVersion;

    const content = fs.readFileSync(sourcePath);
    meta.requests[requestId] = {
      op: "publish",
      sourcePath,
      resultVersion: meta.currentVersion + 1,
    };
    return this.commit(output, meta, content);
  }

  async rollback(
    output: string,
    requestId: string,
    version: number,
  ): Promise<number> {
    const meta = this.loadOrInit(output);
    const existing = this.matchRequest(meta, requestId, {
      op: "rollback",
      rollbackVersion: version,
    });
    if (existing) return existing.resultVersion;

    const entry = meta.versions.find((v) => v.version === version);
    if (!entry) {
      throw new Error(
        `version ${version} of output "${output}" is not retained`,
      );
    }
    const content = fs.readFileSync(this.versionPath(output, version));
    if (sha256Of(content) !== entry.sha256) {
      throw new Error(
        `version ${version} of output "${output}" failed SHA-256 verification`,
      );
    }
    meta.requests[requestId] = {
      op: "rollback",
      rollbackVersion: version,
      resultVersion: meta.currentVersion + 1,
    };
    return this.commit(output, meta, content);
  }

  async inspect(output: string): Promise<InspectResult> {
    const meta = loadMeta(this.metaPath(output));
    return {
      output,
      currentVersion: meta ? meta.currentVersion : null,
      currentPath: this.currentPath(output),
      versions: meta ? meta.versions.map((v) => ({ ...v })) : [],
    };
  }
}
