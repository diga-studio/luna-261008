import { CorruptRecordError, UnsupportedError } from "./errors.js";
import { CLUSTER_SIZE, RECORD_SIZE, type DataRun } from "./types.js";

const ATTR_TYPE_DATA = 0x80;
const ATTR_TYPE_END = 0xffffffff;
const ATTR_FLAG_COMPRESSED = 0x0001;
const ATTR_FLAG_ENCRYPTED = 0x4000;

/** 记录中未命名 $DATA 属性的解析结果。 */
export interface DataAttributeInfo {
  resident: boolean;
  /** 逻辑长度（字节），以属性声明的 real size 为准。 */
  logicalSize: number;
  /** 已初始化长度（字节）；驻留时等于 logicalSize。 */
  initializedSize: number;
  /** 驻留内容在记录缓冲区中的偏移；非驻留为 -1。 */
  residentOffset: number;
  residentLength: number;
  /** 非驻留运行段字节范围；驻留为 -1/0。 */
  runlistOffset: number;
  runlistLength: number;
}

function readU64(record: Buffer, offset: number, what: string): number {
  const value = record.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new UnsupportedError(`${what} too large: ${value}`);
  }
  return Number(value);
}

function checkRange(offset: number, length: number, what: string): void {
  if (offset < 0 || length < 0 || offset + length > RECORD_SIZE) {
    throw new CorruptRecordError(`${what} outside record bounds`);
  }
}

/** 在已修复的记录中定位并解析未命名 $DATA 属性。 */
export function findDataAttribute(record: Buffer): DataAttributeInfo {
  // 扩展记录（base reference 非零）依赖其它记录，明确不支持。
  if (record.readBigUInt64LE(0x20) !== 0n) {
    throw new UnsupportedError("extension record (non-zero base reference)");
  }
  const firstAttr = record.readUInt16LE(0x14);
  checkRange(firstAttr, 0, "first attribute offset");

  let offset = firstAttr;
  for (;;) {
    checkRange(offset, 16, "attribute header");
    const type = record.readUInt32LE(offset);
    if (type === ATTR_TYPE_END) break;
    const attrLength = record.readUInt32LE(offset + 0x04);
    if (attrLength < 16) {
      throw new CorruptRecordError(`attribute length too small: ${attrLength}`);
    }
    checkRange(offset, attrLength, "attribute");

    const nonResident = record.readUInt8(offset + 0x08) !== 0;
    const nameLength = record.readUInt8(offset + 0x09);
    const flags = record.readUInt16LE(offset + 0x0c);

    if (type === ATTR_TYPE_DATA && nameLength === 0) {
      if (flags & ATTR_FLAG_ENCRYPTED) {
        throw new UnsupportedError("encrypted $DATA attribute");
      }
      if (flags & ATTR_FLAG_COMPRESSED) {
        throw new UnsupportedError("compressed $DATA attribute");
      }
      return nonResident
        ? parseNonResident(record, offset, attrLength)
        : parseResident(record, offset, attrLength);
    }
    offset += attrLength;
  }
  throw new UnsupportedError("no unnamed $DATA attribute");
}

function parseResident(
  record: Buffer,
  offset: number,
  attrLength: number,
): DataAttributeInfo {
  checkRange(offset, 0x18, "resident attribute header");
  const contentLength = record.readUInt32LE(offset + 0x10);
  const contentOffset = record.readUInt16LE(offset + 0x14);
  if (contentOffset + contentLength > attrLength) {
    throw new CorruptRecordError("resident content outside attribute");
  }
  checkRange(offset + contentOffset, contentLength, "resident content");
  return {
    resident: true,
    logicalSize: contentLength,
    initializedSize: contentLength,
    residentOffset: offset + contentOffset,
    residentLength: contentLength,
    runlistOffset: -1,
    runlistLength: 0,
  };
}

