import { RecoveryError } from "./errors.js";
import type { DataRun } from "./types.js";

function readUnsignedLE(buf: Buffer, pos: number, size: number): number {
  let value = 0;
  for (let i = size - 1; i >= 0; i--) {
    value = value * 256 + buf[pos + i]!;
  }
  return value;
}

function readSignedLE(buf: Buffer, pos: number, size: number): number {
  const unsigned = readUnsignedLE(buf, pos, size);
  const signBit = 2 ** (size * 8 - 1);
  if (unsigned >= signBit) {
    return unsigned - 2 * signBit;
  }
  return unsigned;
}

/**
 * Decode an NTFS runlist. `buf` is the runlist byte range inside the record.
 * Offsets are signed deltas relative to the previous run's LCN; a sparse run
 * (offset field size 0) has no physical cluster and leaves the delta base
 * unchanged. The decoded runs must cover exactly `expectedClusters` clusters.
 */
export function decodeRunList(buf: Buffer, expectedClusters: number): DataRun[] {
  const runs: DataRun[] = [];
  let pos = 0;
  let vcn = 0;
  let baseLcn = 0;
  for (;;) {
    if (pos >= buf.length) {
      throw new RecoveryError("CORRUPT_RUNLIST", "runlist missing terminator");
    }
    const header = buf[pos]!;
    pos += 1;
    if (header === 0) {
      break;
    }
    const lengthSize = header & 0x0f;
    const offsetSize = (header >> 4) & 0x0f;
    if (lengthSize === 0 || lengthSize > 8 || offsetSize > 8) {
      throw new RecoveryError("CORRUPT_RUNLIST", `invalid runlist header 0x${header.toString(16)}`);
    }
    if (pos + lengthSize + offsetSize > buf.length) {
      throw new RecoveryError("CORRUPT_RUNLIST", "runlist entry truncated");
    }
    const length = readUnsignedLE(buf, pos, lengthSize);
    pos += lengthSize;
    if (length <= 0 || !Number.isSafeInteger(length)) {
      throw new RecoveryError("CORRUPT_RUNLIST", `invalid run length ${length}`);
    }
    let lcn: number | null = null;
    if (offsetSize > 0) {
      const delta = readSignedLE(buf, pos, offsetSize);
      pos += offsetSize;
      const next = baseLcn + delta;
      if (!Number.isSafeInteger(next)) {
        throw new RecoveryError("CORRUPT_RUNLIST", "LCN overflow");
      }
      lcn = next;
      baseLcn = next;
    }
    runs.push({ vcnStart: vcn, lengthClusters: length, lcn });
    vcn += length;
  }
  if (vcn !== expectedClusters) {
    throw new RecoveryError(
      "CORRUPT_RUNLIST",
      `runs cover ${vcn} clusters, attribute declares ${expectedClusters}`,
    );
  }
  return runs;
}
