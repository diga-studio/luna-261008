import * as fs from "fs";
import { RecoveryError } from "./errors.js";

/**
 * Volume allocation bitmap. Cluster i is addressed by bit i of the bitmap,
 * LSB-first within each byte (bit 0 of byte 0 = cluster 0). Bit set = in use.
 */
export class AllocationBitmap {
  private readonly bits: Buffer;
  private readonly volumeClusters: number;

  private constructor(bits: Buffer, volumeClusters: number) {
    this.bits = bits;
    this.volumeClusters = volumeClusters;
  }

  static load(bitmapPath: string, volumeClusters: number): AllocationBitmap {
    if (!Number.isSafeInteger(volumeClusters) || volumeClusters <= 0) {
      throw new RecoveryError("OUT_OF_BOUNDS", `invalid volume cluster count ${volumeClusters}`);
    }
    let bits: Buffer;
    try {
      bits = fs.readFileSync(bitmapPath);
    } catch (err) {
      throw new RecoveryError("IO", `cannot read bitmap ${bitmapPath}: ${String(err)}`);
    }
    const needed = Math.ceil(volumeClusters / 8);
    if (bits.length < needed) {
      throw new RecoveryError(
        "OUT_OF_BOUNDS",
        `bitmap too small: ${bits.length} bytes, need ${needed} for ${volumeClusters} clusters`,
      );
    }
    return new AllocationBitmap(bits, volumeClusters);
  }

  isFree(cluster: number): boolean {
    if (!Number.isSafeInteger(cluster) || cluster < 0 || cluster >= this.volumeClusters) {
      throw new RecoveryError("OUT_OF_BOUNDS", `cluster ${cluster} outside volume`);
    }
    const byte = this.bits[cluster >> 3]!;
    return (byte & (1 << (cluster & 7))) === 0;
  }
}
