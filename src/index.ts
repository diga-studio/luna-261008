import { Bitset } from './bitset';
import { compileMatcher, Matcher, MatcherProfile } from './compile';
import { PostingList } from './posting';
import {
  ProfileRecord,
  RuleGroup,
  RuleNode,
  SegmentPairStats,
  SegmentStats,
} from './types';

export * from './types';

const MIN_SCORE = 0;
const MAX_SCORE = 100;

interface StoredProfile extends MatcherProfile {
  userId: string;
  index: number;
  purchaseTags: readonly string[];
}

interface SegmentEntry {
  rule: RuleGroup;
  members: Bitset;
  count: number;
  matcher: Matcher;
}

/**
 * AudienceNexus: in-process profile store with segment definitions,
 * exact member counts and exact pairwise intersections.
 *
 * Design notes:
 * - Profiles are indexed by a dense integer id. Regions and tags live in
 *   inverted indexes (posting lists); scores live in 101 prefix bitsets
 *   (scoreLe[k] = users with a non-null score <= k).
 * - saveSegment evaluates the rule tree purely against these indexes
 *   (bitset algebra), never by scanning profiles.
 * - upsertBatch re-evaluates only the profiles that actually changed in
 *   the batch against compiled segment matchers, and flips membership
 *   bits incrementally. Counts are therefore exact after every call.
 * - stats intersections are bitset AND + popcount over stored member
 *   sets: exact, and no profile records are touched.
 *
 * All operations are synchronous and must be called sequentially.
 */
export class AudienceNexus {
  private profiles = new Map<string, StoredProfile>();
  private nextIndex = 0;
  private regionIndex = new Map<string, PostingList>();
  private tagIndex = new Map<string, PostingList>();
  private scoreLe: Bitset[] = [];
  private segments = new Map<string, SegmentEntry>();
  private scratch: Bitset[] = [];
  private scratchUsed = 0;

  constructor() {
    for (let k = 0; k <= MAX_SCORE; k++) this.scoreLe.push(new Bitset());
  }

  /** Inserts or fully replaces profiles; last record wins per userId in a batch. */
  upsertBatch(records: Iterable<ProfileRecord>): void {
    const deduped = new Map<string, ProfileRecord>();
    for (const record of records) deduped.set(record.userId, record);
    for (const record of deduped.values()) this.applyRecord(record);
  }

  /** Creates or replaces a segment definition and stores its exact count. */
  saveSegment(segmentId: string, rule: RuleGroup): void {
    const evaluated = this.evaluateNode(rule);
    const members = evaluated.clone();
    this.scratchUsed = 0;
    const entry: SegmentEntry = {
      rule,
      members,
      count: members.popcount(),
      matcher: compileMatcher(rule),
    };
    this.segments.set(segmentId, entry);
  }

  stats(segmentId: string): SegmentStats;
  stats(segmentId: string, otherSegmentId: string): SegmentPairStats;
  stats(segmentId: string, otherSegmentId?: string): SegmentStats | SegmentPairStats {
    const a = this.requireSegment(segmentId);
    if (otherSegmentId === undefined) return { count: a.count };
    const b = this.requireSegment(otherSegmentId);
    return {
      countA: a.count,
      countB: b.count,
      intersection: Bitset.intersectionCount(a.members, b.members),
    };
  }

  private requireSegment(segmentId: string): SegmentEntry {
    const entry = this.segments.get(segmentId);
    if (!entry) throw new Error('unknown segment: ' + segmentId);
    return entry;
  }

  private applyRecord(record: ProfileRecord): void {
    const previous = this.profiles.get(record.userId);
    const index = previous ? previous.index : this.nextIndex++;
    if (previous) this.removeFromIndexes(previous);
    const profile: StoredProfile = {
      userId: record.userId,
      index,
      engagementScore: record.engagementScore,
      region: record.region,
      purchaseTags: Array.from(record.purchaseTags),
    };
    this.addToIndexes(profile);
    this.profiles.set(record.userId, profile);
    for (const segment of this.segments.values()) {
      const matches = segment.matcher(profile);
      const had = segment.members.get(index) === 1;
      if (matches !== had) {
        if (matches) {
          segment.members.set(index);
          segment.count++;
        } else {
          segment.members.clear(index);
          segment.count--;
        }
      }
    }
  }

  private addToIndexes(profile: StoredProfile): void {
    const { index, engagementScore, region, purchaseTags } = profile;
    if (engagementScore !== null) {
      for (let k = engagementScore; k <= MAX_SCORE; k++) this.scoreLe[k].set(index);
    }
    if (region !== null) getOrCreate(this.regionIndex, region).add(index);
    for (const tag of purchaseTags) getOrCreate(this.tagIndex, tag).add(index);
  }

  private removeFromIndexes(profile: StoredProfile): void {
    const { index, engagementScore, region, purchaseTags } = profile;
    if (engagementScore !== null) {
      for (let k = engagementScore; k <= MAX_SCORE; k++) this.scoreLe[k].clear(index);
    }
    if (region !== null) this.regionIndex.get(region)?.remove(index);
    for (const tag of purchaseTags) this.tagIndex.get(tag)?.remove(index);
  }

  /** Evaluates a rule tree against the inverted indexes; never scans profiles. */
  private evaluateNode(node: RuleNode): Bitset {
    switch (node.type) {
      case 'scoreRange': {
        const result = this.acquireScratch(this.scoreLe[node.max].bitLength);
        result.orWith(this.scoreLe[node.max]);
        if (node.min > MIN_SCORE) result.andNotWith(this.scoreLe[node.min - 1]);
        return result;
      }
      case 'region': {
        const posting = this.regionIndex.get(node.value);
        const result = this.acquireScratch(this.nextIndex);
        if (posting) posting.orInto(result);
        return result;
      }
      case 'tag': {
        const posting = this.tagIndex.get(node.value);
        const result = this.acquireScratch(this.nextIndex);
        if (posting) posting.orInto(result);
        return result;
      }
      case 'and': {
        const result = this.evaluateNode(node.children[0]);
        for (let i = 1; i < node.children.length; i++) {
          const child = this.evaluateNode(node.children[i]);
          result.andWith(child);
          this.releaseScratch(child);
        }
        return result;
      }
      case 'or': {
        const result = this.evaluateNode(node.children[0]);
        for (let i = 1; i < node.children.length; i++) {
          const child = this.evaluateNode(node.children[i]);
          result.orWith(child);
          this.releaseScratch(child);
        }
        return result;
      }
    }
  }

  /**
   * Scratch bitsets are reused across rule evaluations so that saving
   * thousands of segments does not churn the garbage collector. A scratch
   * bitset is considered in use until released (or until saveSegment
   * finishes and resets the pool).
   */
  private acquireScratch(capacityBits: number): Bitset {
    if (this.scratchUsed < this.scratch.length) {
      const bitset = this.scratch[this.scratchUsed++];
      if (bitset.words.length * 32 < capacityBits) {
        bitset.words = new Uint32Array(Math.ceil(capacityBits / 32));
      } else {
        bitset.words.fill(0);
      }
      return bitset;
    }
    const bitset = new Bitset(capacityBits);
    this.scratch.push(bitset);
    this.scratchUsed++;
    return bitset;
  }

  private releaseScratch(bitset: Bitset): void {
    if (this.scratchUsed > 0 && this.scratch[this.scratchUsed - 1] === bitset) {
      this.scratchUsed--;
    }
  }
}

function getOrCreate(index: Map<string, PostingList>, key: string): PostingList {
  let posting = index.get(key);
  if (!posting) {
    posting = new PostingList();
    index.set(key, posting);
  }
  return posting;
}
