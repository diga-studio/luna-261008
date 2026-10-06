import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import type { CriminalRecordInput } from "./types.js";

interface DatasetFile {
  records: CriminalRecordInput[];
}

/**
 * Local-file backed store for the imported criminal-record dataset.
 * The dataset is fixed for the duration of a screening run.
 */
export class DatasetStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Replace the dataset and persist it to the local file. */
  importRecords(records: CriminalRecordInput[]): void {
    const payload: DatasetFile = { records };
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tmpPath, this.filePath);
  }

  /** Load the dataset from the local file (empty if none exists). */
  load(): CriminalRecordInput[] {
    if (!existsSync(this.filePath)) return [];
    const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as DatasetFile;
    return parsed.records;
  }
}
