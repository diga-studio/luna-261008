import { open, unlink, type FileHandle } from "node:fs/promises";
import { findDataAttribute, decodeRunlist } from "./attributes.js";
import { AllocationBitmap } from "./bitmap.js";
import { CorruptRecordError, NotRecoverableError } from "./errors.js";
import { ImageReader } from "./image.js";
import { applyFixup } from "./record.js";
import {
  CLUSTER_SIZE,
  RECORD_SIZE,
  type DataRun,
  type RecoveryCandidate,
  type VolumeOptions,
} from "./types.js";

/** 恢复/读取的流式块大小，保证单次操作额外工作内存远低于 64 MiB。 */
const IO_CHUNK = 4 << 20;

const RECORD_FLAG_IN_USE = 0x01;

/** 解析后的记录上下文（内部使用）。 */
interface ParsedRecord {
  candidate: RecoveryCandidate;
  /** 驻留内容（仅驻留形式）。 */
  residentData: Buffer | null;
}

/** 已打开的卷：持有镜像与位图句柄，所有偏移经卷起始位置换算。 */
export class Volume {
  private constructor(
    private readonly image: ImageReader,
    private readonly bitmap: AllocationBitmap,
    private readonly volumeOffset: number,
    private readonly volumeLength: number,
    private readonly clusterCount: number,
  ) {}

  static async open(options: VolumeOptions): Promise<Volume> {
    const { imagePath, volumeOffset, volumeLength, bitmapPath } = options;
    if (
      !Number.isSafeInteger(volumeOffset) ||
      volumeOffset < 0 ||
      !Number.isSafeInteger(volumeLength) ||
      volumeLength <= 0
    ) {
      throw new RangeError("invalid volume offset or length");
    }
    const clusterCount = Math.floor(volumeLength / CLUSTER_SIZE);
    const image = await ImageReader.open(imagePath);
    try {
      const bitmap = await AllocationBitmap.open(bitmapPath, clusterCount);
      return new Volume(
        image,
        bitmap,
        volumeOffset,
        volumeLength,
        clusterCount,
      );
    } catch (err) {
      await image.close();
      throw err;
    }
  }

  /** 检查目标 $MFT 记录，返回候选描述；损坏记录抛 CorruptRecordError。 */
  async inspectRecord(recordOffset: number): Promise<RecoveryCandidate> {
    const parsed = await this.parseRecord(recordOffset);
    return parsed.candidate;
  }

