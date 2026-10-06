import { RecoveryError } from "./errors.js";
import { decodeRunList } from "./runlist.js";
import {
  CLUSTER_SIZE,
  RECORD_SIZE,
  SECTOR_SIZE,
  type DataLayout,
  type DataRun,
} from "./types.js";

export interface ParsedRecord {
  /** True when the FILE record header marks the record in use. */
  inUse: boolean;
  /** Layout of the unnamed $DATA attribute. */
  data: DataLayout;
}

const ATTR_TYPE_ATTRIBUTE_LIST = 0x20;
const ATTR_TYPE_DATA = 0x80;
const ATTR_TYPE_END = 0xffffffff;
const ATTR_FLAG_COMPRESSED = 0x0001;
const ATTR_FLAG_ENCRYPTED = 0x4000;

function applyFixup(record: Buffer): Buffer {
  if (record.length !== RECORD_SIZE) {
    throw new RecoveryError("CORRUPT_RECORD", `record truncated: ${record.length} bytes`);
  }
  if (record.toString("ascii", 0, 4) !== "FILE") {
    throw new RecoveryError("CORRUPT_RECORD", "bad record signature");
  }
  const usaOffset = record.readUInt16LE(0x04);
  const usaCount = record.readUInt16LE(0x06);
  const sectors = RECORD_SIZE / SECTOR_SIZE;
  if (usaCount !== sectors + 1 || usaOffset + usaCount * 2 > RECORD_SIZE) {
    throw new RecoveryError("CORRUPT_RECORD", "invalid fixup array");
  }
  const fixed = Buffer.from(record);
  const fixupValue = fixed.readUInt16LE(usaOffset);
  for (let i = 0; i < sectors; i++) {
    const tail = i * SECTOR_SIZE + SECTOR_SIZE - 2;
    if (fixed.readUInt16LE(tail) !== fixupValue) {
      throw new RecoveryError("CORRUPT_RECORD", `sector ${i} fixup mismatch`);
    }
    fixed.writeUInt16LE(fixed.readUInt16LE(usaOffset + 2 + i * 2), tail);
  }
  return fixed;
}

function readI64(buf: Buffer, pos: number, what: string): number {
  const value = buf.readBigInt64LE(pos);
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new RecoveryError("CORRUPT_ATTRIBUTE", `${what} out of range`);
  }
  return n;
}

