import { appendFileSync, existsSync, readFileSync } from "fs";
import { sha256Hex } from "./crypto";
import { AuditEntry, AuditEntryType } from "./types";

export const GENESIS_HASH = "0".repeat(64);

/** Canonical serialization of an entry's integrity material (everything except hash). */
export function entryDigestInput(entry: Omit<AuditEntry, "hash">): string {
  return JSON.stringify([
    entry.seq,
    entry.prevHash,
    entry.type,
    entry.employeeId,
    entry.payload,
  ]);
}

export function computeEntryHash(entry: Omit<AuditEntry, "hash">): string {
  return sha256Hex(entryDigestInput(entry));
}

/**
 * Append-only hash-chained audit log stored as JSONL.
 * Committed entries are never modified or deleted by this component.
 */
export class AuditLog {
  private readonly filePath: string;
  private entries: AuditEntry[];

  constructor(filePath: string) {
    this.filePath = filePath;
    this.entries = existsSync(filePath) ? parseEntries(readFileSync(filePath, "utf8")) : [];
  }

  readAll(): AuditEntry[] {
    return this.entries.slice();
  }

  append(type: AuditEntryType, employeeId: string, payload: string | null): AuditEntry {
    const last = this.entries[this.entries.length - 1];
    const base = {
      seq: last ? last.seq + 1 : 1,
      prevHash: last ? last.hash : GENESIS_HASH,
      type,
      employeeId,
      payload,
    };
    const entry: AuditEntry = { ...base, hash: computeEntryHash(base) };
    appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf8");
    this.entries.push(entry);
    return entry;
  }

  hasEraseComplete(employeeId: string): boolean {
    return this.entries.some((e) => e.type === "erase-complete" && e.employeeId === employeeId);
  }

  /** Verify the full hash chain; returns list of problems (empty = intact). */
  verify(): string[] {
    const problems: string[] = [];
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return ["audit log file is missing"];
    }
    const lines = raw.split("\n").filter((line) => line.length > 0);
    let prevHash = GENESIS_HASH;
    for (let i = 0; i < lines.length; i++) {
      let entry: AuditEntry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        problems.push(`entry ${i + 1}: unparseable`);
        return problems;
      }
      const expectedSeq = i + 1;
      if (entry.seq !== expectedSeq) {
        problems.push(`entry ${expectedSeq}: seq mismatch (got ${entry.seq})`);
      }
      if (entry.prevHash !== prevHash) {
        problems.push(`entry ${expectedSeq}: prevHash chain broken`);
      }
      const { hash, ...rest } = entry;
      if (hash !== computeEntryHash(rest)) {
        problems.push(`entry ${expectedSeq}: hash mismatch (content tampered)`);
      }
      prevHash = entry.hash;
    }
    return problems;
  }
}

function parseEntries(raw: string): AuditEntry[] {
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AuditEntry);
}
