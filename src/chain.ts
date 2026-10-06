import { createHash } from "node:crypto";
import { encodeRecord } from "./encoding.js";
import type { AuditRecord } from "./types.js";

function sha256(...parts: Buffer[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

const GENESIS = sha256(Buffer.from("AUDIT-GENESIS-V1", "utf8"));
const CONTENT_DOMAIN = Buffer.from("AUDIT-CONTENT-V1", "utf8");
const CHAIN_DOMAIN = Buffer.from("AUDIT-CHAIN-V1", "utf8");

/** Chain hash of the empty prefix (before record 1). */
export function genesisHash(): Buffer {
  return Buffer.from(GENESIS);
}

/**
 * Content hash of a record: commits to seq, timestamp and both state
 * texts. Revealing this hash alone does not reveal the state texts.
 */
export function contentHash(record: AuditRecord): Buffer {
  return sha256(CONTENT_DOMAIN, encodeRecord(record));
}

/**
 * Chain hash of a position, given the previous chain hash, the record's
 * seq/timestamp and its content hash. Timestamps are bound by the chain,
 * so an export can prove a hidden record's timestamp without revealing
 * its content.
 */
export function chainHash(
  prevChainHash: Buffer,
  seq: number,
  timestampMs: number,
  recordContentHash: Buffer,
): Buffer {
  const meta = Buffer.alloc(16);
  meta.writeBigUInt64BE(BigInt(seq), 0);
  meta.writeBigInt64BE(BigInt(timestampMs), 8);
  return sha256(CHAIN_DOMAIN, prevChainHash, meta, recordContentHash);
}

/** Convenience: chain hash of a fully known record. */
export function chainHashOfRecord(prevChainHash: Buffer, record: AuditRecord): Buffer {
  return chainHash(prevChainHash, record.seq, record.timestampMs, contentHash(record));
}
