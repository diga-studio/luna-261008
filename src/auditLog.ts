import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { sha256Hex } from "./crypto.js";
import type { AuditItem, AuditItemType } from "./types.js";

export interface AuditVerifyResult {
  ok: boolean;
  error: string | null;
}

const GENESIS_PREV_HASH = "0".repeat(64);

function computeHash(item: Omit<AuditItem, "hash">): string {
  return sha256Hex(
    JSON.stringify([item.seq, item.type, item.employeeId, item.payloadCiphertext, item.prevHash]),
  );
}

/**
 * Append-only hash-chained audit log backed by a single JSONL file.
 * Committed items are immutable: seq, payload and hash material never change.
 */
export class AuditLog {
  private readonly filePath: string;
  private readonly committed: AuditItem[] = [];

  constructor(filePath: string) {
    this.filePath = filePath;
    if (existsSync(filePath)) {
      const text = readFileSync(filePath, "utf8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        this.committed.push(JSON.parse(trimmed) as AuditItem);
      }
    }
  }

  items(): AuditItem[] {
    return this.committed.map((item) => ({ ...item }));
  }

  nextSeq(): number {
    return this.committed.length + 1;
  }

  /** True if an erase-complete item already exists for this employee. */
  hasEraseItem(employeeId: string): boolean {
    return this.committed.some((item) => item.type === "erase" && item.employeeId === employeeId);
  }

  append(type: AuditItemType, employeeId: string, payloadCiphertext: string | null): AuditItem {
    const last = this.committed[this.committed.length - 1];
    const base = {
      seq: this.committed.length + 1,
      type,
      employeeId,
      payloadCiphertext,
      prevHash: last ? last.hash : GENESIS_PREV_HASH,
    };
    const item: AuditItem = { ...base, hash: computeHash(base) };
    const fd = openSync(this.filePath, "a");
    try {
      writeSync(fd, JSON.stringify(item) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.committed.push(item);
    return { ...item };
  }

  verify(): AuditVerifyResult {
    let expectedPrev = GENESIS_PREV_HASH;
    for (let index = 0; index < this.committed.length; index += 1) {
      const item = this.committed[index]!;
      const expectedSeq = index + 1;
      if (item.seq !== expectedSeq) {
        return { ok: false, error: `item at position ${expectedSeq} has seq ${item.seq}` };
      }
      if (item.prevHash !== expectedPrev) {
        return { ok: false, error: `item ${item.seq} has broken prevHash link` };
      }
      const { hash, ...rest } = item;
      if (computeHash(rest) !== hash) {
        return { ok: false, error: `item ${item.seq} hash mismatch` };
      }
      expectedPrev = item.hash;
    }
    return { ok: true, error: null };
  }
}
