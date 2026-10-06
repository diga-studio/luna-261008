/**
 * VaultTerm 会话核心：open/append/seal/read。
 *
 * 存储布局（dir 下）：
 * - vault.log       追加式日志，每行一条记录（事件或封存），哈希链串联。
 * - vault.meta.json 恢复元数据：sessionId、记录数、链头哈希、封存状态。
 *
 * 恢复时完整重放并验证日志：GCM 认证（AAD 绑定 sessionId/seq/eventId/前序哈希）、
 * 序号连续性、哈希链、元数据一致性。任何篡改、缺失或跨会话替换都会拒绝打开。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  KEY_BYTES,
  decrypt,
  encrypt,
  randomNonce,
  sha256,
} from "./crypto";
import {
  EventRecord,
  LogRecord,
  computeHash,
  encodeRecord,
  genesisHash,
  parseLine,
} from "./logfile";
import type { ReadResult, VaultOpenOptions, VaultRecord } from "./types";

export class VaultError extends Error {}
export class VaultIntegrityError extends VaultError {}
export class VaultConflictError extends VaultError {}
export class VaultSealedError extends VaultError {}
export class VaultUsageError extends VaultError {}

const LOG_FILE = "vault.log";
const META_FILE = "vault.meta.json";

interface Meta {
  sessionId: string;
  count: number;
  lastHash: string;
  sealed: boolean;
}

interface VerifiedState {
  records: VaultRecord[];
  contentHashByEventId: Map<string, { seq: number; contentHash: Buffer }>;
  usedNonces: Set<string>;
  count: number;
  lastHash: Buffer;
  sealed: boolean;
}

function aadFor(sessionId: string, seq: number, eventId: string, prev: Buffer): Buffer {
  return Buffer.from(
    JSON.stringify(["vaultterm-aad", sessionId, seq, eventId, prev.toString("base64")]),
    "utf8",
  );
}

export class Vault {
  private readonly dir: string;
  private readonly key: Buffer;
  private readonly sessionId: string;
  private readonly logPath: string;
  private readonly metaPath: string;
  private readonly logFd: number;
  private contentHashByEventId: Map<string, { seq: number; contentHash: Buffer }>;
  private usedNonces: Set<string>;
  private count: number;
  private lastHash: Buffer;
  private sealed: boolean;

  private constructor(options: VaultOpenOptions, state: VerifiedState, logFd: number) {
    this.dir = options.dir;
    this.key = Buffer.from(options.key);
    this.sessionId = options.sessionId;
    this.logPath = path.join(this.dir, LOG_FILE);
    this.metaPath = path.join(this.dir, META_FILE);
    this.logFd = logFd;
    this.contentHashByEventId = state.contentHashByEventId;
    this.usedNonces = state.usedNonces;
    this.count = state.count;
    this.lastHash = state.lastHash;
    this.sealed = state.sealed;
  }

  static open(options: VaultOpenOptions): Vault {
    const { dir, key, sessionId } = options;
    if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
      throw new VaultUsageError("key must be a 32-byte Buffer");
    }
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new VaultUsageError("sessionId must be a non-empty string");
    }
    fs.mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, LOG_FILE);
    const metaPath = path.join(dir, META_FILE);
    const logExists = fs.existsSync(logPath);
    const metaExists = fs.existsSync(metaPath);
    if (logExists !== metaExists) {
      throw new VaultIntegrityError("committed data is missing: log and metadata must both exist");
    }
    if (!logExists) {
      const genesis = genesisHash(sessionId);
      fs.writeFileSync(logPath, "");
      writeMeta(metaPath, {
        sessionId,
        count: 0,
        lastHash: genesis.toString("base64"),
        sealed: false,
      });
    }
    const state = verifyFromDisk(logPath, metaPath, key, sessionId);
    const logFd = fs.openSync(logPath, "a");
    return new Vault(options, state, logFd);
  }

  append(eventId: string, bytes: Buffer): number {
    if (typeof eventId !== "string" || eventId.length === 0) {
      throw new VaultUsageError("eventId must be a non-empty string");
    }
    if (!Buffer.isBuffer(bytes)) {
      throw new VaultUsageError("bytes must be a Buffer");
    }
    const known = this.contentHashByEventId.get(eventId);
    if (known !== undefined) {
      if (sha256(bytes).equals(known.contentHash)) {
        return known.seq;
      }
      throw new VaultConflictError(`eventId "${eventId}" already committed with different bytes`);
    }
    if (this.sealed) {
      throw new VaultSealedError("vault is sealed: new eventIds are rejected");
    }
    const seq = this.count + 1;
    let nonce = randomNonce();
    while (this.usedNonces.has(nonce.toString("base64"))) {
      nonce = randomNonce();
    }
    const aad = aadFor(this.sessionId, seq, eventId, this.lastHash);
    const sealedBox = encrypt(this.key, aad, bytes, nonce);
    const record: EventRecord = {
      type: "event",
      seq,
      eventId,
      nonce: sealedBox.nonce,
      ciphertext: sealedBox.data,
      tag: sealedBox.tag,
      prev: this.lastHash,
      hash: Buffer.alloc(0),
    };
    record.hash = computeHash(record);
    this.commitRecord(record, false);
    this.contentHashByEventId.set(eventId, { seq, contentHash: sha256(bytes) });
    this.usedNonces.add(nonce.toString("base64"));
    return seq;
  }

  seal(): void {
    if (this.sealed) return;
    const record: LogRecord = {
      type: "seal",
      seq: this.count + 1,
      prev: this.lastHash,
      hash: Buffer.alloc(0),
    };
    record.hash = computeHash(record);
    this.commitRecord(record, true);
  }

  read(): ReadResult {
    const state = verifyFromDisk(this.logPath, this.metaPath, this.key, this.sessionId);
    return { sessionId: this.sessionId, sealed: state.sealed, records: state.records };
  }

  private commitRecord(record: LogRecord, sealed: boolean): void {
    const line = encodeRecord(record) + "\n";
    fs.writeSync(this.logFd, line);
    fs.fsyncSync(this.logFd);
    this.count = record.seq;
    this.lastHash = record.hash;
    this.sealed = sealed;
    writeMeta(this.metaPath, {
      sessionId: this.sessionId,
      count: this.count,
      lastHash: this.lastHash.toString("base64"),
      sealed: this.sealed,
    });
  }
}

function writeMeta(metaPath: string, meta: Meta): void {
  const tmpPath = metaPath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(meta, null, 2) + "\n");
  fs.renameSync(tmpPath, metaPath);
}

function readMeta(metaPath: string): Meta {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch {
    throw new VaultIntegrityError("metadata is unreadable");
  }
  const meta = raw as Meta;
  if (
    typeof meta?.sessionId !== "string" ||
    typeof meta?.count !== "number" ||
    typeof meta?.lastHash !== "string" ||
    typeof meta?.sealed !== "boolean"
  ) {
    throw new VaultIntegrityError("metadata is malformed");
  }
  return meta;
}

function verifyFromDisk(
  logPath: string,
  metaPath: string,
  key: Buffer,
  sessionId: string,
): VerifiedState {
  const meta = readMeta(metaPath);
  if (meta.sessionId !== sessionId) {
    throw new VaultIntegrityError("metadata belongs to a different session");
  }
  const content = fs.readFileSync(logPath, "utf8");
  const lines = content.length === 0 ? [] : content.split("\n").filter((line) => line.length > 0);
  if (content.length > 0 && !content.endsWith("\n")) {
    throw new VaultIntegrityError("log ends with a partial record");
  }
  if (lines.length !== meta.count) {
    throw new VaultIntegrityError("log record count does not match metadata");
  }
  const records: VaultRecord[] = [];
  const contentHashByEventId = new Map<string, { seq: number; contentHash: Buffer }>();
  const usedNonces = new Set<string>();
  let prev = genesisHash(sessionId);
  let sealed = false;
  for (const [index, line] of lines.entries()) {
    let record: LogRecord;
    try {
      record = parseLine(line);
    } catch (err) {
      throw new VaultIntegrityError(`log record ${index + 1} is malformed: ${(err as Error).message}`);
    }
    const expectedSeq = index + 1;
    if (record.seq !== expectedSeq) {
      throw new VaultIntegrityError(`log record ${index + 1} has unexpected sequence number`);
    }
    if (!record.prev.equals(prev)) {
      throw new VaultIntegrityError(`log record ${index + 1} breaks the hash chain`);
    }
    if (!computeHash(record).equals(record.hash)) {
      throw new VaultIntegrityError(`log record ${index + 1} hash mismatch`);
    }
    if (sealed) {
      throw new VaultIntegrityError("log contains records after the seal");
    }
    if (record.type === "seal") {
      sealed = true;
    } else {
      if (contentHashByEventId.has(record.eventId)) {
        throw new VaultIntegrityError(`duplicate eventId "${record.eventId}" in log`);
      }
      const nonceKey = record.nonce.toString("base64");
      if (usedNonces.has(nonceKey)) {
        throw new VaultIntegrityError(`log record ${index + 1} reuses a nonce`);
      }
      const aad = aadFor(sessionId, record.seq, record.eventId, record.prev);
      let plaintext: Buffer;
      try {
        plaintext = decrypt(key, aad, {
          nonce: record.nonce,
          data: record.ciphertext,
          tag: record.tag,
        });
      } catch {
        throw new VaultIntegrityError(`log record ${index + 1} failed authentication`);
      }
      usedNonces.add(nonceKey);
      contentHashByEventId.set(record.eventId, {
        seq: record.seq,
        contentHash: sha256(plaintext),
      });
      records.push({ seq: record.seq, eventId: record.eventId, bytes: plaintext });
    }
    prev = record.hash;
  }
  if (!prev.equals(Buffer.from(meta.lastHash, "base64"))) {
    throw new VaultIntegrityError("log head hash does not match metadata");
  }
  if (sealed !== meta.sealed) {
    throw new VaultIntegrityError("seal state does not match metadata");
  }
  return { records, contentHashByEventId, usedNonces, count: lines.length, lastHash: prev, sealed };
}
