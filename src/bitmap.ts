import { CorruptRecordError } from "./errors.js";
import { ImageReader } from "./image.js";
import type { DataRun } from "./types.js";

/** 单次位图检查读取的字节窗口（1 MiB 位图 = 8 M 簇）。 */
const BITMAP_CHUNK = 1 << 20;

/**
 * 卷分配位图（文件后备，按需读取，不整载入内存）。
 * bit=1 已分配，bit=0 空闲；卷内簇号寻址，字节内低位对应较小簇号。
 */
export class AllocationBitmap {
  private constructor(
    private readonly reader: ImageReader,
    readonly clusterCount: number,
    private readonly byteLength: number,
  ) {}

  static async open(
    bitmapPath: string,
    clusterCount: number,
  ): Promise<AllocationBitmap> {
    if (!Number.isSafeInteger(clusterCount) || clusterCount < 0) {
      throw new CorruptRecordError(`invalid cluster count: ${clusterCount}`);
    }
    const reader = await ImageReader.open(bitmapPath);
    const { size } = await reader.stat();
    if (size * 8 < clusterCount) {
      await reader.close();
      throw new CorruptRecordError(
        `bitmap too small: ${size * 8} bits for ${clusterCount} clusters`,
      );
    }
    return new AllocationBitmap(reader, clusterCount, size);
  }

  /** 单个簇是否空闲；簇号越界视为损坏。 */
  async isFree(cluster: number): Promise<boolean> {
    this.checkCluster(cluster);
    const byte = Buffer.allocUnsafe(1);
    await this.reader.readAt(cluster >>> 3, 1, byte);
    return (byte[0]! & (1 << (cluster & 7))) === 0;
  }

  /**
   * 检查一组运行段引用的全部物理簇是否均空闲。
   * 物理引用越过卷边界（簇号 + 长度超出卷簇数）视为损坏，抛错。
   */
  async allClustersFree(runs: DataRun[]): Promise<boolean> {
    for (const run of runs) {
      if (run.lcn === null) continue;
      if (run.lcn + run.lengthClusters > this.clusterCount) {
        throw new CorruptRecordError(
          `run at LCN ${run.lcn} (${run.lengthClusters} clusters) beyond volume`,
        );
      }
      if (!(await this.rangeFree(run.lcn, run.lengthClusters))) return false;
    }
    return true;
  }

  private checkCluster(cluster: number): void {
    if (
      !Number.isSafeInteger(cluster) ||
      cluster < 0 ||
      cluster >= this.clusterCount
    ) {
      throw new CorruptRecordError(`cluster ${cluster} outside bitmap`);
    }
  }

  /** 检查 [startCluster, startCluster+length) 全部空闲，分块读取位图。 */
  private async rangeFree(
    startCluster: number,
    lengthClusters: number,
  ): Promise<boolean> {
    let remaining = lengthClusters;
    let cluster = startCluster;
    const buf = Buffer.allocUnsafe(BITMAP_CHUNK);
    while (remaining > 0) {
      const firstByte = cluster >>> 3;
      const bitOffset = cluster & 7;
      const maxBytes = Math.min(
        BITMAP_CHUNK,
        Math.ceil((bitOffset + remaining) / 8),
        this.byteLength - firstByte,
      );
      if (maxBytes <= 0) {
        throw new CorruptRecordError(`cluster ${cluster} outside bitmap`);
      }
      await this.reader.readAt(firstByte, maxBytes, buf.subarray(0, maxBytes));
      let bit = bitOffset;
      let todo = Math.min(remaining, maxBytes * 8 - bitOffset);
      while (todo > 0) {
        const byteIndex = bit >>> 3;
        const inByte = bit & 7;
        const take = Math.min(todo, 8 - inByte);
        const mask = ((1 << take) - 1) << inByte;
        if ((buf[byteIndex]! & mask) !== 0) return false;
        bit += take;
        todo -= take;
      }
      cluster += Math.min(remaining, maxBytes * 8 - bitOffset);
      remaining -= Math.min(remaining, maxBytes * 8 - bitOffset);
    }
    return true;
  }

  async close(): Promise<void> {
    await this.reader.close();
  }
}
