export type Tier = 'hot' | 'warm' | 'cold';

export const TIERS: readonly Tier[] = ['hot', 'warm', 'cold'];

export interface TierConfig {
  tier: Tier;
  dir: string;
  capacityBytes: number;
}

export interface StoreConfig {
  dbPath: string;
  tiers: TierConfig[];
}

export interface ObjectInfo {
  id: string;
  tier: Tier;
  sizeBytes: number;
  sha256: string;
}

export interface TierCapacity {
  capacityBytes: number;
  usedBytes: number;
  availableBytes: number;
}
