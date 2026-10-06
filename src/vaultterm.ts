import { randomBytes, createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  fsyncSync,
  writeSync,
  closeSync,
  type PathLike,
} from "node:fs";
import { join } from "node:path";
import { VaultTermError } from "./errors";
import { encrypt, decrypt } from "./crypto";
import {
  decodeLog,
  encodeRecord,
  genesisHash,
  recordHash,
  type LogRecord,
} from "./format";
import {
  loadMetadata,
  saveMetadata,
  type SessionMetadata,
} from "./metadata";
import type { AuditRecord, VaultTermSession } from "./types";

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const NONCE_SIZE = 12;
const SALT_SIZE = 4;

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function lengthPrefixed(s: string): Buffer {
  const body = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  return Buffer.concat([len, body]);
}

/** AAD binding a ciphertext to its session, sequence number, kind and eventId. */
function aadFor(sessionId: string, type: "event" | "seal", seq: number, eventId: string): Buffer {
  const seqBuf = Buffer.alloc(8);
  seqBuf.writeBigUInt64BE(BigInt(seq), 0);
  return Buffer.concat([
    lengthPrefixed("vaultterm:aad:v1"),
    lengthPrefixed(sessionId),
    lengthPrefixed(type),
    seqBuf,
    lengthPrefixed(eventId),
  ]);
}

/** Derive the unique nonce for a record: per-session salt || big-endian seq. */
function nonceFor(salt: Uint8Array, seq: number): Uint8Array {
  const nonce = Buffer.alloc(NONCE_SIZE);
  nonce.set(salt, 0);
  nonce.writeBigUInt64BE(BigInt(seq), SALT_SIZE);
  return nonce;
}

