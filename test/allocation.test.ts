import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCumulativeShares } from '../src/allocation.ts';

test('zero refund allocates nothing', () => {
  assert.deepEqual(computeCumulativeShares(0, 9, { merchant: 5, platform: 3, partner: 1 }), {
    merchant: 0,
    platform: 0,
    partner: 0,
  });
});

test('largest remainder with merchant/platform/partner tie order', () => {
  // refunded 4 of 9: floors 2/1/0, remainders 2/3/4 -> partner gets the extra cent
  assert.deepEqual(computeCumulativeShares(4, 9, { merchant: 5, platform: 3, partner: 1 }), {
    merchant: 2,
    platform: 1,
    partner: 1,
  });
  // refunded 5 of 9: floors 2/1/0, remainders 7/6/5 -> merchant and platform get extras
  assert.deepEqual(computeCumulativeShares(5, 9, { merchant: 5, platform: 3, partner: 1 }), {
    merchant: 3,
    platform: 2,
    partner: 0,
  });
});

test('equal remainders break ties by merchant, platform, partner', () => {
  // refunded 1 of 3 with equal shares: all remainders equal -> merchant wins
  assert.deepEqual(computeCumulativeShares(1, 3, { merchant: 1, platform: 1, partner: 1 }), {
    merchant: 1,
    platform: 0,
    partner: 0,
  });
  assert.deepEqual(computeCumulativeShares(2, 3, { merchant: 1, platform: 1, partner: 1 }), {
    merchant: 1,
    platform: 1,
    partner: 0,
  });
});

test('shares always sum to refunded total', () => {
  const original = { merchant: 2_500_000, platform: 1_500_000, partner: 1_000_000 };
  const total = 5_000_000;
  for (const refunded of [1, 7, 999, 123_456, 2_499_999, 4_999_999, 5_000_000]) {
    const shares = computeCumulativeShares(refunded, total, original);
    assert.equal(shares.merchant + shares.platform + shares.partner, refunded);
  }
});

test('full refund returns original amounts exactly', () => {
  const original = { merchant: 5, platform: 3, partner: 1 };
  assert.deepEqual(computeCumulativeShares(9, 9, original), original);
});