function parseNonResident(
  record: Buffer,
  offset: number,
  attrLength: number,
): DataAttributeInfo {
  checkRange(offset, 0x40, "non-resident attribute header");
  const lowestVcn = readU64(record, offset + 0x10, "lowest VCN");
  const highestVcn = readU64(record, offset + 0x18, "highest VCN");
  const runlistOffset = record.readUInt16LE(offset + 0x20);
  const compressionUnit = record.readUInt16LE(offset + 0x22);
  const realSize = readU64(record, offset + 0x30, "real size");
  const initializedSize = readU64(record, offset + 0x38, "initialized size");

  if (compressionUnit !== 0) {
    throw new UnsupportedError("compressed $DATA attribute");
  }
  // 起始 VCN 必须为 0，否则说明首段在其它记录中。
  if (lowestVcn !== 0) {
    throw new UnsupportedError(`$DATA starts at VCN ${lowestVcn}, not 0`);
  }
  if (highestVcn < lowestVcn) {
    throw new CorruptRecordError("highest VCN below lowest VCN");
  }
  // 本属性声明的簇范围必须覆盖全部逻辑长度，
  // 否则说明存在其它扩展属性，运行段不完整。
  const declaredClusters = highestVcn + 1;
  if (declaredClusters > Number.MAX_SAFE_INTEGER / CLUSTER_SIZE) {
    throw new UnsupportedError("declared VCN range too large");
  }
  if (declaredClusters * CLUSTER_SIZE < realSize) {
    throw new UnsupportedError(
      "runlist extent does not cover full real size (extension record needed)",
    );
  }
  if (initializedSize > realSize) {
    throw new CorruptRecordError("initialized size exceeds real size");
  }
  if (runlistOffset >= attrLength) {
    throw new CorruptRecordError("runlist offset outside attribute");
  }
  checkRange(offset + runlistOffset, attrLength - runlistOffset, "runlist");
  return {
    resident: false,
    logicalSize: realSize,
    initializedSize,
    residentOffset: -1,
    residentLength: 0,
    runlistOffset: offset + runlistOffset,
    runlistLength: attrLength - runlistOffset,
  };
}

function readUintLE(buf: Buffer, offset: number, size: number): number {
  let value = 0;
  for (let i = size - 1; i >= 0; i--) {
    value = value * 256 + buf[offset + i]!;
  }
  return value;
}

function readIntLE(buf: Buffer, offset: number, size: number): number {
  const value = readUintLE(buf, offset, size);
  const signBit = 2 ** (size * 8 - 1);
  return value >= signBit ? value - 2 * signBit : value;
}

/**
 * 解码运行段。物理簇位移为带符号相对值（可正可负）；
 * 稀疏段（位移字段长度为 0）没有物理簇，且不改变后续段的相对基准。
 */
export function decodeRunlist(
  buf: Buffer,
  offset: number,
  length: number,
): DataRun[] {
  const runs: DataRun[] = [];
  let pos = offset;
  const end = offset + length;
  let vcn = 0;
  let lcnBase = 0;

  for (;;) {
    if (pos >= end) {
      throw new CorruptRecordError("runlist missing terminator");
    }
    const header = buf[pos]!;
    pos += 1;
    if (header === 0) break;
    const lenSize = header & 0x0f;
    const offSize = (header >> 4) & 0x0f;
    if (lenSize === 0 || lenSize > 8 || offSize > 8) {
      throw new CorruptRecordError(
        `bad runlist entry sizes: len=${lenSize} off=${offSize}`,
      );
    }
    if (pos + lenSize + offSize > end) {
      throw new CorruptRecordError("runlist entry truncated");
    }
    const runLength = readUintLE(buf, pos, lenSize);
    pos += lenSize;
    if (runLength === 0) {
      throw new CorruptRecordError("runlist entry with zero length");
    }
    let lcn: number | null = null;
    if (offSize > 0) {
      const delta = readIntLE(buf, pos, offSize);
      pos += offSize;
      lcnBase += delta;
      if (lcnBase < 0) {
        throw new CorruptRecordError(`negative physical cluster: ${lcnBase}`);
      }
      lcn = lcnBase;
    }
    runs.push({ vcn, lengthClusters: runLength, lcn });
    vcn += runLength;
  }
  return runs;
}
