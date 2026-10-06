/** Storage tiers. */
export type Tier = "hot" | "warm" | "cold";

export const TIERS: readonly Tier[] = ["hot", "warm", "cold"];

/** Per-tier configuration supplied at initialization. */
export interface TierConfig {
  /** Directory holding object files for this tier. */
  dir: string;
  /** Total capacity in content bytes; fixed for the lifetime of the store. */
  capacityBytes: number;
}

export interface StoreOptions {
  /** Path of the SQLite database file persisting metadata. */
  dbPath: string;
  tiers: Record<Tier, TierConfig>;
}

/** Public metadata view of a stored object. */
export interface ObjectInfo {
  id: string;
  tier: Tier;
  sizeBytes: number;
  sha256: string;
}

/** Per-tier capacity/usage snapshot. */
export interface TierUsage {
  capacityBytes: number;
  /** Bytes formally occupied by fully stored objects. */
  usedBytes: number;
  /** Bytes reserved by in-flight puts/migrations (full object size). */
  reservedBytes: number;
  /** capacity - used - reserved. */
  availableBytes: number;
}

export class CapacityExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapacityExceededError";
  }
}

export class ObjectNotFoundError extends Error {
  constructor(id: string) {
    super(`object not found: ${id}`);
    this.name = "ObjectNotFoundError";
  }
}
