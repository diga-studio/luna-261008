import { CorruptRecordError } from "./errors.js";
import { RECORD_SIZE, SECTOR_SIZE, SECTORS_PER_RECORD } from "./types.js";

/**
 * 按 NTFS 扇区尾保护信息（Update Sequence Array）就地还原记录。
 * 记录必须完整（恰好 RECORD_SIZE 字节）、签名为 "FILE"、
 * 每个扇区末尾 2 字节必须等于保护签名，否则抛 CorruptRecordError。
 */
export function applyFixup(record: Buffer): void {
  if (record.length !== RECORD_SIZE) {
    throw new CorruptRecordError(
      `record truncated: ${record.length} bytes, expected ${RECORD_SIZE}`,
    );
  }
  if (record.toString("ascii", 0, 4) !== "FILE") {
    throw new CorruptRecordError("bad record signature");
  }
  const usaOffset = record.readUInt16LE(0x04);
  const usaCount = record.readUInt16LE(0x06);
  if (usaCount !== SECTORS_PER_RECORD + 1) {
    throw new CorruptRecordError(`unexpected update sequence count: ${usaCount}`);
  }
  if (usaOffset < 0x04 || usaOffset + usaCount * 2 > RECORD_SIZE) {
    throw new CorruptRecordError("update sequence array outside record");
  }
  const signature = record.readUInt16LE(usaOffset);
  for (let sector = 0; sector < SECTORS_PER_RECORD; sector++) {
    const tail = (sector + 1) * SECTOR_SIZE - 2;
    if (record.readUInt16LE(tail) !== signature) {
      throw new CorruptRecordError(
        `fixup mismatch at sector ${sector} (offset ${tail})`,
      );
    }
    record.writeUInt16LE(record.readUInt16LE(usaOffset + 2 + sector * 2), tail);
  }
}
