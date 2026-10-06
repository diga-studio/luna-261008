/**
 * Time-window export packages and their standalone verification.
 */
import { leafHash, type RecordPayload } from "./hash.js";
import { verifyInclusion, type ProofStep } from "./merkle.js";
import type { SealCredential } from "./seal.js";

/** Left-closed, right-open time window in integer milliseconds. */
export interface TimeWindow {
  startMs: number;
  endMs: number;
}

/** A boundary neighbour revealed without its before/after content. */
export interface BoundaryRecord {
  seq: number;
  timestampMs: number;
  /** Hex leaf hash committing to the hidden content. */
  leafHash: string;
  proof: ProofStep[];
}

/** A hit record revealed in full, with its inclusion proof. */
export interface HitRecord extends RecordPayload {
  proof: ProofStep[];
}

/**
 * Export package for a time window against a sealed prefix.
 * Contains hit records in full and boundary neighbours as hashes only.
 */
export interface ExportPackage {
  /** Number of records in the sealed prefix this export is built against. */
  count: number;
  /** Window the package claims to cover (checked against the caller's). */
  window: TimeWindow;
  /** Hit records, ordered by ascending seq. */
  hits: HitRecord[];
  /** Record immediately before the first hit, if any. */
  left: BoundaryRecord | null;
  /** Record immediately after the last hit, if any. */
  right: BoundaryRecord | null;
}

function fail(reason: string): never {
  throw new Error(`export verification failed: ${reason}`);
}

function parseRoot(credential: SealCredential): Buffer {
  if (!Number.isSafeInteger(credential.count) || credential.count < 0) {
    fail("credential count is not a non-negative integer");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(credential.root)) {
    fail("credential root is not a SHA-256 hex string");
  }
  return Buffer.from(credential.root, "hex");
}

function checkWindow(window: TimeWindow): void {
  if (
    !Number.isSafeInteger(window.startMs) ||
    !Number.isSafeInteger(window.endMs) ||
    window.startMs > window.endMs
  ) {
    fail("query window is not a valid [startMs, endMs) range of safe integers");
  }
}

function checkProof(
  leaf: Buffer,
  seq: number,
  count: number,
  proof: ProofStep[],
  root: Buffer,
): void {
  if (!verifyInclusion(leaf, seq, count, proof, root)) {
    fail(`inclusion proof for record at seq ${seq} does not match the seal`);
  }
}

function checkBoundary(
  boundary: BoundaryRecord,
  count: number,
  root: Buffer,
): void {
  if (!Number.isSafeInteger(boundary.seq) || !Number.isSafeInteger(boundary.timestampMs)) {
    fail("boundary record has non-integer fields");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(boundary.leafHash)) {
    fail("boundary leaf hash is not a SHA-256 hex string");
  }
  checkProof(
    Buffer.from(boundary.leafHash, "hex"),
    boundary.seq,
    count,
    boundary.proof,
    root,
  );
}

/**
 * Independently verify an export package against a caller-supplied
 * window and trusted seal credential. Throws on any inconsistency;
 * returns the verified hit records on success.
 */
