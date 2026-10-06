import type { AuditRecord } from "./types.js";

const HEADER_LEN = 8 + 8 + 4 + 4;

/**
 * Canonical binary encoding of a record:
 *   seq:        uint64 BE
 *   timestamp:  int64  BE (signed, milliseconds)
 *   prevState:  uint32 BE byte length + UTF-8 bytes
 *   nextState:  uint32 BE byte length + UTF-8 bytes
 * Length prefixes make the encoding unambiguous (no delimiter collisions).
 */
export function encodeRecord(record: AuditRecord): Buffer {
  const prev = Buffer.from(record.prevState, "utf8");
  const next = Buffer.from(record.nextState, "utf8");
  const out = Buffer.alloc(HEADER_LEN + prev.length + next.length);
  out.writeBigUInt64BE(BigInt(record.seq), 0);
  out.writeBigInt64BE(BigInt(record.timestampMs), 8);
  out.writeUInt32BE(prev.length, 16);
  out.writeUInt32BE(next.length, 20);
  prev.copy(out, HEADER_LEN);
  next.copy(out, HEADER_LEN + prev.length);
  return out;
}
