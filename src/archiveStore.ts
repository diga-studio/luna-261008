import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { AuditRecord, CrashPoint } from "./types.js";

const TMP_SUFFIX = ".tmp";

/**
 * Manages gzip archive files inside `dir/archives`.
 * File format: gzip of newline-delimited JSON records (JSONL),
 * one `AuditRecord` per line.
 */
export class ArchiveStore {
  private readonly archivesDir: string;

  constructor(archivesDir: string) {
    this.archivesDir = archivesDir;
    mkdirSync(archivesDir, { recursive: true });
  }

  /**
   * Write records to a temp file, fsync, atomically rename to `finalName`,
   * then fsync the directory. Calls the crash hook at each labelled point.
   */
  writeArchive(
    finalName: string,
    records: AuditRecord[],
    crashHook?: (point: CrashPoint) => void,
  ): void {
    const jsonl =
      records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    const payload = gzipSync(Buffer.from(jsonl, "utf8"));

    const tmpPath = join(this.archivesDir, finalName + TMP_SUFFIX);
    const fd = openSync(tmpPath, "w");
    try {
      writeSync(fd, payload);
      crashHook?.("afterTempFileWritten");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    crashHook?.("afterTempFileSynced");

    renameSync(tmpPath, join(this.archivesDir, finalName));
    crashHook?.("afterRename");

    const dirFd = openSync(this.archivesDir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
    crashHook?.("afterDirSync");
  }

  /** Read all records from a committed archive file. */
  readArchive(fileName: string): AuditRecord[] {
    const compressed = readFileSync(join(this.archivesDir, fileName));
    const jsonl = gunzipSync(compressed).toString("utf8");
    const records: AuditRecord[] = [];
    for (const line of jsonl.split("\n")) {
      if (line.length > 0) {
        records.push(JSON.parse(line) as AuditRecord);
      }
    }
    return records;
  }

  /**
   * Remove temp files and final archive files not present in `committed`.
   * Called on open so an interrupted archive leaves no partial/duplicate data.
   */
  recover(committed: string[]): void {
    const keep = new Set(committed);
    for (const entry of readdirSync(this.archivesDir)) {
      if (entry.endsWith(TMP_SUFFIX)) {
        rmSync(join(this.archivesDir, entry), { force: true });
      } else if (!keep.has(entry)) {
        rmSync(join(this.archivesDir, entry), { force: true });
      }
    }
  }
}
