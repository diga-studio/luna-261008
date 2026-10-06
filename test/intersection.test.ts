import test from 'node:test';
import assert from 'node:assert/strict';
import { AudienceNexus, ProfileRecord, RuleGroup } from '../src/index';

// Two segments share the score band [50, 100] but differ on the second
// condition: A requires region "cn", B requires tag "vip".
const segmentA: RuleGroup = {
  type: 'and',
  children: [
    { type: 'scoreRange', min: 50, max: 100 },
    { type: 'region', value: 'cn' },
  ],
};
const segmentB: RuleGroup = {
  type: 'and',
  children: [
    { type: 'scoreRange', min: 50, max: 100 },
    { type: 'tag', value: 'vip' },
  ],
};

function record(
  userId: string,
  engagementScore: number | null,
  region: string | null,
  purchaseTags: string[],
): ProfileRecord {
  return { userId, engagementScore, region, purchaseTags };
}

test('shared-rule segments: one batch causes enter / exit / stay in the intersection', () => {
  const engine = new AudienceNexus();

  engine.upsertBatch([
    record('stay', 80, 'cn', ['vip']), // in A and B, stays in both
    record('exit', 90, 'cn', ['vip']), // in A and B, will leave both
    record('enter', 10, 'us', []), // in neither, will enter both
    record('only-a', 60, 'cn', []), // in A only, stays in A only
    record('only-b', 70, 'us', ['vip']), // in B only, stays in B only
    record('swap', 75, 'cn', []), // in A only, will move to B only
    record('null-out', 85, 'cn', ['vip']), // in both, score becomes null
  ]);
  engine.saveSegment('A', segmentA);
  engine.saveSegment('B', segmentB);

  // A = { stay, exit, only-a, swap, null-out }, B = { stay, exit, only-b, null-out }.
  assert.deepEqual(engine.stats('A', 'B'), { countA: 5, countB: 4, intersection: 3 });

  engine.upsertBatch([
    record('stay', 95, 'cn', ['vip', 'extra']), // still in both
    record('exit', 40, 'cn', ['vip']), // score drops below 50: leaves both
    record('enter', 100, 'cn', ['vip']), // enters both
    record('swap', 75, 'us', ['vip']), // leaves A (region), enters B (tag)
    record('null-out', null, 'cn', ['vip']), // score null: leaves both
  ]);

  const pair = engine.stats('A', 'B');
  // A = { stay, enter, only-a } = 3, B = { stay, enter, only-b, swap } = 4,
  // intersection = { stay, enter } = 2.
  assert.deepEqual(pair, { countA: 3, countB: 4, intersection: 2 });
  assert.deepEqual(engine.stats('A'), { count: 3 });
  assert.deepEqual(engine.stats('B'), { count: 4 });
  assert.deepEqual(engine.stats('A', 'A'), { countA: 3, countB: 3, intersection: 3 });

  // Replacing one segment must not disturb the other.
  engine.saveSegment('A', {
    type: 'or',
    children: [
      { type: 'tag', value: 'vip' },
      { type: 'scoreRange', min: 0, max: 10 },
    ],
  });
  // A' = all six vip holders { stay, exit, enter, only-b, swap, null-out };
  // B unchanged = { stay, enter, only-b, swap } and is a subset of A'.
  assert.deepEqual(engine.stats('A', 'B'), { countA: 6, countB: 4, intersection: 4 });
  assert.deepEqual(engine.stats('B'), { count: 4 });
});
