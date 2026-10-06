import { readJsonFile, writeJsonFile } from "./jsonFile.js";
import type { SourceRecord } from "./types.js";

interface SourceFileShape {
  records: SourceRecord[];
}

/** Append-only persistent store of source records. */
export class SourceStore {
  private readonly filePath: string;
  private records: SourceRecord[];

  constructor(filePath: string) {
    this.filePath = filePath;
    this.records = readJsonFile<SourceFileShape>(filePath, () => ({ records: [] })).records;
  }

  /** Append a record. `delta` may be any integer; seq is assigned as maxSeq + 1. */
  append(objectId: string, delta: number): SourceRecord {
    if (!Number.isInteger(delta)) {
      throw new Error("delta must be an integer");
    }
    const record: SourceRecord = { seq: this.maxSeq() + 1, objectId, delta };
    this.records.push(record);
    this.persist();
    return record;
  }

  /** Current maximum seq (0 when empty). */
  maxSeq(): number {
    const last = this.records[this.records.length - 1];
    return last === undefined ? 0 : last.seq;
  }

  /** Records with seq in (afterSeq, upToSeq], ordered by seq. */
  range(afterSeq: number, upToSeq: number): SourceRecord[] {
    return this.records.filter((r) => r.seq > afterSeq && r.seq <= upToSeq);
  }

  /** Independent per-object summary of all appended deltas (for verification). */
  summarize(): Map<string, number> {
    const totals = new Map<string, number>();
    for (const r of this.records) {
      totals.set(r.objectId, (totals.get(r.objectId) ?? 0) + r.delta);
    }
    return totals;
  }

  private persist(): void {
    const shape: SourceFileShape = { records: this.records };
    writeJsonFile(this.filePath, shape);
  }
}
