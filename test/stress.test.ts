import assert from "node:assert/strict";
import { resourceUsage } from "node:process";
import test from "node:test";
import { AudienceNexus } from "../src/index.js";
import type { ProfileRecord, Rule } from "../src/types.js";

const USER_COUNT = 100_000;
const SEGMENT_COUNT = 2_000;
const REGION_COUNT = 20_000;
const TAG_COUNT = 50_000;
const BATCH_COUNT = 100;
const BATCH_SIZE = 128;
const PAIR_QUERIES = 2_000;
const MAX_TAGS_PER_USER = 8;
const TIME_LIMIT_MS = 60_000;
const RSS_LIMIT_BYTES = 384 * 1024 * 1024;

const WIDE_REGION = "region-00000";
const NARROW_REGION = "region-00007";
const TRACKED_TAG = "tag-49999";

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Random {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  int(bound: number): number {
    return Math.floor(this.next() * bound);
  }
  chance(probability: number): boolean {
    return this.next() < probability;
  }
}

function regionName(id: number): string {
  return `region-${String(id).padStart(5, "0")}`;
}

function tagName(id: number): string {
  return `tag-${String(id).padStart(5, "0")}`;
}

function randomScoreLeaf(rng: Random, wide: boolean): Rule {
  if (wide) {
    const min = rng.int(6);
    return { type: "SCORE", min, max: 100 };
  }
  let min = rng.int(101);
  let max = rng.int(101);
  if (min > max) [min, max] = [max, min];
  return { type: "SCORE", min, max };
}

function randomLeaf(rng: Random, wide: boolean): Rule {
  switch (rng.int(3)) {
    case 0:
      return randomScoreLeaf(rng, wide);
    case 1:
      return { type: "REGION", region: regionName(rng.int(REGION_COUNT)) };
    default:
      return { type: "TAG", tag: tagName(rng.int(TAG_COUNT)) };
  }
}

function randomRule(rng: Random, depth: number, budget: { leaves: number }, wide: boolean): Rule {
  const mustBeLeaf = depth >= 3 || budget.leaves <= 1;
  if (mustBeLeaf || rng.chance(0.4)) {
    budget.leaves -= 1;
    return randomLeaf(rng, wide);
  }
  const childCount = 1 + rng.int(3);
  const children: Rule[] = [];
  for (let i = 0; i < childCount && budget.leaves > 0; i++) {
    children.push(randomRule(rng, depth + 1, budget, wide));
  }
  return { type: rng.chance(0.5) ? "AND" : "OR", children };
}

function randomRecord(rng: Random, userId: string): ProfileRecord {
  const engagementScore = rng.chance(0.05) ? null : rng.int(101);
  const region = rng.chance(0.1) ? null : regionName(rng.int(REGION_COUNT));
  const tagCount = rng.int(MAX_TAGS_PER_USER + 1);
  const purchaseTags: string[] = [];
  for (let i = 0; i < tagCount; i++) {
    const tag = tagName(rng.int(TAG_COUNT));
    if (!purchaseTags.includes(tag)) purchaseTags.push(tag);
  }
  return { userId, engagementScore, region, purchaseTags };
}

