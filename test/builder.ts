import { CLUSTER_SIZE, RECORD_SIZE, SECTOR_SIZE } from "../src/index.js";

export interface RunSpec {
  /** Absolute LCN for data runs, null for sparse. */
  lcn: number | null;
  lengthClusters: number;
}

export interface RecordSpec {
  inUse?: boolean;
  residentData?: Buffer;
  runs?: RunSpec[];
  realSize?: number;
  initializedSize?: number;
  /** Corrupt the fixup of this sector index (0-based) after building. */
  breakFixupSector?: number;
  /** Extra named $DATA stream to include. */
  namedData?: { name: string; data: Buffer };
}

function encodeRunList(runs: RunSpec[]): Buffer {
  const parts: number[] = [];
  let base = 0;
  for (const run of runs) {
    const lenBytes: number[] = [];
    let len = run.lengthClusters;
    do {
      lenBytes.push(len & 0xff);
      len = Math.floor(len / 256);
    } while (len > 0);
    let offBytes: number[] = [];
    if (run.lcn !== null) {
      const delta = run.lcn - base;
      base = run.lcn;
      offBytes = [];
      let v = delta;
      for (let i = 0; i < 8; i++) {
        offBytes.push(v & 0xff);
        v = v >> 8;
      }
      while (offBytes.length > 1) {
        const top = offBytes[offBytes.length - 1]!;
        const below = offBytes[offBytes.length - 2]!;
        if (top === 0 && (below & 0x80) === 0) {
          offBytes.pop();
        } else if (top === 0xff && (below & 0x80) !== 0) {
          offBytes.pop();
        } else {
          break;
        }
      }
    }
    parts.push((offBytes.length << 4) | lenBytes.length);
    parts.push(...lenBytes);
    parts.push(...offBytes);
  }
  parts.push(0);
  return Buffer.from(parts);
}

function utf16Name(name: string): Buffer {
    const buf = Buffer.alloc(name.length * 2);
  for (let i = 0; i < name.length; i++) {
    buf.writeUInt16LE(name.charCodeAt(i), i * 2);
  }
  return buf;
}

/** Build a 1024-byte $MFT FILE record with fixup applied. */
export function buildRecord(spec: RecordSpec): Buffer {
  const record = Buffer.alloc(RECORD_SIZE);
  record.write("FILE", 0, "ascii");
  const usaOffset = 0x30;
  const usaCount = RECORD_SIZE / SECTOR_SIZE + 1;
  record.writeUInt16LE(usaOffset, 0x04);
  record.writeUInt16LE(usaCount, 0x06);
  const firstAttr = 0x38;
  record.writeUInt16LE(firstAttr, 0x14);
  record.writeUInt16LE(spec.inUse ? 0x0001 : 0x0000, 0x16);
  record.writeUInt16LE(0xaaaa, usaOffset);
  let pos = firstAttr;

  if (spec.residentData !== undefined) {
    const value = spec.residentData;
    const attrLen = align8(24 + value.length);
    record.writeUInt32LE(0x80, pos);
    record.writeUInt32LE(attrLen, pos + 4);
    record.writeUInt8(0, pos + 8);
    record.writeUInt8(0, pos + 9);
    record.writeUInt32LE(value.length, pos + 16);
    record.writeUInt16LE(24, pos + 20);
    value.copy(record, pos + 24);
    pos += attrLen;
  } else if (spec.runs !== undefined) {
    const runlist = encodeRunList(spec.runs);
    const totalClusters = spec.runs.reduce((a, r) => a + r.lengthClusters, 0);
    const realSize = spec.realSize ?? 0;
    const initializedSize = spec.initializedSize ?? realSize;
    const runlistOffset = 64;
    const attrLen = align8(runlistOffset + runlist.length);
    record.writeUInt32LE(0x80, pos);
    record.writeUInt32LE(attrLen, pos + 4);
    record.writeUInt8(1, pos + 8);
    record.writeUInt8(0, pos + 9);
    record.writeBigInt64LE(BigInt(0), pos + 16);
    record.writeBigInt64LE(BigInt(totalClusters - 1), pos + 24);
    record.writeUInt16LE(runlistOffset, pos + 32);
    record.writeUInt16LE(0, pos + 34);
    record.writeBigInt64LE(BigInt(totalClusters * CLUSTER_SIZE), pos + 40);
    record.writeBigInt64LE(BigInt(realSize), pos + 48);
    record.writeBigInt64LE(BigInt(initializedSize), pos + 56);
    runlist.copy(record, pos + runlistOffset);
    pos += attrLen;
  }

  if (spec.namedData !== undefined) {
    const name = utf16Name(spec.namedData.name);
    const value = spec.namedData.data;
    const nameOffset = 24;
    const valueOffset = align8(24 + name.length);
    const attrLen = align8(valueOffset + value.length);
    record.writeUInt32LE(0x80, pos);
    record.writeUInt32LE(attrLen, pos + 4);
    record.writeUInt8(0, pos + 8);
    record.writeUInt8(name.length / 2, pos + 9);
    record.writeUInt16LE(nameOffset, pos + 10);
    name.copy(record, pos + nameOffset);
    record.writeUInt32LE(value.length, pos + 16);
    record.writeUInt16LE(valueOffset, pos + 20);
    value.copy(record, pos + valueOffset);
    pos += attrLen;
  }

  record.writeUInt32LE(0xffffffff, pos);

  for (let i = 0; i < RECORD_SIZE / SECTOR_SIZE; i++) {
    const tail = i * SECTOR_SIZE + SECTOR_SIZE - 2;
    record.writeUInt16LE(record.readUInt16LE(tail), usaOffset + 2 + i * 2);
    record.writeUInt16LE(0xaaaa, tail);
  }
  if (spec.breakFixupSector !== undefined) {
    const tail = spec.breakFixupSector * SECTOR_SIZE + SECTOR_SIZE - 2;
    record.writeUInt16LE(0xbbbb, tail);
  }
  return record;
}

function align8(n: number): number {
  return (n + 7) & ~7;
}

/** Build an allocation bitmap buffer; `used` lists in-use cluster numbers. */
export function buildBitmap(clusterCount: number, used: number[]): Buffer {
  const buf = Buffer.alloc(Math.ceil(clusterCount / 8));
  for (const c of used) {
    buf[c >> 3] = buf[c >> 3]! | (1 << (c & 7));
  }
  return buf;
}

/** Deterministic byte pattern for a cluster, independent per cluster number. */
export function clusterPattern(cluster: number, length = CLUSTER_SIZE): Buffer {
  const buf = Buffer.alloc(length);
  let state = (cluster * 2654435761) >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    buf[i] = state & 0xff;
  }
  return buf;
}
