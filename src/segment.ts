import { closeSync, fsyncSync, openSync, renameSync, writeSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import type { AuditRecord } from "./types.ts";

/**
 * Gzip segment files: the durable home of archived record bodies.
 * Format: one JSON object per line (JSONL), gzip-compressed.
 * Lines are written in ascending id order for reader friendliness; readers
 * must not rely on it.
 */

/** File name a sealed segment carries, derived from its sequence number. */
export function segmentFileName(seq: number): string {
  return `${seq.toString().padStart(6, "0")}.jsonl.gz`;
}

/**
 * Write records to `tmpPath`, fsync, then rename to `finalPath`.
 * The rename is the atomic "seal": a final-named file is always complete.
 */
export function writeSegment(tmpPath: string, finalPath: string, records: AuditRecord[]): void {
  const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const compressed = gzipSync(Buffer.from(lines, "utf8"), { level: 9 });
  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, compressed);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, finalPath);
}

/** Read all records of a sealed segment file, in file order. */
export function readSegment(path: string): AuditRecord[] {
  const raw = gunzipSync(readFileSync(path)).toString("utf8");
  const records: AuditRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    records.push(JSON.parse(line) as AuditRecord);
  }
  return records;
}
