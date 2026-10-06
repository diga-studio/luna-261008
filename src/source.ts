import { SourceRecord, SourceStore } from "./types";
import * as fs from "node:fs";
import * as path from "node:path";

interface SourceFileShape {
  records: SourceRecord[];
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

/** 基于本地 JSON 文件的追加式来源存储。 */
export class FileSourceStore implements SourceStore {
  private readonly file: string;
  private records: SourceRecord[] = [];

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "source.json");
    if (fs.existsSync(this.file)) {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as SourceFileShape;
      this.records = parsed.records ?? [];
    }
  }

  append(record: SourceRecord): void {
    if (
      !Number.isInteger(record.seq) ||
      !Number.isInteger(record.delta) ||
      typeof record.objectId !== "string" ||
      record.objectId.length === 0
    ) {
      throw new Error("invalid source record");
    }
    const last = this.records[this.records.length - 1];
    if (last !== undefined && record.seq <= last.seq) {
      throw new Error(
        `seq must be strictly increasing: got ${record.seq}, last is ${last.seq}`,
      );
    }
    this.records.push({ seq: record.seq, objectId: record.objectId, delta: record.delta });
    const shape: SourceFileShape = { records: this.records };
    writeJsonAtomic(this.file, shape);
  }

  maxSeq(): number {
    const last = this.records[this.records.length - 1];
    return last === undefined ? 0 : last.seq;
  }

  readRange(fromExclusive: number, toInclusive: number): SourceRecord[] {
    return this.records.filter(
      (r) => r.seq > fromExclusive && r.seq <= toInclusive,
    );
  }
}
