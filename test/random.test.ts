import test from 'node:test';
import assert from 'node:assert/strict';
import { AudienceNexus, RuleGroup } from '../src/index';
import {
  makeRng,
  pick,
  randomRecord,
  randomRule,
  refCount,
  refIntersection,
  RefProfile,
} from './helpers';

test('randomized differential test against per-profile reference evaluation', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const rng = makeRng(seed * 7919);
    const regions = Array.from({ length: 8 }, (_, i) => 'region-' + i);
    const tags = Array.from({ length: 20 }, (_, i) => 'tag-' + i);
    const userPool = Array.from({ length: 40 }, (_, i) => 'user-' + i);

    const engine = new AudienceNexus();
    const mirror = new Map<string, RefProfile>();
    const segmentRules = new Map<string, RuleGroup>();

    const checkAll = (label: string) => {
      for (const [segmentId, rule] of segmentRules) {
        const expected = refCount(rule, mirror.values());
        assert.equal(
          (engine.stats(segmentId) as { count: number }).count,
          expected,
          label + ': count mismatch for ' + segmentId + ' (seed ' + seed + ')',
        );
      }
      const ids = [...segmentRules.keys()];
      for (let i = 0; i < 6 && ids.length > 0; i++) {
        const a = pick(rng, ids);
        const b = pick(rng, ids);
        const pair = engine.stats(a, b) as {
          countA: number;
          countB: number;
          intersection: number;
        };
        assert.equal(pair.countA, refCount(segmentRules.get(a)!, mirror.values()));
        assert.equal(pair.countB, refCount(segmentRules.get(b)!, mirror.values()));
        assert.equal(
          pair.intersection,
          refIntersection(segmentRules.get(a)!, segmentRules.get(b)!, mirror.values()),
          label + ': intersection mismatch for ' + a + ' x ' + b + ' (seed ' + seed + ')',
        );
      }
      if (ids.length > 0) {
        const self = pick(rng, ids);
        const pair = engine.stats(self, self) as { countA: number; intersection: number };
        assert.equal(pair.intersection, pair.countA, label + ': self intersection');
      }
    };

    const saveRandomSegment = (segmentId: string) => {
      // Deliberately allow duplicate leaves / overlapping OR branches.
      const rule = randomRule(rng, {
        regions,
        tags,
        maxDepth: 3,
        leafBudget: { value: 16 },
      });
      if (rng() < 0.3 && rule.children.length > 0) {
        const clone = JSON.parse(JSON.stringify(rule.children[0]));
        (rule.children as unknown[]).push(clone);
      }
      engine.saveSegment(segmentId, rule);
      segmentRules.set(segmentId, rule);
    };

    for (let i = 0; i < 25; i++) saveRandomSegment('seg-' + i);
    checkAll('initial segments');

    for (let op = 0; op < 300; op++) {
      const roll = rng();
      if (roll < 0.7) {
        const batchSize = 1 + Math.floor(rng() * 12);
        const batch = [];
        for (let j = 0; j < batchSize; j++) {
          const userId = pick(rng, userPool);
          batch.push(randomRecord(rng, userId, regions, tags));
          // Duplicate userIds inside one batch: last record must win.
          if (rng() < 0.15) batch.push(randomRecord(rng, userId, regions, tags));
        }
        engine.upsertBatch(batch);
        const deduped = new Map(batch.map((record) => [record.userId, record]));
        for (const record of deduped.values()) {
          mirror.set(record.userId, {
            userId: record.userId,
            engagementScore: record.engagementScore,
            region: record.region,
            purchaseTags: new Set(record.purchaseTags),
          });
        }
        checkAll('after upsertBatch op ' + op);
      } else {
        const existing = [...segmentRules.keys()];
        const segmentId =
          existing.length > 0 && rng() < 0.6 ? pick(rng, existing) : 'seg-extra-' + op;
        saveRandomSegment(segmentId);
        checkAll('after saveSegment op ' + op);
      }
    }
  }
});