function peakRssBytes(): number {
  const raw = resourceUsage().maxRSS;
  const rssNow = process.memoryUsage().rss;
  const asKilobytes = raw * 1024;
  const interpreted =
    Math.abs(asKilobytes - rssNow) < Math.abs(raw - rssNow) ? asKilobytes : raw;
  return Math.max(interpreted, rssNow);
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

test("stress: 100k profiles, 2k segments, 100 update batches, 2k pair queries", { timeout: 180000 }, () => {
  const startedAt = performance.now();
  const rng = new Random(20261008);
  const nexus = new AudienceNexus();

  const truthScore = new Int16Array(USER_COUNT).fill(-1);
  const truthRegion = new Int32Array(USER_COUNT).fill(-1);
  const trackedTagMembers = new Set<number>();

  const applyTruth = (record: ProfileRecord, index: number) => {
    truthScore[index] = record.engagementScore === null ? -1 : record.engagementScore;
    truthRegion[index] = record.region === null ? -1 : Number(record.region.slice(7));
    if (record.purchaseTags.includes(TRACKED_TAG)) {
      trackedTagMembers.add(index);
    } else {
      trackedTagMembers.delete(index);
    }
  };

  const loadStarted = performance.now();
  const userIds: string[] = [];
  for (let i = 0; i < USER_COUNT; i++) userIds.push(`user-${i}`);
  const LOAD_CHUNK = 10_000;
  for (let offset = 0; offset < USER_COUNT; offset += LOAD_CHUNK) {
    const batch: ProfileRecord[] = [];
    for (let i = 0; i < LOAD_CHUNK; i++) {
      const index = offset + i;
      const userId = userIds[index] ?? `user-${index}`;
      const record =
        index < 25
          ? {
              userId,
              engagementScore: 95 + (index % 6),
              region: NARROW_REGION,
              purchaseTags: [TRACKED_TAG],
            }
          : randomRecord(rng, userId);
      applyTruth(record, index);
      batch.push(record);
    }
    nexus.upsertBatch(batch);
  }
  const loadMs = performance.now() - loadStarted;

  const wideRule: Rule = {
    type: "OR",
    children: [{ type: "SCORE", min: 0, max: 100 }, { type: "REGION", region: WIDE_REGION }],
  };
  const narrowRule: Rule = {
    type: "AND",
    children: [
      { type: "SCORE", min: 95, max: 100 },
      { type: "REGION", region: NARROW_REGION },
    ],
  };
  const tagRule: Rule = { type: "AND", children: [{ type: "TAG", tag: TRACKED_TAG }] };

  const saveStarted = performance.now();
  const segmentIds: string[] = [];
  for (let i = 0; i < SEGMENT_COUNT; i++) {
    const segmentId = `seg-${i}`;
    segmentIds.push(segmentId);
    const wide = i % 10 === 0;
    nexus.saveSegment(segmentId, randomRule(rng, 1, { leaves: 16 }, wide));
  }
  nexus.saveSegment("wide", wideRule);
  nexus.saveSegment("narrow", narrowRule);
  nexus.saveSegment("tracked-tag", tagRule);
  const saveMs = performance.now() - saveStarted;

  const expectedWide = () => {
    let total = 0;
    for (let i = 0; i < USER_COUNT; i++) {
      const score = truthScore[i] ?? -1;
      if (score >= 0 || truthRegion[i] === 0) total++;
    }
    return total;
  };
  const expectedNarrow = () => {
    let total = 0;
    for (let i = 0; i < USER_COUNT; i++) {
      const score = truthScore[i] ?? -1;
      if (score >= 95 && score <= 100 && truthRegion[i] === 7) total++;
    }
    return total;
  };
  const expectedBoth = () => {
    let total = 0;
    for (let i = 0; i < USER_COUNT; i++) {
      const score = truthScore[i] ?? -1;
      const inWide = score >= 0 || truthRegion[i] === 0;
      const inNarrow = score >= 95 && score <= 100 && truthRegion[i] === 7;
      if (inWide && inNarrow) total++;
    }
    return total;
  };

  const verifyTracked = (label: string) => {
    assert.strictEqual(nexus.stats("wide").count, expectedWide(), `${label}: wide count`);
    assert.strictEqual(nexus.stats("narrow").count, expectedNarrow(), `${label}: narrow count`);
    assert.strictEqual(nexus.stats("tracked-tag").count, trackedTagMembers.size, `${label}: tag count`);
    const pair = nexus.stats("wide", "narrow");
    assert.strictEqual(pair.intersection, expectedBoth(), `${label}: wide x narrow`);
    assert.strictEqual(pair.count, expectedWide(), `${label}: pair wide`);
    assert.strictEqual(pair.otherCount, expectedNarrow(), `${label}: pair narrow`);
  };

  verifyTracked("after load");
  const wideCoverage = nexus.stats("wide").count / USER_COUNT;
  assert.ok(wideCoverage > 0.9, `wide segment should cover >90% of profiles, got ${wideCoverage}`);

  const updateStarted = performance.now();
  let pairQueries = 0;
  for (let batchIndex = 0; batchIndex < BATCH_COUNT; batchIndex++) {
    const batch: ProfileRecord[] = [];
    for (let i = 0; i < BATCH_SIZE; i++) {
      const index = rng.int(USER_COUNT);
      const record = randomRecord(rng, userIds[index] ?? `user-${index}`);
      applyTruth(record, index);
      batch.push(record);
    }
    nexus.upsertBatch(batch);
    const queriesThisBatch = Math.ceil((PAIR_QUERIES - pairQueries) / (BATCH_COUNT - batchIndex));
    for (let q = 0; q < queriesThisBatch && pairQueries < PAIR_QUERIES; q++) {
      const a = segmentIds[rng.int(segmentIds.length)] ?? "seg-0";
      const b = segmentIds[rng.int(segmentIds.length)] ?? "seg-1";
      const stats = nexus.stats(a, b);
      assert.ok(stats.intersection >= 0, "intersection non-negative");
      assert.ok(stats.intersection <= Math.min(stats.count, stats.otherCount), "intersection bounded");
      pairQueries++;
    }
    const tracked = nexus.stats("wide", "narrow");
    assert.strictEqual(tracked.intersection, expectedBoth(), `batch ${batchIndex}: wide x narrow`);
    if (batchIndex % 25 === 24) {
      verifyTracked(`batch ${batchIndex}`);
    }
  }
  assert.strictEqual(pairQueries, PAIR_QUERIES);
  const updateMs = performance.now() - updateStarted;

  verifyTracked("final");

  const totalMs = performance.now() - startedAt;
  const peakRss = peakRssBytes();
  console.log(
    `[stress] load=${loadMs.toFixed(0)}ms save=${saveMs.toFixed(0)}ms ` +
      `updates+queries=${updateMs.toFixed(0)}ms total=${totalMs.toFixed(0)}ms ` +
      `peakRSS=${formatMiB(peakRss)} wide=${nexus.stats("wide").count} ` +
      `narrow=${nexus.stats("narrow").count} intersection=${nexus.stats("wide", "narrow").intersection}`,
  );
  assert.ok(totalMs < TIME_LIMIT_MS, `stress test took ${totalMs.toFixed(0)}ms, limit ${TIME_LIMIT_MS}ms`);
  assert.ok(
    peakRss < RSS_LIMIT_BYTES,
    `peak RSS ${formatMiB(peakRss)} exceeds ${formatMiB(RSS_LIMIT_BYTES)}`,
  );
});
