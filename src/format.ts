import { createHash } from "node:crypto";
import { VaultTermError } from "./errors";

/** On-disk record kinds in the append-only log. */
export type LogRecordType = "event" | "seal";

/** One line in the append-only log file (JSON-encoded). */
export interface LogRecord {
  type: LogRecordType;
  seq: number;
  /** Empty string for seal records. */
  eventId: string;
  /** Hex-encoded 12-byte GCM nonce. */
  nonce: string;
  /** Hex-encoded ciphertext (empty for seal records). */
  ct: string;
  /** Hex-encoded 16-byte GCM auth tag. */
  tag: string;
  /** Hex-encoded hash of the previous record (genesis for the first). */
  prev: string;
  /** Hex-encoded hash of this record. */
  hash: string;
}

function sha256Hex(chunks: Uint8Array[]): string {
  const h = createHash("sha256");
  for (const c of chunks) h.update(c);
  return h.digest("hex");
}

function lengthPrefixed(s: string): Uint8Array {
  const body = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  return Buffer.concat([len, body]);
}

/** Genesis hash chaining value for a session. */
export function genesisHash(sessionId: string): string {
  return sha256Hex([lengthPrefixed("vaultterm:genesis:v1"), lengthPrefixed(sessionId)]);
}

/** Compute the chain hash of a record (without its `hash` field). */
export function recordHash(sessionId: string, rec: Omit<LogRecord, "hash">): string {
  const seq = Buffer.alloc(8);
  seq.writeBigUInt64BE(BigInt(rec.seq), 0);
  return sha256Hex([
    lengthPrefixed("vaultterm:record:v1"),
    lengthPrefixed(sessionId),
    lengthPrefixed(rec.type),
    seq,
    lengthPrefixed(rec.eventId),
    lengthPrefixed(rec.nonce),
    lengthPrefixed(rec.ct),
    lengthPrefixed(rec.tag),
    lengthPrefixed(rec.prev),
  ]);
}

/** Serialize a record to a single log line. */
export function encodeRecord(rec: LogRecord): string {
  return JSON.stringify(rec) + "\n";
}

const HEX_RE = /^[0-9a-f]*$/;

function assertHexField(value: unknown, name: string, len?: number): asserts value is string {
  if (typeof value !== "string" || !HEX_RE.test(value) || (len !== undefined && value.length !== len)) {
    throw new VaultTermError("INTEGRITY_FAILURE", `malformed log record: bad ${name}`);
  }
}

/** Parse a log file body into records; throws on malformed input. */
export function decodeLog(body: string): LogRecord[] {
  if (body.length === 0) return [];
  const lines = body.split("\n");
  if (lines[lines.length - 1] !== "") {
    throw new VaultTermError("INTEGRITY_FAILURE", "log file truncated mid-line");
  }
  lines.pop();
  return lines.map((line, i) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new VaultTermError("INTEGRITY_FAILURE", `malformed log record at line ${i + 1}`);
    }
    const rec = parsed as Record<string, unknown>;
    if (rec.type !== "event" && rec.type !== "seal") {
      throw new VaultTermError("INTEGRITY_FAILURE", `bad record type at line ${i + 1}`);
    }
    if (typeof rec.seq !== "number" || !Number.isInteger(rec.seq) || rec.seq < 1) {
      throw new VaultTermError("INTEGRITY_FAILURE", `bad seq at line ${i + 1}`);
    }
    if (typeof rec.eventId !== "string") {
      throw new VaultTermError("INTEGRITY_FAILURE", `bad eventId at line ${i + 1}`);
    }
    assertHexField(rec.nonce, "nonce", 24);
    assertHexField(rec.ct, "ct");
    assertHexField(rec.tag, "tag", 32);
    assertHexField(rec.prev, "prev", 64);
    assertHexField(rec.hash, "hash", 64);
    return rec as unknown as LogRecord;
  });
}
