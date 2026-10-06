import test from 'node:test';
import assert from 'node:assert/strict';
import { AudienceNexus, ProfileRecord, RuleGroup } from '../src/index';
import { makeRng, randomRule } from './helpers';

const PROFILE_COUNT = 100_000;
const SEGMENT_COUNT = 2_000;
const REGION_COUNT = 20_000;
const TAG_COUNT = 50_000;
const BATCHES = 100;
const BATCH_SIZE = 128;
const PAIR_QUERIES = 2_000;
const MAX_TAGS_PER_PROFILE = 8;
const RSS_LIMIT_BYTES = 384 * 1024 * 1024;
const TIME_LIMIT_MS = 60_000;

const DENSE_TAGS = ['dense-0', 'dense-1', 'dense-2'];
const NARROW_TAG = 'tag-12345';
const NARROW_REGION = 'region-777';

const regions = Array.from({ length: REGION_COUNT }, (_, i) => 'region-' + i);
const tags = Array.from({ length: TAG_COUNT }, (_, i) => 'tag-' + i);
const allTags = tags.concat(DENSE_TAGS);

interface MirrorProfile {
  engagementScore: number | null;
  region: string | null;
  purchaseTags: readonly string[];
}

// Wide segment: dense tag (on ~90% of profiles) OR low score band.
const WIDE_RULE: RuleGroup = {
  type: 'or',
  children: [
    { type: 'tag', value: DENSE_TAGS[0] },
    { type: 'scoreRange', min: 0, max: 10 },
  ],
};
// Narrow segment: one sparse tag AND one specific region AND a score band.
const NARROW_RULE: RuleGroup = {
  type: 'and',
  children: [
    { type: 'tag', value: NARROW_TAG },
    { type: 'region', value: NARROW_REGION },
    { type: 'scoreRange', min: 30, max: 60 },
  ],
};

function wideMatch(p: MirrorProfile): boolean {
  return (
    p.purchaseTags.includes(DENSE_TAGS[0]) ||
    (p.engagementScore !== null && p.engagementScore <= 10)
  );
}

function narrowMatch(p: MirrorProfile): boolean {
  return (
    p.purchaseTags.includes(NARROW_TAG) &&
    p.region === NARROW_REGION &&
    p.engagementScore !== null &&
    p.engagementScore >= 30 &&
    p.engagementScore <= 60
  );
}

function makeRecord(rng: () => number, userId: string): ProfileRecord {
  const roll = rng();
  const engagementScore =
    roll < 0.1 ? null : roll < 0.16 ? (rng() < 0.5 ? 0 : 100) : Math.floor(rng() * 101);
  const region =
    rng() < 0.1 ? null : regions[Math.floor(Math.pow(rng(), 3) * REGION_COUNT)];
  const purchaseTags = new Set<string>();
  for (const dense of DENSE_TAGS) if (rng() < 0.9) purchaseTags.add(dense);
  while (purchaseTags.size < MAX_TAGS_PER_PROFILE && rng() < 0.7) {
    purchaseTags.add(allTags[Math.floor(rng() * allTags.length)]);
  }
  return { userId, engagementScore, region, purchaseTags: [...purchaseTags] };
}

function peakRssBytes(): number {
  // process.resourceUsage().maxRSS is reported in kilobytes on all platforms.
  return process.resourceUsage().maxRSS * 1024;
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1) + ' MiB';
}