  /**
   * 读取文件逻辑区间 [offset, offset+length) 与逻辑范围的交集。
   * 返回的 Buffer 可能短于请求长度（到达逻辑末尾）。
   * 不读取请求范围之外的文件数据内容。
   */
  async readRange(
    recordOffset: number,
    offset: number,
    length: number,
  ): Promise<Buffer> {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RangeError(`invalid offset: ${offset}`);
    }
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RangeError(`invalid length: ${length}`);
    }
    const parsed = await this.parseRecord(recordOffset);
    this.ensureRecoverable(parsed.candidate);

    const { logicalSize } = parsed.candidate;
    const start = Math.min(offset, logicalSize);
    const end = Math.min(offset + length, logicalSize);
    if (start >= end) return Buffer.alloc(0);

    if (parsed.candidate.resident) {
      return Buffer.from(parsed.residentData!.subarray(start, end));
    }

    const result = Buffer.alloc(end - start);
    await this.fillFromRuns(parsed.candidate.runs, parsed.candidate.initializedSize, start, end, result);
    return result;
  }

  /**
   * 完整恢复到本地新文件。
   * 记录仍被使用或任一引用簇已被占用：拒绝且不留下输出文件。
   */
  async recover(recordOffset: number, outputPath: string): Promise<void> {
    const parsed = await this.parseRecord(recordOffset);
    // 先完成全部可恢复性检查，再创建输出文件。
    this.ensureRecoverable(parsed.candidate);

    let out: FileHandle | null = null;
    try {
      out = await open(outputPath, "w");
      if (parsed.candidate.resident) {
        await out.writeFile(parsed.residentData!);
      } else {
        await this.streamNonResident(parsed.candidate, out);
      }
      await out.close();
      out = null;
    } finally {
      if (out !== null) {
        await out.close().catch(() => undefined);
        await unlink(outputPath).catch(() => undefined);
      }
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.image.close(), this.bitmap.close()]);
  }

  /** 读取并解析记录，校验结构完整性与物理引用边界。 */
  private async parseRecord(recordOffset: number): Promise<ParsedRecord> {
    if (!Number.isSafeInteger(recordOffset)) {
      throw new CorruptRecordError(`invalid record offset: ${recordOffset}`);
    }
    if (
      recordOffset < this.volumeOffset ||
      recordOffset + RECORD_SIZE > this.volumeOffset + this.volumeLength
    ) {
      throw new CorruptRecordError(
        `record offset ${recordOffset} outside volume`,
      );
    }
    const record = Buffer.allocUnsafe(RECORD_SIZE);
    try {
      await this.image.readAt(recordOffset, RECORD_SIZE, record);
    } catch (err) {
      throw new CorruptRecordError(
        `record at ${recordOffset} truncated or unreadable: ${(err as Error).message}`,
      );
    }
    applyFixup(record);

    const flags = record.readUInt16LE(0x16);
    const recordUnused = (flags & RECORD_FLAG_IN_USE) === 0;

    const info = findDataAttribute(record);
    if (info.resident) {
      return {
        candidate: {
          recordUnused,
          resident: true,
          logicalSize: info.logicalSize,
          initializedSize: info.initializedSize,
          runs: [],
          allClustersFree: true, // 驻留数据不引用物理簇
        },
        residentData: record.subarray(
          info.residentOffset,
          info.residentOffset + info.residentLength,
        ),
      };
    }

    const runs = decodeRunlist(record, info.runlistOffset, info.runlistLength);
    // 运行段声明的簇数必须恰好覆盖属性声明的 VCN 范围。
    const declaredClusters = runs.reduce(
      (sum, run) => sum + run.lengthClusters,
      0,
    );
    if (declaredClusters * CLUSTER_SIZE < info.logicalSize) {
      throw new CorruptRecordError("runlist does not cover declared length");
    }
    const allClustersFree = await this.bitmap.allClustersFree(runs);
    return {
      candidate: {
        recordUnused,
        resident: false,
        logicalSize: info.logicalSize,
        initializedSize: info.initializedSize,
        runs,
        allClustersFree,
      },
      residentData: null,
    };
  }

  private ensureRecoverable(candidate: RecoveryCandidate): void {
    if (!candidate.recordUnused) {
      throw new NotRecoverableError("record is still in use");
    }
    if (!candidate.allClustersFree) {
      throw new NotRecoverableError(
        "one or more referenced clusters are allocated",
      );
    }
  }

  /**
   * 将逻辑区间 [start, end) 填入 result（从零开始）。
   * 稀疏区域与超出已初始化长度的尾部保持为零；只读取请求范围内的物理字节。
   */
  private async fillFromRuns(
    runs: DataRun[],
    initializedSize: number,
    start: number,
    end: number,
    result: Buffer,
  ): Promise<void> {
    for (const run of runs) {
      const runStart = run.vcn * CLUSTER_SIZE;
      const runEnd = runStart + run.lengthClusters * CLUSTER_SIZE;
      const readStart = Math.max(start, runStart);
      const readEnd = Math.min(end, runEnd, initializedSize);
      if (readStart >= readEnd) continue;
      if (run.lcn === null) continue; // 稀疏段：保持零
      const physical =
        this.volumeOffset + run.lcn * CLUSTER_SIZE + (readStart - runStart);
      const length = readEnd - readStart;
      await this.image.readAt(
        physical,
        length,
        result.subarray(readStart - start, readStart - start + length),
      );
    }
  }

  /** 分块流式写出非驻留文件，单次操作额外内存以 IO_CHUNK 为界。 */
  private async streamNonResident(
    candidate: RecoveryCandidate,
    out: FileHandle,
  ): Promise<void> {
    const { runs, logicalSize, initializedSize } = candidate;
    const zeroChunk = Buffer.alloc(IO_CHUNK);
    const dataChunk = Buffer.allocUnsafe(IO_CHUNK);
    let position = 0;

    for (const run of runs) {
      if (position >= logicalSize) break;
      const runStart = run.vcn * CLUSTER_SIZE;
      const runEnd = Math.min(
        runStart + run.lengthClusters * CLUSTER_SIZE,
        logicalSize,
      );
      let cursor = Math.max(position, runStart);
      while (cursor < runEnd) {
        const take = Math.min(IO_CHUNK, runEnd - cursor);
        const dataTake = Math.max(
          0,
          Math.min(take, initializedSize - cursor),
        );
        if (run.lcn === null || dataTake === 0) {
          // 稀疏段 / 未初始化尾部：写零，不触碰物理簇。
          await out.write(zeroChunk, 0, take);
        } else {
          if (dataTake < take) {
            // 块跨越已初始化边界：先写数据，剩余补零。
            const physical =
              this.volumeOffset + run.lcn * CLUSTER_SIZE + (cursor - runStart);
            await this.image.readAt(
              physical,
              dataTake,
              dataChunk.subarray(0, dataTake),
            );
            await out.write(dataChunk, 0, dataTake);
            await out.write(zeroChunk, 0, take - dataTake);
            cursor += take;
            continue;
          }
          const physical =
            this.volumeOffset + run.lcn * CLUSTER_SIZE + (cursor - runStart);
          await this.image.readAt(physical, take, dataChunk.subarray(0, take));
          await out.write(dataChunk, 0, take);
        }
        cursor += take;
      }
      position = runEnd;
    }
  }
}
