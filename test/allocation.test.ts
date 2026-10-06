import assert from "node:assert/strict";
import { test } from "node:test";
import { computeCumulativeShares } from "../src/index.js";

const splits = { merchant: 5, platform: 3, partner: 1 };

test("zero refund yields zero shares", () => {
  assert.deepEqual(computeCumulativeShares(0, 9, splits), {
    merchant: 0,
    platform: 0,
    partner: 0,
  });
});

test("shares always sum to refunded total", () => {
  for (let refunded = 0; refunded <= 9; refunded += 1) {
    const shares = computeCumulativeShares(refunded, 9, splits);
    assert.equal(
      shares.merchant + shares.platform + shares.partner,
      refunded,
      `refunded=${refunded}`,
    );
  }
});

test("largest remainder with merchant/platform/partner tie-break", () => {
  assert.deepEqual(computeCumulativeShares(4, 9, splits), {
    merchant: 2,
    platform: 1,
    partner: 1,
  });
  assert.deepEqual(computeCumulativeShares(5, 9, splits), {
    merchant: 3,
    platform: 2,
    partner: 0,
  });
});

test("equal remainders resolve by merchant, platform, partner order", () => {
  const even = { merchant: 1, platform: 1, partner: 1 };
  assert.deepEqual(computeCumulativeShares(1, 3, even), {
    merchant: 1,
    platform: 0,
    partner: 0,
  });
  assert.deepEqual(computeCumulativeShares(2, 3, even), {
    merchant: 1,
    platform: 1,
    partner: 0,
  });
});
