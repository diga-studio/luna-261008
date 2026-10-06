import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SECTOR = 512;
export const CLUSTER = 4096;
export const RECORD = 1024;
const USA_OFFSET = 0x30;
const FIRST_ATTR = 0x38;
const USA_SIGNATURE = 0xa55a;

export interface RunSpec {
  /** 段长度（簇）。 */
  length: number;
  /** 相对物理簇位移；null 表示稀疏段。 */
  delta: number | null;
}

function uintBytesLE(value: number): number[] {
  const bytes: number[] = [];
  let v = value;
  do {
    bytes.push(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return bytes;
}

function intBytesLE(value: number): number[] {
  const bytes: number[] = [];
  let v = value;
  for (;;) {
    const b = v & 0xff;
    bytes.push(b);
    // Math.floor(v / 256) 对正负安全整数均等价于算术右移 8 位。
    v = Math.floor(v / 256);
    if ((v === 0 && (b & 0x80) === 0) || (v === -1 && (b & 0x80) !== 0)) break;
  }
  return bytes;
}

/** 编码运行段字节（含 0 终止符）。 */
export function encodeRuns(runs: RunSpec[]): Buffer {
  const out: number[] = [];
  for (const run of runs) {
    const lenBytes = uintBytesLE(run.length);
    if (run.delta === null) {
      out.push(lenBytes.length, ...lenBytes);
    } else {
      const offBytes = intBytesLE(run.delta);
      out.push((offBytes.length << 4) | lenBytes.length, ...lenBytes, ...offBytes);
    }
  }
  out.push(0);
  return Buffer.from(out);
}

export interface ResidentSpec {
  kind: "resident";
  content: Buffer;
}

export interface NonResidentSpec {
  kind: "nonresident";
  runlist: Buffer;
  highestVcn: number;
  realSize: number;
  initializedSize: number;
  flags?: number;
}

/** 构造一条含未命名 $DATA 属性的 FILE 记录，并应用扇区尾保护。 */
export function buildRecord(
  data: ResidentSpec | NonResidentSpec,
  options: { inUse?: boolean } = {},
): Buffer {
  const record = Buffer.alloc(RECORD);
  record.write("FILE", 0, "ascii");
  record.writeUInt16LE(USA_OFFSET, 0x04);
  record.writeUInt16LE(3, 0x06); // 2 扇区 + 1
  record.writeUInt16LE(1, 0x10); // sequence
  record.writeUInt16LE(1, 0x12); // link count
  record.writeUInt16LE(FIRST_ATTR, 0x14);
  record.writeUInt16LE(options.inUse ? 0x01 : 0x00, 0x16);
  record.writeUInt32LE(RECORD, 0x1c); // allocated size
  record.writeUInt32LE(1, 0x28); // next attr id

  let attrLength: number;
  if (data.kind === "resident") {
    attrLength = 0x18 + data.content.length;
    record.writeUInt32LE(0x80, FIRST_ATTR);
    record.writeUInt32LE(attrLength, FIRST_ATTR + 0x04);
    record.writeUInt8(0, FIRST_ATTR + 0x08);
    record.writeUInt32LE(data.content.length, FIRST_ATTR + 0x10);
    record.writeUInt16LE(0x18, FIRST_ATTR + 0x14);
    data.content.copy(record, FIRST_ATTR + 0x18);
  } else {
    attrLength = 0x40 + data.runlist.length;
    record.writeUInt32LE(0x80, FIRST_ATTR);
    record.writeUInt32LE(attrLength, FIRST_ATTR + 0x04);
    record.writeUInt8(1, FIRST_ATTR + 0x08);
    record.writeUInt16LE(data.flags ?? 0, FIRST_ATTR + 0x0c);
    record.writeBigUInt64LE(0n, FIRST_ATTR + 0x10); // lowest VCN
    record.writeBigUInt64LE(BigInt(data.highestVcn), FIRST_ATTR + 0x18);
    record.writeUInt16LE(0x40, FIRST_ATTR + 0x20); // runlist offset
    record.writeBigUInt64LE(
      BigInt((data.highestVcn + 1) * CLUSTER),
      FIRST_ATTR + 0x28,
    );
    record.writeBigUInt64LE(BigInt(data.realSize), FIRST_ATTR + 0x30);
    record.writeBigUInt64LE(BigInt(data.initializedSize), FIRST_ATTR + 0x38);
    data.runlist.copy(record, FIRST_ATTR + 0x40);
  }
  const end = FIRST_ATTR + attrLength;
  if (end + 4 <= RECORD) record.writeUInt32LE(0xffffffff, end);
  record.writeUInt32LE(Math.min(end + 4, RECORD), 0x18); // used size

  applyTestFixup(record);
  return record;
}

/** 与库中 applyFixup 对应：保存扇区尾并写入保护签名。 */
export function applyTestFixup(record: Buffer): void {
  const saved: number[] = [];
  for (let s = 0; s < RECORD / SECTOR; s++) {
    const tail = (s + 1) * SECTOR - 2;
    saved.push(record.readUInt16LE(tail));
    record.writeUInt16LE(USA_SIGNATURE, tail);
  }
  record.writeUInt16LE(USA_SIGNATURE, USA_OFFSET);
  record.writeUInt16LE(saved[0]!, USA_OFFSET + 2);
  record.writeUInt16LE(saved[1]!, USA_OFFSET + 4);
}

/** 生成位图文件内容：allocated 中的簇号置 1。 */
export function buildBitmap(clusterCount: number, allocated: number[]): Buffer {
  const buf = Buffer.alloc(Math.ceil(clusterCount / 8));
  for (const cluster of allocated) {
    buf[cluster >>> 3] = buf[cluster >>> 3]! | (1 << (cluster & 7));
  }
  return buf;
}

/** 临时测试目录，afterEach 清理。 */
export async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ntfs-recovery-test-"));
}

export async function cleanupTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export interface ImageLayout {
  imagePath: string;
  bitmapPath: string;
  volumeOffset: number;
  volumeLength: number;
  recordOffset: number;
}

/**
 * 写出测试镜像与位图。
 * clusters: 物理簇号 -> 内容（不足一簇补零）。
 */
export async function writeImage(options: {
  dir: string;
  volumeOffset: number;
  volumeLength: number;
  record: Buffer;
  recordLcn: number;
  clusters: Map<number, Buffer>;
  allocatedClusters?: number[];
  /** 截断镜像到该长度（用于构造截断记录）；默认只写到需要的最大偏移。 */
  truncateTo?: number;
}): Promise<ImageLayout> {
  const clusterCount = Math.floor(options.volumeLength / CLUSTER);
  const imagePath = join(options.dir, "image.dd");
  const bitmapPath = join(options.dir, "bitmap.bin");

  const handle = await open(imagePath, "w");
  try {
    for (const [lcn, content] of options.clusters) {
      const padded = Buffer.alloc(Math.ceil(content.length / CLUSTER) * CLUSTER);
      content.copy(padded);
      await handle.write(
        padded,
        0,
        padded.length,
        options.volumeOffset + lcn * CLUSTER,
      );
    }
    await handle.write(
      options.record,
      0,
      RECORD,
      options.volumeOffset + options.recordLcn * CLUSTER,
    );
    if (options.truncateTo !== undefined) {
      await handle.truncate(options.truncateTo);
    }
  } finally {
    await handle.close();
  }
  await writeFile(
    bitmapPath,
    buildBitmap(clusterCount, options.allocatedClusters ?? []),
  );
  return {
    imagePath,
    bitmapPath,
    volumeOffset: options.volumeOffset,
    volumeLength: options.volumeLength,
    recordOffset: options.volumeOffset + options.recordLcn * CLUSTER,
  };
}

/** 确定性伪随机内容（可复现的独立预期数据）。 */
export function pattern(seed: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) >>> 0;
    buf[i] = (state >>> 16) & 0xff;
  }
  return buf;
}