function logPath(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}.log`);
}

interface VerifiedState {
  records: LogRecord[];
  decrypted: AuditRecord[];
}

/**
 * Re-read the log from disk and verify it end to end against the recovery
 * metadata: hash chain (covers sessionId, seq, eventId, ciphertext, seal
 * state), record count, head hash, seal consistency, GCM authentication of
 * every record, and the dedup history. Throws INTEGRITY_FAILURE on any
 * modification, deletion, reordering, truncation or cross-session swap.
 */
function verifyAndDecrypt(
  dir: string,
  key: Uint8Array,
  meta: SessionMetadata
): VerifiedState {
  const path = logPath(dir, meta.sessionId);
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    if (meta.recordCount === 0 && !existsSync(path)) {
      return { records: [], decrypted: [] };
    }
    throw new VaultTermError("INTEGRITY_FAILURE", "committed log data is missing");
  }
  const records = decodeLog(body);

  if (records.length !== meta.recordCount) {
    throw new VaultTermError(
      "INTEGRITY_FAILURE",
      "log record count does not match recovery metadata"
    );
  }

  const decrypted: AuditRecord[] = [];
  const seenEventIds = new Set<string>();
  let prev = genesisHash(meta.sessionId);
  let sealCount = 0;

  records.forEach((rec, i) => {
    const expectedSeq = i + 1;
    if (rec.seq !== expectedSeq) {
      throw new VaultTermError("INTEGRITY_FAILURE", "log sequence numbers are not contiguous");
    }
    if (rec.prev !== prev) {
      throw new VaultTermError("INTEGRITY_FAILURE", "log hash chain is broken");
    }
    if (rec.hash !== recordHash(meta.sessionId, rec)) {
      throw new VaultTermError("INTEGRITY_FAILURE", "log record hash mismatch");
    }

    const aad = aadFor(meta.sessionId, rec.type, rec.seq, rec.eventId);
    const plaintext = decrypt(key, aad, {
      nonce: Buffer.from(rec.nonce, "hex"),
      ciphertext: Buffer.from(rec.ct, "hex"),
      tag: Buffer.from(rec.tag, "hex"),
    });

    if (rec.type === "seal") {
      sealCount += 1;
      if (i !== records.length - 1 || rec.eventId !== "" || plaintext.length !== 0) {
        throw new VaultTermError("INTEGRITY_FAILURE", "misplaced seal record");
      }
    } else {
      if (rec.eventId.length === 0 || seenEventIds.has(rec.eventId)) {
        throw new VaultTermError("INTEGRITY_FAILURE", "duplicate or empty eventId in log");
      }
      seenEventIds.add(rec.eventId);
      const entry = meta.events[rec.eventId];
      if (!entry || entry.seq !== rec.seq || entry.contentHash !== sha256Hex(plaintext)) {
        throw new VaultTermError(
          "INTEGRITY_FAILURE",
          "log does not match dedup history in recovery metadata"
        );
      }
      decrypted.push({ seq: rec.seq, eventId: rec.eventId, bytes: plaintext });
    }
    prev = rec.hash;
  });

  if (records.length > 0 && prev !== meta.headHash) {
    throw new VaultTermError("INTEGRITY_FAILURE", "log head hash does not match recovery metadata");
  }
  if (records.length === 0 && meta.headHash !== genesisHash(meta.sessionId)) {
    throw new VaultTermError("INTEGRITY_FAILURE", "recovery metadata head hash is invalid");
  }

  const logSealed = sealCount > 0;
  if (sealCount > 1 || logSealed !== meta.sealed) {
    throw new VaultTermError("INTEGRITY_FAILURE", "seal state mismatch between log and metadata");
  }
  if (seenEventIds.size !== Object.keys(meta.events).length) {
    throw new VaultTermError("INTEGRITY_FAILURE", "dedup history does not match log");
  }

  return { records, decrypted };
}

class VaultTerm implements VaultTermSession {
  private readonly dir: string;
  private readonly key: Uint8Array;
  private readonly sessionId: string;
  private readonly salt: Uint8Array;
  private meta: SessionMetadata;
  private fd: number | null = null;

  constructor(dir: string, key: Uint8Array, sessionId: string, meta: SessionMetadata) {
    this.dir = dir;
    this.key = key;
    this.sessionId = sessionId;
    this.meta = meta;
    this.salt = Buffer.from(meta.nonceSalt, "hex");
  }

  get sealed(): boolean {
    return this.meta.sealed;
  }

  private appendRecord(rec: LogRecord): void {
    if (this.fd === null) {
      this.fd = openSync(logPath(this.dir, this.sessionId) as PathLike, "a");
    }
    writeSync(this.fd, encodeRecord(rec));
    fsyncSync(this.fd);
    this.meta.recordCount += 1;
    this.meta.headHash = rec.hash;
    saveMetadata(this.dir, this.meta);
  }

  private buildRecord(
    type: "event" | "seal",
    eventId: string,
    plaintext: Uint8Array
  ): LogRecord {
    const seq = this.meta.recordCount + 1;
    const nonce = nonceFor(this.salt, seq);
    const aad = aadFor(this.sessionId, type, seq, eventId);
    const box = encrypt(this.key, nonce, aad, plaintext);
    const base = {
      type,
      seq,
      eventId,
      nonce: Buffer.from(box.nonce).toString("hex"),
      ct: Buffer.from(box.ciphertext).toString("hex"),
      tag: Buffer.from(box.tag).toString("hex"),
      prev: this.meta.headHash,
    };
    return { ...base, hash: recordHash(this.sessionId, base) };
  }

  append(eventId: string, bytes: Uint8Array): number {
    if (typeof eventId !== "string" || eventId.length === 0) {
      throw new VaultTermError("INVALID_ARGUMENT", "eventId must be a non-empty string");
    }
    if (!(bytes instanceof Uint8Array)) {
      throw new VaultTermError("INVALID_ARGUMENT", "bytes must be a Uint8Array");
    }
    const contentHash = sha256Hex(bytes);
    const existing = this.meta.events[eventId];
    if (existing !== undefined) {
      if (existing.contentHash === contentHash) {
        return existing.seq;
      }
      throw new VaultTermError(
        "EVENT_CONFLICT",
        `eventId "${eventId}" was already committed with different content`
      );
    }
    if (this.meta.sealed) {
      throw new VaultTermError("SESSION_SEALED", "session is sealed; new events are rejected");
    }

    const rec = this.buildRecord("event", eventId, bytes);
    this.meta.events[eventId] = { seq: rec.seq, contentHash };
    this.appendRecord(rec);
    return rec.seq;
  }

  seal(): void {
    if (this.meta.sealed) return;
    const rec = this.buildRecord("seal", "", new Uint8Array(0));
    this.meta.sealed = true;
    this.appendRecord(rec);
  }

  read(): AuditRecord[] {
    const fresh = loadMetadata(this.dir, this.sessionId);
    if (fresh === null) {
      throw new VaultTermError("INTEGRITY_FAILURE", "recovery metadata is missing");
    }
    const { decrypted } = verifyAndDecrypt(this.dir, this.key, fresh);
    return decrypted;
  }

  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}

/**
 * Open (or create on first use) the audit session `sessionId` in directory
 * `dir`. `key` must be exactly 32 bytes and is used only for this session.
 */
export function open(dir: string, key: Uint8Array, sessionId: string): VaultTermSession {
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    throw new VaultTermError("INVALID_KEY", "key must be exactly 32 bytes");
  }
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new VaultTermError(
      "INVALID_ARGUMENT",
      "sessionId must be 1-128 chars of [A-Za-z0-9_-]"
    );
  }
  mkdirSync(dir, { recursive: true });

  let meta = loadMetadata(dir, sessionId);
  if (meta === null) {
    if (existsSync(logPath(dir, sessionId))) {
      throw new VaultTermError(
        "INTEGRITY_FAILURE",
        "log exists without recovery metadata; refusing to recover"
      );
    }
    meta = {
      version: 1,
      sessionId,
      nonceSalt: randomBytes(SALT_SIZE).toString("hex"),
      recordCount: 0,
      headHash: genesisHash(sessionId),
      sealed: false,
      events: Object.create(null) as SessionMetadata["events"],
    };
    saveMetadata(dir, meta);
    return new VaultTerm(dir, key, sessionId, meta);
  }

  // Recovery: refuse unless the committed log verifies end to end.
  verifyAndDecrypt(dir, key, meta);
  return new VaultTerm(dir, key, sessionId, meta);
}

export type { AuditRecord, VaultTermSession };
