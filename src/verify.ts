import { chainHash, chainHashOfRecord, genesisHash } from "./chain.js";
import type {
  AuditRecord,
  ExportPackage,
  SealCredential,
  TimeWindow,
} from "./types.js";

const HEX_HASH = /^[0-9a-f]{64}$/;

function fail(reason: string): never {
  throw new Error(`export verification failed: ${reason}`);
}

function checkTimestamp(ts: number, what: string): void {
  if (!Number.isSafeInteger(ts)) fail(`${what} is not an integer millisecond timestamp`);
}

/**
 * Independently verify an export package against the caller-supplied time
 * window and a trusted seal credential. No database or module access.
 *
 * Returns the revealed (hit) records in seq order. Throws if anything is
 * inconsistent: wrong count, missing/duplicated/reordered positions, a
 * tampered field, a hit outside the window, a hidden position inside the
 * window, or a chain head that does not match the credential.
 */
export function verifyExport(
  pkg: ExportPackage,
  window: TimeWindow,
  credential: SealCredential,
): AuditRecord[] {
  checkTimestamp(window.startMs, "window startMs");
  checkTimestamp(window.endMs, "window endMs");
  if (window.startMs > window.endMs) fail("window startMs is after endMs");
  if (!Number.isSafeInteger(credential.count) || credential.count < 0) {
    fail("credential count is invalid");
  }
  if (!HEX_HASH.test(credential.head)) fail("credential head is not a SHA-256 hex digest");
  if (pkg.count !== credential.count) {
    fail(`package count ${pkg.count} does not match credential count ${credential.count}`);
  }
  if (pkg.entries.length !== credential.count) {
    fail(`package has ${pkg.entries.length} entries, expected ${credential.count}`);
  }

  let head = genesisHash();
  const hits: AuditRecord[] = [];
  for (let i = 0; i < pkg.entries.length; i++) {
    const seq = i + 1;
    const entry = pkg.entries[i];
    if (entry.kind === "record") {
      const record = entry.record;
      if (record.seq !== seq) fail(`entry ${i} claims seq ${record.seq}, expected ${seq}`);
      checkTimestamp(record.timestampMs, `record ${seq} timestampMs`);
      if (typeof record.prevState !== "string" || typeof record.nextState !== "string") {
        fail(`record ${seq} states must be strings`);
      }
      if (record.timestampMs < window.startMs || record.timestampMs >= window.endMs) {
        fail(`revealed record ${seq} lies outside the query window`);
      }
      head = chainHashOfRecord(head, record);
      hits.push(record);
    } else if (entry.kind === "sealed") {
      if (entry.seq !== seq) fail(`entry ${i} claims seq ${entry.seq}, expected ${seq}`);
      checkTimestamp(entry.timestampMs, `sealed entry ${seq} timestampMs`);
      if (!HEX_HASH.test(entry.contentHash)) {
        fail(`sealed entry ${seq} contentHash is not a SHA-256 hex digest`);
      }
      if (entry.timestampMs >= window.startMs && entry.timestampMs < window.endMs) {
        fail(`position ${seq} falls inside the query window but its record is withheld`);
      }
      head = chainHash(head, seq, entry.timestampMs, Buffer.from(entry.contentHash, "hex"));
    } else {
      fail(`entry ${i} has unknown kind`);
    }
  }

  if (head.toString("hex") !== credential.head) {
    fail("chain head does not match the seal credential");
  }
  return hits;
}
