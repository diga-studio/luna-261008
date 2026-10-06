import type { ProfileRecord } from "./types.js";

export interface ProfileDelta {
  index: number;
  scoreChanged: boolean;
  oldRegion: string | null;
  newRegion: string | null;
  regionChanged: boolean;
  tagsAdded: ReadonlyArray<string>;
  tagsRemoved: ReadonlyArray<string>;
}

const SCORE_BUCKETS = 101;

export class ProfileStore {
  private readonly userIndex = new Map<string, number>();
  private readonly scores: Array<number | null> = [];
  private readonly regions: Array<string | null> = [];
  private readonly tags: Array<Set<string>> = [];
  private readonly scoreBuckets: Array<Set<number>> = [];
  private readonly regionIndex = new Map<string, Set<number>>();
  private readonly tagIndex = new Map<string, Set<number>>();
  private readonly internPool = new Map<string, string>();

  constructor() {
    for (let i = 0; i < SCORE_BUCKETS; i++) {
      this.scoreBuckets.push(new Set<number>());
    }
  }

  get size(): number {
    return this.scores.length;
  }

  scoreOf(index: number): number | null {
    return this.scores[index] ?? null;
  }

  regionOf(index: number): string | null {
    return this.regions[index] ?? null;
  }

  tagsOf(index: number): ReadonlySet<string> {
    return this.tags[index] ?? EMPTY_STRING_SET;
  }

  scoreBucket(score: number): ReadonlySet<number> {
    return this.scoreBuckets[score] ?? EMPTY_SET;
  }

  regionMembers(region: string): ReadonlySet<number> {
    return this.regionIndex.get(region) ?? EMPTY_SET;
  }

  tagMembers(tag: string): ReadonlySet<number> {
    return this.tagIndex.get(tag) ?? EMPTY_SET;
  }

  upsertBatch(records: ReadonlyArray<ProfileRecord>): ProfileDelta[] {
    const deduped = new Map<string, ProfileRecord>();
    for (const record of records) {
      deduped.set(record.userId, record);
    }
    const deltas: ProfileDelta[] = [];
    for (const record of deduped.values()) {
      const delta = this.applyRecord(record);
      if (delta !== null) {
        deltas.push(delta);
      }
    }
    return deltas;
  }

  private applyRecord(record: ProfileRecord): ProfileDelta | null {
    const existing = this.userIndex.get(record.userId);
    const score = record.engagementScore;
    const region = record.region === null ? null : this.intern(record.region);
    const tagSet = new Set<string>();
    for (const tag of record.purchaseTags) {
      tagSet.add(this.intern(tag));
    }
    if (existing === undefined) {
      const index = this.scores.length;
      this.userIndex.set(record.userId, index);
      this.scores.push(score);
      this.regions.push(region);
      this.tags.push(tagSet);
      if (score !== null) {
        this.scoreBuckets[score]?.add(index);
      }
      if (region !== null) {
        addToIndex(this.regionIndex, region, index);
      }
      for (const tag of tagSet) {
        addToIndex(this.tagIndex, tag, index);
      }
      return {
        index,
        scoreChanged: true,
        oldRegion: null,
        newRegion: region,
        regionChanged: region !== null,
        tagsAdded: [...tagSet],
        tagsRemoved: [],
      };
    }
    const index = existing;
    const oldScore = this.scores[index] ?? null;
    const oldRegion = this.regions[index] ?? null;
    const oldTags: ReadonlySet<string> = this.tags[index] ?? EMPTY_STRING_SET;
    const scoreChanged = oldScore !== score;
    const regionChanged = oldRegion !== region;
    const tagsAdded: string[] = [];
    const tagsRemoved: string[] = [];
    for (const tag of tagSet) {
      if (!oldTags.has(tag)) tagsAdded.push(tag);
    }
    for (const tag of oldTags) {
      if (!tagSet.has(tag)) tagsRemoved.push(tag);
    }
    if (!scoreChanged && !regionChanged && tagsAdded.length === 0 && tagsRemoved.length === 0) {
      return null;
    }
    if (scoreChanged) {
      if (oldScore !== null) this.scoreBuckets[oldScore]?.delete(index);
      if (score !== null) this.scoreBuckets[score]?.add(index);
    }
    if (regionChanged) {
      if (oldRegion !== null) removeFromIndex(this.regionIndex, oldRegion, index);
      if (region !== null) addToIndex(this.regionIndex, region, index);
    }
    for (const tag of tagsRemoved) {
      removeFromIndex(this.tagIndex, tag, index);
    }
    for (const tag of tagsAdded) {
      addToIndex(this.tagIndex, tag, index);
    }
    this.scores[index] = score;
    this.regions[index] = region;
    this.tags[index] = tagSet;
    return {
      index,
      scoreChanged,
      oldRegion,
      newRegion: region,
      regionChanged,
      tagsAdded,
      tagsRemoved,
    };
  }

  private intern(value: string): string {
    const pooled = this.internPool.get(value);
    if (pooled !== undefined) return pooled;
    this.internPool.set(value, value);
    return value;
  }
}

const EMPTY_SET: ReadonlySet<number> = new Set<number>();
const EMPTY_STRING_SET: ReadonlySet<string> = new Set<string>();

function addToIndex(index: Map<string, Set<number>>, key: string, user: number): void {
  let bucket = index.get(key);
  if (bucket === undefined) {
    bucket = new Set<number>();
    index.set(key, bucket);
  }
  bucket.add(user);
}

function removeFromIndex(index: Map<string, Set<number>>, key: string, user: number): void {
  const bucket = index.get(key);
  if (bucket === undefined) return;
  bucket.delete(user);
  if (bucket.size === 0) {
    index.delete(key);
  }
}
