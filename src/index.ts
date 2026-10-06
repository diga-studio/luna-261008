import { ProfileStore } from "./profile-store.js";
import { SegmentTable } from "./segments.js";
import type { PairStats, ProfileRecord, Rule, SegmentStats } from "./types.js";

export type { AndGroupRule, GroupRule, LeafRule, OrGroupRule, PairStats, ProfileRecord, Rule, SegmentStats } from "./types.js";

export class AudienceNexus {
  private readonly profiles = new ProfileStore();
  private readonly segments = new SegmentTable(this.profiles);

  upsertBatch(records: ReadonlyArray<ProfileRecord>): void {
    const deltas = this.profiles.upsertBatch(records);
    this.segments.applyDeltas(deltas);
  }

  saveSegment(segmentId: string, rule: Rule): void {
    this.segments.saveSegment(segmentId, rule);
  }

  stats(segmentId: string): SegmentStats;
  stats(segmentId: string, otherSegmentId: string): PairStats;
  stats(segmentId: string, otherSegmentId?: string): SegmentStats | PairStats {
    if (otherSegmentId === undefined) {
      return { segmentId, count: this.segments.countOf(segmentId) };
    }
    return {
      segmentId,
      otherSegmentId,
      count: this.segments.countOf(segmentId),
      otherCount: this.segments.countOf(otherSegmentId),
      intersection: this.segments.intersectionOf(segmentId, otherSegmentId),
    };
  }
}