test('stress: 100k profiles, 2k segments, 100 update batches, 2k pair queries', () => {
  const startedAt = process.hrtime.bigint();
  const elapsedMs = () => Number(process.hrtime.bigint() - startedAt) / 1e6;
  const rng = makeRng(20261008);
  const engine = new AudienceNexus();
  const mirror = new Map<string, MirrorProfile>();

  // Phase 1: full load.
  const loadStarted = elapsedMs();
  for (let i = 0; i < PROFILE_COUNT; i++) {
    const record = makeRecord(rng, 'u' + i);
    engine.upsertBatch([record]);
    mirror.set(record.userId, {
      engagementScore: record.engagementScore,
      region: record.region,
      purchaseTags: record.purchaseTags as readonly string[],
    });
  }
  const loadMs = elapsedMs() - loadStarted;

  // Phase 2: define and save all segments.
  const segmentRules = new Map<string, RuleGroup>();
  segmentRules.set('wide', WIDE_RULE);
  segmentRules.set('narrow', NARROW_RULE);
  for (let i = 0; i < 98; i++) {
    segmentRules.set('wide-' + i, {
      type: 'or',
      children: [
        { type: 'tag', value: DENSE_TAGS[i % DENSE_TAGS.length] },
        { type: 'scoreRange', min: 0, max: 5 + Math.floor(rng() * 30) },
      ],
    });
  }
  for (let i = 0; i < 100; i++) {
    const lo = Math.floor(rng() * 80);
    segmentRules.set('narrow-' + i, {
      type: 'and',
      children: [
        { type: 'tag', value: tags[Math.floor(rng() * TAG_COUNT)] },
        { type: 'region', value: regions[Math.floor(rng() * REGION_COUNT)] },
        { type: 'scoreRange', min: lo, max: lo + Math.floor(rng() * 20) },
      ],
    });
  }
  while (segmentRules.size < SEGMENT_COUNT) {
    const id = 'seg-' + segmentRules.size;
    segmentRules.set(
      id,
      randomRule(rng, { regions, tags: allTags, maxDepth: 3, leafBudget: { value: 16 } }),
    );
  }
  const saveStarted = elapsedMs();
  for (const [id, rule] of segmentRules) engine.saveSegment(id, rule);
  const saveMs = elapsedMs() - saveStarted;

  const expectedCounts = () => {
    let wide = 0;
    let narrow = 0;
    let both = 0;
    for (const profile of mirror.values()) {
      const w = wideMatch(profile);
      const n = narrowMatch(profile);
      if (w) wide++;
      if (n) narrow++;
      if (w && n) both++;
    }
    return { wide, narrow, both };
  };

  const verifyWideNarrow = (label: string) => {
    const expected = expectedCounts();
    const pair = engine.stats('wide', 'narrow');
    assert.equal(pair.countA, expected.wide, label + ': wide count');
    assert.equal(pair.countB, expected.narrow, label + ': narrow count');
    assert.equal(pair.intersection, expected.both, label + ': wide x narrow');
    assert.ok(expected.wide > PROFILE_COUNT * 0.85, 'wide segment should cover >85%');
  };
  verifyWideNarrow('after save');

  // Phase 3: 100 batches of 128 updates, interleaved with pair queries.
  const segmentIds = [...segmentRules.keys()];
  const updateStarted = elapsedMs();
  let queriesDone = 0;
  for (let batch = 0; batch < BATCHES; batch++) {
    const records: ProfileRecord[] = [];
    for (let j = 0; j < BATCH_SIZE; j++) {
      const userId = 'u' + Math.floor(rng() * PROFILE_COUNT);
      records.push(makeRecord(rng, userId));
      if (rng() < 0.05) records.push(makeRecord(rng, userId)); // duplicate in batch
    }
    engine.upsertBatch(records);
    const deduped = new Map(records.map((record) => [record.userId, record]));
    for (const record of deduped.values()) {
      mirror.set(record.userId, {
        engagementScore: record.engagementScore,
        region: record.region,
        purchaseTags: record.purchaseTags as readonly string[],
      });
    }
    const queriesThisBatch = Math.min(
      Math.ceil((PAIR_QUERIES - queriesDone) / (BATCHES - batch)),
      PAIR_QUERIES - queriesDone,
    );
    for (let q = 0; q < queriesThisBatch; q++) {
      const a = segmentIds[Math.floor(rng() * segmentIds.length)];
      const b = segmentIds[Math.floor(rng() * segmentIds.length)];
      const pair = engine.stats(a, b);
      assert.ok(pair.intersection <= Math.min(pair.countA, pair.countB));
      assert.ok(pair.intersection >= 0);
      if (a === b) assert.equal(pair.intersection, pair.countA);
      queriesDone++;
    }
    if ((batch + 1) % 10 === 0) verifyWideNarrow('after batch ' + (batch + 1));
  }
  const updateMs = elapsedMs() - updateStarted;
  assert.equal(queriesDone, PAIR_QUERIES);
  verifyWideNarrow('final');

  const totalMs = elapsedMs();
  const peak = peakRssBytes();
  console.log(
    '[stress] load=' +
      loadMs.toFixed(0) +
      'ms save=' +
      saveMs.toFixed(0) +
      'ms updates+queries=' +
      updateMs.toFixed(0) +
      'ms total=' +
      totalMs.toFixed(0) +
      'ms peakRSS=' +
      mb(peak),
  );
  assert.ok(totalMs < TIME_LIMIT_MS, 'stress test exceeded 60s: ' + totalMs.toFixed(0) + 'ms');
  assert.ok(peak < RSS_LIMIT_BYTES, 'peak RSS exceeded 384 MiB: ' + mb(peak));
});