function parseDataAttribute(
  record: Buffer,
  attrStart: number,
  attrLength: number,
  volumeClusters: number,
): DataLayout {
  const nonResident = record.readUInt8(attrStart + 8) !== 0;
  const flags = record.readUInt16LE(attrStart + 12);
  if ((flags & ATTR_FLAG_COMPRESSED) !== 0) {
    throw new RecoveryError("UNSUPPORTED", "compressed $DATA is not supported");
  }
  if ((flags & ATTR_FLAG_ENCRYPTED) !== 0) {
    throw new RecoveryError("UNSUPPORTED", "encrypted $DATA is not supported");
  }
  if (!nonResident) {
    if (attrLength < 24) {
      throw new RecoveryError("CORRUPT_ATTRIBUTE", "resident $DATA header truncated");
    }
    const valueLength = record.readUInt32LE(attrStart + 16);
    const valueOffset = record.readUInt16LE(attrStart + 20);
    if (valueOffset > attrLength || valueLength > attrLength - valueOffset) {
      throw new RecoveryError("CORRUPT_ATTRIBUTE", "resident $DATA value out of bounds");
    }
    const data = Buffer.from(
      record.subarray(attrStart + valueOffset, attrStart + valueOffset + valueLength),
    );
    return { resident: true, logicalSize: valueLength, data };
  }
  if (attrLength < 64) {
    throw new RecoveryError("CORRUPT_ATTRIBUTE", "non-resident $DATA header truncated");
  }
  const startVcn = readI64(record, attrStart + 16, "start VCN");
  const lastVcn = readI64(record, attrStart + 24, "last VCN");
  const runlistOffset = record.readUInt16LE(attrStart + 32);
  const compressionUnit = record.readUInt16LE(attrStart + 34);
  const realSize = readI64(record, attrStart + 48, "real size");
  const initializedSize = readI64(record, attrStart + 56, "initialized size");
  if (compressionUnit !== 0) {
    throw new RecoveryError("UNSUPPORTED", "compressed $DATA is not supported");
  }
  if (startVcn !== 0) {
    throw new RecoveryError(
      "UNSUPPORTED",
      `$DATA starts at VCN ${startVcn}; extension records are not supported`,
    );
  }
  if (lastVcn < 0 || realSize < 0 || initializedSize < 0 || initializedSize > realSize) {
    throw new RecoveryError("CORRUPT_ATTRIBUTE", "invalid $DATA sizes");
  }
  const expectedClusters = lastVcn + 1;
  if (realSize > expectedClusters * CLUSTER_SIZE || initializedSize > expectedClusters * CLUSTER_SIZE) {
    throw new RecoveryError("CORRUPT_ATTRIBUTE", "$DATA sizes exceed declared runs");
  }
  if (runlistOffset >= attrLength) {
    throw new RecoveryError("CORRUPT_ATTRIBUTE", "runlist offset out of bounds");
  }
  const runlistBuf = record.subarray(attrStart + runlistOffset, attrStart + attrLength);
  const runs: DataRun[] = decodeRunList(runlistBuf, expectedClusters);
  for (const run of runs) {
    if (run.lcn === null) {
      continue;
    }
    if (run.lcn < 0 || run.lcn + run.lengthClusters > volumeClusters) {
      throw new RecoveryError(
        "OUT_OF_BOUNDS",
        `run at LCN ${run.lcn} length ${run.lengthClusters} exceeds volume`,
      );
    }
  }
  return { resident: false, logicalSize: realSize, initializedSize, runs };
}

/**
 * Validate and parse one 1024-byte $MFT record: sector fixup, attribute walk,
 * unnamed $DATA extraction. Throws RecoveryError on any corruption.
 */
export function parseRecord(rawRecord: Buffer, volumeClusters: number): ParsedRecord {
  const record = applyFixup(rawRecord);
  const firstAttrOffset = record.readUInt16LE(0x14);
  const flags = record.readUInt16LE(0x16);
  const inUse = (flags & 0x0001) !== 0;
  if (firstAttrOffset > RECORD_SIZE - 8) {
    throw new RecoveryError("CORRUPT_RECORD", "first attribute offset out of bounds");
  }
  let data: DataLayout | null = null;
  let pos = firstAttrOffset;
  for (;;) {
    if (pos + 4 > RECORD_SIZE) {
      throw new RecoveryError("CORRUPT_RECORD", "attribute list truncated");
    }
    const type = record.readUInt32LE(pos);
    if (type === ATTR_TYPE_END) {
      break;
    }
    if (pos + 16 > RECORD_SIZE) {
      throw new RecoveryError("CORRUPT_RECORD", "attribute header truncated");
    }
    const attrLength = record.readUInt32LE(pos + 4);
    if (attrLength < 16 || pos + attrLength > RECORD_SIZE) {
      throw new RecoveryError("CORRUPT_RECORD", "attribute extends past record");
    }
    if (type === ATTR_TYPE_ATTRIBUTE_LIST) {
      throw new RecoveryError("UNSUPPORTED", "attribute list (extension records) not supported");
    }
    if (type === ATTR_TYPE_DATA) {
      const nameLength = record.readUInt8(pos + 9);
      if (nameLength === 0) {
        if (data !== null) {
          throw new RecoveryError(
            "UNSUPPORTED",
            "multiple unnamed $DATA attributes require extension records",
          );
        }
        data = parseDataAttribute(record, pos, attrLength, volumeClusters);
      }
    }
    pos += attrLength;
  }
  if (data === null) {
    throw new RecoveryError("CORRUPT_ATTRIBUTE", "record has no unnamed $DATA attribute");
  }
  return { inUse, data };
}
