import * as fs from "node:fs";
import * as path from "node:path";

/** 已提交请求的记录，用于幂等重试。记录永久保留，即使对应版本已被淘汰。 */
export interface RequestRecord {
  op: "publish" | "rollback";
  /** publish 的源文件路径 */
  sourcePath?: string;
  /** rollback 的目标版本 */
  rollbackVersion?: number;
  /** 该请求提交后产生的版本号 */
  resultVersion: number;
}

export interface VersionEntry {
  version: number;
  sha256: string;
  size: number;
}

/** 单个输出的持久化元数据 */
export interface OutputMeta {
  currentVersion: number;
  /** 仍保留的版本（含当前版本），升序 */
  versions: VersionEntry[];
  /** requestId -> 已提交请求记录 */
  requests: Record<string, RequestRecord>;
}

export function emptyMeta(): OutputMeta {
  return { currentVersion: 0, versions: [], requests: {} };
}

export function loadMeta(metaPath: string): OutputMeta | null {
  let raw: string;
  try {
    raw = fs.readFileSync(metaPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return JSON.parse(raw) as OutputMeta;
}

/** 原子写：先写临时文件再 rename，避免半截文件。 */
export function saveMeta(metaPath: string, meta: OutputMeta): void {
  const tmp = path.join(path.dirname(metaPath), `.meta.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, metaPath);
}
