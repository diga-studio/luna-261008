import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VaultTermError } from "./errors";

/** Recovery metadata persisted alongside the log file. */
export interface SessionMetadata {
  version: 1;
  sessionId: string;
  /** Hex-encoded 4-byte per-session nonce salt. */
  nonceSalt: string;
  /** Number of committed log records (events + seal). */
  recordCount: number;
  /** Chain hash of the last committed record. */
  headHash: string;
  sealed: boolean;
  /** Dedup history: eventId -> original seq + sha256 of plaintext bytes. */
  events: Record<string, { seq: number; contentHash: string }>;
}

export function metadataPath(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}.meta.json`);
}

/** Load metadata for a session, or null if the session does not exist yet. */
export function loadMetadata(dir: string, sessionId: string): SessionMetadata | null {
  const path = metadataPath(dir, sessionId);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new VaultTermError("INTEGRITY_FAILURE", "recovery metadata is unreadable");
  }
  const m = parsed as SessionMetadata;
  if (
    m === null ||
    typeof m !== "object" ||
    m.version !== 1 ||
    m.sessionId !== sessionId ||
    typeof m.nonceSalt !== "string" ||
    typeof m.recordCount !== "number" ||
    typeof m.headHash !== "string" ||
    typeof m.sealed !== "boolean" ||
    m.events === null ||
    typeof m.events !== "object"
  ) {
    throw new VaultTermError("INTEGRITY_FAILURE", "recovery metadata is malformed");
  }
  // Rebuild the dedup map with a null prototype so eventIds like
  // "__proto__" cannot mutate object behavior.
  const events: SessionMetadata["events"] = Object.create(null);
  for (const [eventId, entry] of Object.entries(m.events)) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.seq !== "number" ||
      typeof entry.contentHash !== "string"
    ) {
      throw new VaultTermError("INTEGRITY_FAILURE", "recovery metadata is malformed");
    }
    events[eventId] = { seq: entry.seq, contentHash: entry.contentHash };
  }
  m.events = events;
  return m;
}

/** Atomically persist metadata (write temp file, then rename). */
export function saveMetadata(dir: string, meta: SessionMetadata): void {
  const path = metadataPath(dir, meta.sessionId);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(meta, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}
