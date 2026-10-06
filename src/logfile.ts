/**
 * 追加式日志文件：每行一条 JSON 记录，记录间以 SHA-256 哈希链串联。
 * 事件记录携带 AES-256-GCM 密文；封存记录标记会话永久关闭。
 */

import { sha256 } from "./crypto";

export interface EventRecord {
  type: "event";
  seq: number;
  eventId: string;
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
  prev: Buffer;
  hash: Buffer;
}

export interface SealRecord {
  type: "seal";
  seq: number;
  prev: Buffer;
  hash: Buffer;
}

export type LogRecord = EventRecord | SealRecord;

export function genesisHash(sessionId: string): Buffer {
  return sha256(Buffer.from(`vaultterm/genesis/${sessionId}`, "utf8"));
}

function canonicalFields(record: LogRecord): unknown[] {
  if (record.type === "event") {
    return [
      "event",
      record.seq,
      record.eventId,
      record.nonce.toString("base64"),
      record.ciphertext.toString("base64"),
      record.tag.toString("base64"),
      record.prev.toString("base64"),
    ];
  }
  return ["seal", record.seq, record.prev.toString("base64")];
}

export function computeHash(record: Omit<EventRecord, "hash"> | Omit<SealRecord, "hash">): Buffer {
  const fields = canonicalFields(record as LogRecord);
  return sha256(Buffer.from(JSON.stringify(fields), "utf8"));
}

export function encodeRecord(record: LogRecord): string {
  if (record.type === "event") {
    return JSON.stringify([
      "event",
      record.seq,
      record.eventId,
      record.nonce.toString("base64"),
      record.ciphertext.toString("base64"),
      record.tag.toString("base64"),
      record.prev.toString("base64"),
      record.hash.toString("base64"),
    ]);
  }
  return JSON.stringify([
    "seal",
    record.seq,
    record.prev.toString("base64"),
    record.hash.toString("base64"),
  ]);
}

export function parseLine(line: string): LogRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error("log line is not valid JSON");
  }
  if (!Array.isArray(raw)) throw new Error("log line is not a record array");
  const b64 = (value: unknown): Buffer => {
    if (typeof value !== "string") throw new Error("invalid base64 field");
    const buf = Buffer.from(value, "base64");
    if (buf.toString("base64") !== value) throw new Error("invalid base64 field");
    return buf;
  };
  if (raw[0] === "event") {
    if (raw.length !== 8 || typeof raw[1] !== "number" || typeof raw[2] !== "string") {
      throw new Error("malformed event record");
    }
    const record: Omit<EventRecord, "hash"> = {
      type: "event",
      seq: raw[1],
      eventId: raw[2],
      nonce: b64(raw[3]),
      ciphertext: b64(raw[4]),
      tag: b64(raw[5]),
      prev: b64(raw[6]),
    };
    return { ...record, hash: b64(raw[7]) };
  }
  if (raw[0] === "seal") {
    if (raw.length !== 4 || typeof raw[1] !== "number") {
      throw new Error("malformed seal record");
    }
    const record: Omit<SealRecord, "hash"> = {
      type: "seal",
      seq: raw[1],
      prev: b64(raw[2]),
    };
    return { ...record, hash: b64(raw[3]) };
  }
  throw new Error("unknown record type");
}
