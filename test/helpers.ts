import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { EvidenceEvent } from "../src/index.js";

export function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "ees-test-"));
}

export function marker(): string {
  return "MARKER-" + randomBytes(8).toString("hex");
}

export function makeEvent(timestamp: string, eventType: string, note: string): EvidenceEvent {
  return { timestamp, eventType, metadata: { note } };
}

/** Recursively list all files under dir (relative paths). */
export function listFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(full, rel));
    } else {
      out.push(rel);
    }
  }
  return out.sort();
}

/** True if any file under dir contains the given plaintext string. */
export function dirContainsPlaintext(dir: string, needle: string): boolean {
  for (const rel of listFiles(dir)) {
    const content = readFileSync(join(dir, rel));
    if (content.includes(needle)) return true;
  }
  return false;
}