export function verifyExport(
  pkg: ExportPackage,
  window: TimeWindow,
  credential: SealCredential,
): RecordPayload[] {
  checkWindow(window);
  const root = parseRoot(credential);
  const count = credential.count;

  // The package must answer the caller's query, not a self-declared one.
  if (pkg.count !== count) {
    fail("package count does not match the seal credential");
  }
  if (pkg.window.startMs !== window.startMs || pkg.window.endMs !== window.endMs) {
    fail("package window does not match the query window");
  }

  // Validate and authenticate the hit records.
  const hits = pkg.hits;
  let previousSeq: number | null = null;
  let previousTs: number | null = null;
  for (const hit of hits) {
    if (
      !Number.isSafeInteger(hit.seq) ||
      !Number.isSafeInteger(hit.timestampMs) ||
      typeof hit.before !== "string" ||
      typeof hit.after !== "string"
    ) {
      fail("hit record has invalid fields");
    }
    if (previousSeq !== null && hit.seq !== previousSeq + 1) {
      fail("hit records are not consecutive in sequence order");
    }
    if (hit.timestampMs < window.startMs || hit.timestampMs >= window.endMs) {
      fail(`hit record at seq ${hit.seq} lies outside the query window`);
    }
    if (previousTs !== null && hit.timestampMs < previousTs) {
      fail("hit record timestamps are not non-decreasing");
    }
    checkProof(leafHash(hit), hit.seq, count, hit.proof, root);
    previousSeq = hit.seq;
    previousTs = hit.timestampMs;
  }

  const firstHitSeq = hits.length === 0 ? 0 : hits[0].seq;
  const lastHitSeq = hits.length === 0 ? 0 : hits[hits.length - 1].seq;

  if (hits.length > 0) {
    // Left neighbour must exist iff the first hit is not the first record,
    // and its timestamp must fall before the window.
    if (firstHitSeq > 1) {
      if (pkg.left === null) {
        fail("missing left boundary record");
      }
      if (pkg.left.seq !== firstHitSeq - 1) {
        fail("left boundary is not adjacent to the first hit");
      }
      if (pkg.left.timestampMs >= window.startMs) {
        fail("left boundary lies inside the query window");
      }
      if (pkg.left.timestampMs > hits[0].timestampMs) {
        fail("left boundary timestamp exceeds the first hit");
      }
      checkBoundary(pkg.left, count, root);
    } else if (pkg.left !== null) {
      fail("unexpected left boundary record");
    }
    // Right neighbour must exist iff the last hit is not the last record,
    // and its timestamp must fall at or after the window end.
    if (lastHitSeq < count) {
      if (pkg.right === null) {
        fail("missing right boundary record");
      }
      if (pkg.right.seq !== lastHitSeq + 1) {
        fail("right boundary is not adjacent to the last hit");
      }
      if (pkg.right.timestampMs < window.endMs) {
        fail("right boundary lies inside the query window");
      }
      if (pkg.right.timestampMs < hits[hits.length - 1].timestampMs) {
        fail("right boundary timestamp precedes the last hit");
      }
      checkBoundary(pkg.right, count, root);
    } else if (pkg.right !== null) {
      fail("unexpected right boundary record");
    }
  } else {
    // Empty result: prove that no record of the sealed prefix falls in
    // the window. Because timestamps are non-decreasing, one of three
    // situations must be authenticated.
    if (count === 0) {
      if (pkg.left !== null || pkg.right !== null) {
        fail("unexpected boundary records for an empty seal");
      }
    } else if (pkg.left !== null && pkg.right !== null) {
      // A left record before the window adjacent to a right record at or
      // after the window leaves no room for hits in between.
      if (pkg.right.seq !== pkg.left.seq + 1) {
        fail("boundary records are not adjacent");
      }
      if (pkg.left.timestampMs >= window.startMs) {
        fail("left boundary lies inside the query window");
      }
      if (pkg.right.timestampMs < window.endMs) {
        fail("right boundary lies inside the query window");
      }
      checkBoundary(pkg.left, count, root);
      checkBoundary(pkg.right, count, root);
    } else if (pkg.left !== null && pkg.right === null) {
      // The last record of the prefix ends before the window.
      if (pkg.left.seq !== count) {
        fail("left boundary is not the last record of the sealed prefix");
      }
      if (pkg.left.timestampMs >= window.startMs) {
        fail("left boundary lies inside the query window");
      }
      checkBoundary(pkg.left, count, root);
    } else if (pkg.left === null && pkg.right !== null) {
      // The first record of the prefix starts at or after the window.
      if (pkg.right.seq !== 1) {
        fail("right boundary is not the first record of the sealed prefix");
      }
      if (pkg.right.timestampMs < window.endMs) {
        fail("right boundary lies inside the query window");
      }
      checkBoundary(pkg.right, count, root);
    } else {
      fail("empty result without boundary proof");
    }
  }

  return hits.map(({ seq, timestampMs, before, after }) => ({
    seq,
    timestampMs,
    before,
    after,
  }));
}
