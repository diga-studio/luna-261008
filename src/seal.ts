/**
 * Seal credential: the caller-retained commitment to the full record
 * sequence (contents and order) at seal time, including the count.
 */

export interface SealCredential {
  /** Total number of records committed to. */
  count: number;
  /** Hex-encoded Merkle root over all `count` records. */
  root: string;
}

/** Serialize a credential to a canonical string for safekeeping. */
export function serializeCredential(credential: SealCredential): string {
  assertValid(credential);
  return JSON.stringify(credential);
}

/** Parse a credential produced by {@link serializeCredential}. */
export function parseCredential(text: string): SealCredential {
  const value: unknown = JSON.parse(text);
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as SealCredential).count !== "number" ||
    typeof (value as SealCredential).root !== "string"
  ) {
    throw new TypeError("invalid seal credential");
  }
  const credential = value as SealCredential;
  assertValid(credential);
  return { count: credential.count, root: credential.root.toLowerCase() };
}

function assertValid(credential: SealCredential): void {
  if (!Number.isSafeInteger(credential.count) || credential.count < 0) {
    throw new RangeError("credential count must be a non-negative integer");
  }
  if (!/^[0-9a-f]{64}$/i.test(credential.root)) {
    throw new TypeError("credential root must be a hex-encoded SHA-256 hash");
  }
}
