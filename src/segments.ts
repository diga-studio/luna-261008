import { Bitset } from "./bitset.js";
import type { ProfileDelta, ProfileStore } from "./profile-store.js";
import type { Rule } from "./types.js";

const LEAF_SCORE = 0;
const LEAF_REGION = 1;
const LEAF_TAG = 2;

interface CompiledNode {
  leafId: number; // -1 for groups
  isAnd: boolean;
  children: CompiledNode[];
}

interface SegmentEntry {
  id: string;
  root: CompiledNode;
  bitset: Bitset;
  count: number;
  usesScore: boolean;
  regions: string[];
  tags: string[];
}

export class SegmentTable {
  private readonly store: ProfileStore;
  private readonly entries: SegmentEntry[] = [];
  private readonly sidOf = new Map<string, number>();

  private readonly leafIds = new Map<string, number>();
  private readonly leafKind: number[] = [];
  private readonly leafMin: number[] = [];
  private readonly leafMax: number[] = [];
  private readonly leafStr: string[] = [];

  private readonly scoreRefs = new Set<number>();
  private readonly regionRefs = new Map<string, Set<number>>();
  private readonly tagRefs = new Map<string, Set<number>>();

  private leafGen = new Int32Array(64);
  private leafVal = new Uint8Array(64);
  private evalGen = 0;
  private candidateStamp = new Int32Array(64);
  private candidateGen = 0;

  constructor(store: ProfileStore) {
    this.store = store;
  }

  has(segmentId: string): boolean {
    return this.sidOf.has(segmentId);
  }

  countOf(segmentId: string): number {
    return this.entry(segmentId).count;
  }

  intersectionOf(segmentId: string, otherSegmentId: string): number {
    const a = this.entry(segmentId);
    const b = this.entry(otherSegmentId);
    if (a === b) return a.count;
    return a.bitset.countIntersection(b.bitset);
  }

  saveSegment(segmentId: string, rule: Rule): void {
    const regions: string[] = [];
    const tags: string[] = [];
    let usesScore = false;
    const root = this.compile(rule, {
      onScore: () => {
        usesScore = true;
      },
      onRegion: (region) => {
        regions.push(region);
      },
      onTag: (tag) => {
        tags.push(tag);
      },
    });
    const bitset = this.evaluateFull(root);
    const count = bitset.count();
    const existingSid = this.sidOf.get(segmentId);
    if (existingSid !== undefined) {
      this.unregister(existingSid);
      this.entries[existingSid] = {
        id: segmentId,
        root,
        bitset,
        count,
        usesScore,
        regions,
        tags,
      };
      this.register(existingSid);
    } else {
      const sid = this.entries.length;
      this.entries.push({ id: segmentId, root, bitset, count, usesScore, regions, tags });
      this.sidOf.set(segmentId, sid);
      this.register(sid);
    }
  }

  applyDeltas(deltas: ReadonlyArray<ProfileDelta>): void {
    if (deltas.length === 0 || this.entries.length === 0) return;
    this.ensureLeafCapacity();
    if (this.candidateStamp.length < this.entries.length) {
      let capacity = this.candidateStamp.length;
      while (capacity < this.entries.length) capacity *= 2;
      this.candidateStamp = new Int32Array(capacity);
    }
    const userCount = this.store.size;
    for (const delta of deltas) {
      this.evalGen++;
      if (this.evalGen === 0x7fffffff) {
        this.leafGen.fill(0);
        this.evalGen = 1;
      }
      this.candidateGen++;
      if (this.candidateGen === 0x7fffffff) {
        this.candidateStamp.fill(0);
        this.candidateGen = 1;
      }
      if (delta.scoreChanged) {
        for (const sid of this.scoreRefs) this.markCandidate(sid);
      }
      if (delta.regionChanged) {
        if (delta.oldRegion !== null) this.markRegionRefs(delta.oldRegion);
        if (delta.newRegion !== null) this.markRegionRefs(delta.newRegion);
      }
      for (const tag of delta.tagsAdded) this.markTagRefs(tag);
      for (const tag of delta.tagsRemoved) this.markTagRefs(tag);
      const gen = this.candidateGen;
      for (let sid = 0; sid < this.entries.length; sid++) {
        if (this.candidateStamp[sid] !== gen) continue;
        const entry = this.entries[sid];
        if (entry === undefined) continue;
        const matched = this.evaluateForUser(entry.root, delta.index);
        entry.bitset.ensureCapacity(userCount);
        const before = entry.bitset.get(delta.index);
        if (matched !== before) {
          if (matched) {
            entry.bitset.set(delta.index);
            entry.count++;
          } else {
            entry.bitset.clear(delta.index);
            entry.count--;
          }
        }
      }
    }
  }

  private entry(segmentId: string): SegmentEntry {
    const sid = this.sidOf.get(segmentId);
    if (sid === undefined) {
      throw new Error(`unknown segment: ${segmentId}`);
    }
    const entry = this.entries[sid];
    if (entry === undefined) {
      throw new Error(`unknown segment: ${segmentId}`);
    }
    return entry;
  }

  private markCandidate(sid: number): void {
    this.candidateStamp[sid] = this.candidateGen;
  }

  private markRegionRefs(region: string): void {
    const refs = this.regionRefs.get(region);
    if (refs === undefined) return;
    for (const sid of refs) this.markCandidate(sid);
  }

  private markTagRefs(tag: string): void {
    const refs = this.tagRefs.get(tag);
    if (refs === undefined) return;
    for (const sid of refs) this.markCandidate(sid);
  }

