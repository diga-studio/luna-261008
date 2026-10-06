import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CriminalRecord } from "./types.js";

/**
 * 刑录数据集存储。导入后持久化到本地 JSON 文件；
 * 通过 snapshot() 取得筛查期间固定不变的只读视图。
 */
export class DatasetStore {
  private readonly filePath: string;
  private records: CriminalRecord[];

  constructor(filePath: string) {
    this.filePath = filePath;
    this.records = existsSync(filePath)
      ? (JSON.parse(readFileSync(filePath, "utf8")) as CriminalRecord[])
      : [];
  }

  /** 用给定记录整体替换数据集并持久化 */
  importRecords(records: CriminalRecord[]): void {
    this.records = records.map((record) => ({ ...record }));
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.records, null, 2), "utf8");
  }

  /** 当前数据集条数 */
  get size(): number {
    return this.records.length;
  }

  /** 取得当前数据集的只读快照（深拷贝，后续导入不影响已取快照） */
  snapshot(): readonly CriminalRecord[] {
    return this.records.map((record) => ({ ...record }));
  }
}
