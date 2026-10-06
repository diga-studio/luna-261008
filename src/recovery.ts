import * as fs from "fs";
import { AllocationBitmap } from "./bitmap.js";
import { RecoveryError } from "./errors.js";
import { ImageReader } from "./image.js";
import { parseRecord, type ParsedRecord } from "./record.js";
import {
  CLUSTER_SIZE,
  RECORD_SIZE,
  type DataRun,
  type Inspection,
  type RecoveryOptions,
  type RecoveryStats,
} from "./types.js";

const IO_CHUNK = 1024 * 1024;

export class NtfsRecovery {
  private readonly image: ImageReader;
  private readonly volumeOffset: number;
  private readonly volumeLength: number;
  private readonly record: ParsedRecord;
  private readonly bitmap: AllocationBitmap;

  constructor(imagePath: string, bitmapPath: string, options: RecoveryOptions) {
    const { volumeOffset, volumeLength, recordOffset } = options;
    for (const [name, value] of [
      ["volumeOffset", volumeOffset],
      ["volumeLength", volumeLength],
      ["recordOffset", recordOffset],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new RecoveryError("OUT_OF_BOUNDS", `${name} must be a non-negative safe integer`);
      }
    }
    if (volumeLength === 0) {
      throw new RecoveryError("OUT_OF_BOUNDS", "volumeLength must be positive");
    }
    if (recordOffset < volumeOffset || recordOffset + RECORD_SIZE > volumeOffset + volumeLength) {
      throw new RecoveryError("OUT_OF_BOUNDS", "record offset outside volume");
    }
    this.image = ImageReader.open(imagePath);
    try {
      if (volumeOffset + volumeLength > this.image.size) {
        throw new RecoveryError("OUT_OF_BOUNDS", "volume extends past end of image");
      }
      this.volumeOffset = volumeOffset;
      this.volumeLength = volumeLength;
      const volumeClusters = Math.floor(volumeLength / CLUSTER_SIZE);
      const bitmap = AllocationBitmap.load(bitmapPath, volumeClusters);
      const raw = this.image.readAt(recordOffset, RECORD_SIZE);
      this.record = parseRecord(raw, volumeClusters);
      this.bitmap = bitmap;
    } catch (err) {
      this.image.close();
      throw err;
    }
  }

  private referencedClustersFree(): boolean {
    if (this.record.data.resident) {
      return true;
    }
    for (const run of this.record.data.runs) {
      if (run.lcn === null) {
        continue;
      }
      for (let c = run.lcn; c < run.lcn + run.lengthClusters; c++) {
        if (!this.bitmap.isFree(c)) {
          return false;
        }
      }
    }
    return true;
  }

  /** Parse and validate state; report recoverability without reading file data. */
  inspect(): Inspection {
    const data = this.record.data;
    const recoverable = !this.record.inUse && this.referencedClustersFree();
    if (data.resident) {
      return {
        recoverable,
        resident: true,
        logicalSize: data.logicalSize,
        initializedSize: data.logicalSize,
        runs: [],
      };
    }
    return {
      recoverable,
      resident: false,
      logicalSize: data.logicalSize,
      initializedSize: data.initializedSize,
      runs: data.runs.map((r) => ({ ...r })),
    };
  }

  private assertRecoverable(): void {
    if (this.record.inUse) {
      throw new RecoveryError("NOT_DELETED", "record is marked in use");
    }
    if (!this.referencedClustersFree()) {
      throw new RecoveryError("CLUSTERS_IN_USE", "one or more referenced clusters are allocated");
    }
  }

  /**
   * Read the intersection of [offset, offset+length) with the file's logical
   * range. Only the requested byte ranges are read from the image.
   */
  readRange(offset: number, length: number): Buffer {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
      throw new RecoveryError("OUT_OF_BOUNDS", "invalid range");
    }
    this.assertRecoverable();
    const data = this.record.data;
    const start = Math.min(offset, data.logicalSize);
    const end = Math.min(offset + length, data.logicalSize);
    if (end <= start) {
      return Buffer.alloc(0);
    }
    if (data.resident) {
      return Buffer.from(data.data.subarray(start, end));
    }
    const out = Buffer.alloc(end - start);
    this.readInto(out, 0, start, end - start);
    return out;
  }

  /**
   * Fill `out[outOffset, outOffset+length)` with file content starting at
   * logical file offset `fileOffset`. Caller guarantees the range is inside
   * the logical size. Buffers are zero-initialized by the caller; sparse
   * runs and bytes beyond initialized size are left untouched (zero).
   */
  private readInto(out: Buffer, outOffset: number, fileOffset: number, length: number): void {
    const data = this.record.data;
    if (data.resident) {
      data.data.copy(out, outOffset, fileOffset, fileOffset + length);
      return;
    }
    const end = fileOffset + length;
    let pos = fileOffset;
    let runIndex = findRunIndex(data.runs, fileOffset);
    while (pos < end) {
      const run = data.runs[runIndex]!;
      const runStartByte = run.vcnStart * CLUSTER_SIZE;
      const runEndByte = runStartByte + run.lengthClusters * CLUSTER_SIZE;
      const chunkEnd = Math.min(end, runEndByte);
      if (pos < data.initializedSize && run.lcn !== null) {
        const diskEnd = Math.min(chunkEnd, data.initializedSize);
        let diskPos = pos;
        while (diskPos < diskEnd) {
          const n = Math.min(diskEnd - diskPos, IO_CHUNK);
          const imageOffset =
            this.volumeOffset + (run.lcn + Math.floor((diskPos - runStartByte) / CLUSTER_SIZE)) * CLUSTER_SIZE +
            ((diskPos - runStartByte) % CLUSTER_SIZE);
          this.image.readInto(out, outOffset + (diskPos - fileOffset), imageOffset, n);
          diskPos += n;
        }
      }
      pos = chunkEnd;
      runIndex += 1;
    }
  }

  /** Recover the full logical content to a new local file. */
  recoverToFile(outputPath: string): RecoveryStats {
    this.assertRecoverable();
    const logicalSize = this.record.data.logicalSize;
    let fd: number;
    try {
      fd = fs.openSync(outputPath, "wx");
    } catch (err) {
      throw new RecoveryError("IO", `cannot create output ${outputPath}: ${String(err)}`);
    }
    let written = 0;
    try {
      const chunk = Buffer.alloc(Math.min(logicalSize, IO_CHUNK));
      while (written < logicalSize) {
        const n = Math.min(logicalSize - written, IO_CHUNK);
        this.readInto(chunk, 0, written, n);
        let off = 0;
        while (off < n) {
          off += fs.writeSync(fd, chunk, off, n - off);
        }
        written += n;
      }
      fs.closeSync(fd);
    } catch (err) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(outputPath);
      } catch {
        /* ignore */
      }
      throw err;
    }
    return { bytesWritten: written, outputPath };
  }

  close(): void {
    this.image.close();
  }
}

function findRunIndex(runs: DataRun[], bytePos: number): number {
  const vcn = Math.floor(bytePos / CLUSTER_SIZE);
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    if (vcn < run.vcnStart + run.lengthClusters) {
      return i;
    }
  }
  return runs.length - 1;
}
