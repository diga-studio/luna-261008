/**
 * Hashing primitives for the audit log.
 *
 * Leaf and inner-node hashes follow the domain-separation scheme of
 * RFC 6962 (0x00 prefix for leaves, 0x01 for inner nodes) so that a
 * leaf can never be confused with an inner node.
 */
import { createHash } from "node:crypto";

/** A single audit record as committed to by the Merkle tree. */
export interface RecordPayload {
  /** 1-based consecutive sequence number assigned by the module. */
  seq: number;
  /** Integer millisecond timestamp, non-decreasing in append order. */
  timestampMs: number;
  /** UTF-8 text describing the state before the operation. */
  before: string;
  /** UTF-8 text describing the state after the operation. */
  after: string;
}

/** Compute the leaf hash committing to a full record. */
export function leafHash(record: RecordPayload): Buffer {
  const before = Buffer.from(record.before, "utf8");
  const after = Buffer.from(record.after, "utf8");
  const header = Buffer.alloc(1 + 8 + 8 + 4 + 4);
  let offset = 0;
  header.writeUInt8(0x00, offset);
  offset += 1;
  header.writeBigInt64BE(BigInt(record.seq), offset);
  offset += 8;
  header.writeBigInt64BE(BigInt(record.timestampMs), offset);
  offset += 8;
  header.writeUInt32BE(before.length, offset);
  offset += 4;
  header.writeUInt32BE(after.length, offset);
  return createHash("sha256")
    .update(header)
    .update(before)
    .update(after)
    .digest();
}

/** Compute the inner-node hash of two child hashes. */
export function innerHash(left: Buffer, right: Buffer): Buffer {
  return createHash("sha256")
    .update(Buffer.from([0x01]))
    .update(left)
    .update(right)
    .digest();
}

/**
 * Merkle Tree Hash (RFC 6962 section 2.1) of `leaves`.
 * The empty tree hashes to SHA-256 of the empty string.
 */
export function merkleTreeHash(leaves: Buffer[]): Buffer {
  if (leaves.length === 0) {
    return createHash("sha256").update(Buffer.alloc(0)).digest();
  }
  if (leaves.length === 1) {
    return leaves[0];
  }
  // Largest power of two strictly smaller than leaves.length.
  let split = 1;
  while (split * 2 < leaves.length) {
    split *= 2;
  }
  return innerHash(
    merkleTreeHash(leaves.slice(0, split)),
    merkleTreeHash(leaves.slice(split)),
  );
}
