/** A single profile record as delivered to upsertBatch (already parsed/merged). */
export interface ProfileRecord {
  userId: string;
  /** Integer in [0, 100], or null when unknown. */
  engagementScore: number | null;
  /** Region string, or null when unknown. */
  region: string | null;
  /** Set of purchase tags. */
  purchaseTags: ReadonlySet<string> | readonly string[];
}

/** Leaf: engagementScore within the closed interval [min, max]. */
export interface ScoreRangeLeaf {
  type: 'scoreRange';
  min: number;
  max: number;
}

/** Leaf: region equals the given string. */
export interface RegionLeaf {
  type: 'region';
  value: string;
}

/** Leaf: purchaseTags contains the given tag. */
export interface TagLeaf {
  type: 'tag';
  value: string;
}

export type RuleLeaf = ScoreRangeLeaf | RegionLeaf | TagLeaf;

export interface AndGroup {
  type: 'and';
  children: RuleNode[];
}

export interface OrGroup {
  type: 'or';
  children: RuleNode[];
}

export type RuleGroup = AndGroup | OrGroup;

export type RuleNode = RuleLeaf | RuleGroup;

/** Stats for a single segment. */
export interface SegmentStats {
  count: number;
}

/** Stats for a pair of segments, including the exact intersection size. */
export interface SegmentPairStats {
  countA: number;
  countB: number;
  intersection: number;
}