  private register(sid: number): void {
    const entry = this.entries[sid];
    if (entry === undefined) return;
    if (entry.usesScore) this.scoreRefs.add(sid);
    for (const region of entry.regions) {
      let refs = this.regionRefs.get(region);
      if (refs === undefined) {
        refs = new Set<number>();
        this.regionRefs.set(region, refs);
      }
      refs.add(sid);
    }
    for (const tag of entry.tags) {
      let refs = this.tagRefs.get(tag);
      if (refs === undefined) {
        refs = new Set<number>();
        this.tagRefs.set(tag, refs);
      }
      refs.add(sid);
    }
  }

  private unregister(sid: number): void {
    const entry = this.entries[sid];
    if (entry === undefined) return;
    this.scoreRefs.delete(sid);
    for (const region of entry.regions) {
      const refs = this.regionRefs.get(region);
      if (refs === undefined) continue;
      refs.delete(sid);
      if (refs.size === 0) this.regionRefs.delete(region);
    }
    for (const tag of entry.tags) {
      const refs = this.tagRefs.get(tag);
      if (refs === undefined) continue;
      refs.delete(sid);
      if (refs.size === 0) this.tagRefs.delete(tag);
    }
  }

  private compile(
    rule: Rule,
    sink: { onScore: () => void; onRegion: (region: string) => void; onTag: (tag: string) => void },
  ): CompiledNode {
    if (rule.type === "AND" || rule.type === "OR") {
      const children = rule.children.map((child) => this.compile(child, sink));
      return { leafId: -1, isAnd: rule.type === "AND", children };
    }
    let key: string;
    let kind: number;
    let min = 0;
    let max = 0;
    let str = "";
    if (rule.type === "SCORE") {
      kind = LEAF_SCORE;
      min = rule.min;
      max = rule.max;
      key = `S:${min}:${max}`;
      sink.onScore();
    } else if (rule.type === "REGION") {
      kind = LEAF_REGION;
      str = rule.region;
      key = `R:${str}`;
      sink.onRegion(str);
    } else {
      kind = LEAF_TAG;
      str = rule.tag;
      key = `T:${str}`;
      sink.onTag(str);
    }
    let leafId = this.leafIds.get(key);
    if (leafId === undefined) {
      leafId = this.leafKind.length;
      this.leafIds.set(key, leafId);
      this.leafKind.push(kind);
      this.leafMin.push(min);
      this.leafMax.push(max);
      this.leafStr.push(str);
    }
    return { leafId, isAnd: false, children: [] };
  }

  private evaluateFull(node: CompiledNode): Bitset {
    if (node.leafId >= 0) {
      return this.leafBitset(node.leafId);
    }
    const userCount = this.store.size;
    let result: Bitset | null = null;
    for (const child of node.children) {
      const childBits = this.evaluateFull(child);
      if (result === null) {
        result = childBits;
      } else if (node.isAnd) {
        result.andInPlace(childBits);
      } else {
        result.orInPlace(childBits);
      }
    }
    return result ?? new Bitset(userCount);
  }

  private leafBitset(leafId: number): Bitset {
    const userCount = this.store.size;
    const bits = new Bitset(userCount);
    const kind = this.leafKind[leafId];
    if (kind === LEAF_SCORE) {
      const min = this.leafMin[leafId] ?? 0;
      const max = this.leafMax[leafId] ?? 100;
      for (let score = min; score <= max; score++) {
        for (const user of this.store.scoreBucket(score)) {
          bits.set(user);
        }
      }
    } else if (kind === LEAF_REGION) {
      const region = this.leafStr[leafId] ?? "";
      for (const user of this.store.regionMembers(region)) {
        bits.set(user);
      }
    } else {
      const tag = this.leafStr[leafId] ?? "";
      for (const user of this.store.tagMembers(tag)) {
        bits.set(user);
      }
    }
    return bits;
  }

  private evaluateForUser(node: CompiledNode, user: number): boolean {
    if (node.leafId >= 0) {
      return this.leafMatches(node.leafId, user);
    }
    if (node.isAnd) {
      for (const child of node.children) {
        if (!this.evaluateForUser(child, user)) return false;
      }
      return true;
    }
    for (const child of node.children) {
      if (this.evaluateForUser(child, user)) return true;
    }
    return false;
  }

  private leafMatches(leafId: number, user: number): boolean {
    if (this.leafGen[leafId] === this.evalGen) {
      return this.leafVal[leafId] === 1;
    }
    const kind = this.leafKind[leafId];
    let matched: boolean;
    if (kind === LEAF_SCORE) {
      const score = this.store.scoreOf(user);
      matched =
        score !== null &&
        score >= (this.leafMin[leafId] ?? 0) &&
        score <= (this.leafMax[leafId] ?? 100);
    } else if (kind === LEAF_REGION) {
      matched = this.store.regionOf(user) === this.leafStr[leafId];
    } else {
      matched = this.store.tagsOf(user).has(this.leafStr[leafId] ?? "");
    }
    this.leafGen[leafId] = this.evalGen;
    this.leafVal[leafId] = matched ? 1 : 0;
    return matched;
  }

  private ensureLeafCapacity(): void {
    if (this.leafGen.length >= this.leafKind.length) return;
    let capacity = this.leafGen.length;
    while (capacity < this.leafKind.length) capacity *= 2;
    const gen = new Int32Array(capacity);
    gen.set(this.leafGen);
    this.leafGen = gen;
    const val = new Uint8Array(capacity);
    val.set(this.leafVal);
    this.leafVal = val;
  }
}
