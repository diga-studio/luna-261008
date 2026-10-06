export interface ProfileRecord {
  userId: string;
  engagementScore: number | null;
  region: string | null;
  purchaseTags: ReadonlyArray<string>;
}

export type LeafRule =
  | { type: "SCORE"; min: number; max: number }
  | { type: "REGION"; region: string }
  | { type: "TAG"; tag: string };

export interface AndGroupRule {
  type: "AND";
  children: ReadonlyArray<Rule>;
}

export interface OrGroupRule {
  type: "OR";
  children: ReadonlyArray<Rule>;
}

export type GroupRule = AndGroupRule | OrGroupRule;

export type Rule = GroupRule | LeafRule;

export interface SegmentStats {
  segmentId: string;
  count: number;
}

export interface PairStats {
  segmentId: string;
  otherSegmentId: string;
  count: number;
  otherCount: number;
  intersection: number;
}
