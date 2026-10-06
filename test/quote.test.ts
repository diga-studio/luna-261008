import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestQuote } from '../src/index.js';
import type { Activity, CartLine, QuoteResult } from '../src/index.js';

function cartOf(entries: [string, number, number][]): CartLine[] {
  return entries.map(([sku, unitPriceCents, quantity]) => ({
    sku,
    unitPriceCents,
    quantity,
  }));
}

/** 校验结果中的买赠分配本身合法：份数恰好、角色不冲突、不超出购物车 */
function assertAllocationsValid(
  result: QuoteResult,
  activities: readonly Activity[],
  cart: readonly CartLine[],
): void {
  const used = new Map<string, number>();
  for (const alloc of result.allocations) {
    const activity = activities.find(
      (a): a is Extract<Activity, { kind: 'buyXGetY' }> =>
        a.kind === 'buyXGetY' && a.id === alloc.activityId,
    );
    assert.ok(activity, `allocation references activity ${alloc.activityId}`);
    const thresholdTotal = Object.values(alloc.thresholds).reduce((s, n) => s + n, 0);
    const giftTotal = Object.values(alloc.gifts).reduce((s, n) => s + n, 0);
    assert.equal(thresholdTotal, activity.x);
    assert.equal(giftTotal, activity.y);
    for (const sku of Object.keys(alloc.thresholds)) {
      assert.ok(activity.thresholdSkus.includes(sku));
    }
    for (const sku of Object.keys(alloc.gifts)) {
      assert.ok(activity.giftSkus.includes(sku));
    }
    for (const [sku, n] of [
      ...Object.entries(alloc.thresholds),
      ...Object.entries(alloc.gifts),
    ]) {
      used.set(sku, (used.get(sku) ?? 0) + n);
    }
  }
  for (const line of cart) {
    assert.ok(
      (used.get(line.sku) ?? 0) <= line.quantity,
      `sku ${line.sku} over-used`,
    );
  }
}

test('题目场景：两个买赠叠加，最低应付 1300 美分', () => {
  const cart = cartOf([
    ['A', 1000, 1],
    ['B', 900, 1],
    ['C', 400, 1],
    ['D', 300, 1],
  ]);
  const activities: Activity[] = [
    {
      kind: 'buyXGetY',
      id: 'act1',
      thresholdSkus: ['A', 'C'],
      giftSkus: ['B', 'D'],
      x: 1,
      y: 1,
    },
    {
      kind: 'buyXGetY',
      id: 'act2',
      thresholdSkus: ['B'],
      giftSkus: ['A'],
      x: 1,
      y: 1,
    },
  ];
  const result = bestQuote({
    cart,
    activities,
    stackablePairs: [['act1', 'act2']],
  });
  assert.equal(result.payableCents, 1300);
  assert.deepEqual([...result.selectedActivityIds].sort(), ['act1', 'act2']);
  assertAllocationsValid(result, activities, cart);
});

test('百分比优惠仅在最后向下取整到美分', () => {
  // 999 * 0.9 = 899.1 -> 899
  const result = bestQuote({
    cart: cartOf([['A', 999, 1]]),
    activities: [{ kind: 'percentOff', id: 'p10', percentOff: 10 }],
    stackablePairs: [],
  });
  assert.equal(result.payableCents, 899);
  assert.deepEqual(result.selectedActivityIds, ['p10']);
});

test('两个百分比叠乘只在最终取整一次', () => {
  // 整体一次取整：floor(101 * 0.93 * 0.93) = floor(87.3549) = 87
  // 若分步取整则会得到 floor(floor(101*0.93)*0.93) = floor(93*0.93) = 86
  const result = bestQuote({
    cart: cartOf([['A', 101, 1]]),
    activities: [
      { kind: 'percentOff', id: 'p7a', percentOff: 7 },
      { kind: 'percentOff', id: 'p7b', percentOff: 7 },
    ],
    stackablePairs: [['p7a', 'p7b']],
  });
  assert.equal(result.payableCents, 87);
});

test('不选任何活动时按原价应付', () => {
  const result = bestQuote({
    cart: cartOf([
      ['A', 1000, 2],
      ['B', 500, 1],
    ]),
    activities: [],
    stackablePairs: [],
  });
  assert.equal(result.payableCents, 2500);
  assert.deepEqual(result.selectedActivityIds, []);
  assert.deepEqual(result.allocations, []);
});

test('固定减免与百分比按顺序计算，应付最低为 0', () => {
  // (1000 - 0) * 0.5 = 500，再减 600 -> 0
  const result = bestQuote({
    cart: cartOf([['A', 1000, 1]]),
    activities: [
      { kind: 'percentOff', id: 'p50', percentOff: 50 },
      { kind: 'fixedOff', id: 'f600', amountOffCents: 600 },
    ],
    stackablePairs: [['p50', 'f600']],
  });
  assert.equal(result.payableCents, 0);
});

test('未声明可叠加的两个活动不能同时使用', () => {
  const result = bestQuote({
    cart: cartOf([['A', 1000, 1]]),
    activities: [
      { kind: 'percentOff', id: 'p10', percentOff: 10 },
      { kind: 'fixedOff', id: 'f100', amountOffCents: 100 },
    ],
    stackablePairs: [],
  });
  // 只能二选一：900 或 900，最低 900
  assert.equal(result.payableCents, 900);
  assert.equal(result.selectedActivityIds.length, 1);
});

test('同一份餐品不能同时当门槛品和赠品', () => {
  // 1 份 A：若允许自用自赠则免单 1000；正确行为是活动不可选，应付 1000
  const activities: Activity[] = [
    {
      kind: 'buyXGetY',
      id: 'bxgy',
      thresholdSkus: ['A'],
      giftSkus: ['A'],
      x: 1,
      y: 1,
    },
  ];
  const result = bestQuote({
    cart: cartOf([['A', 1000, 1]]),
    activities,
    stackablePairs: [],
  });
  assert.equal(result.payableCents, 1000);
  assert.deepEqual(result.selectedActivityIds, []);
});

test('赠品不限定为最低价餐品，取赠品原价最大的合法分配', () => {
  const activities: Activity[] = [
    {
      kind: 'buyXGetY',
      id: 'bxgy',
      thresholdSkus: ['A'],
      giftSkus: ['B', 'C'],
      x: 1,
      y: 1,
    },
  ];
  const cart = cartOf([
    ['A', 100, 1],
    ['B', 900, 1],
    ['C', 500, 1],
  ]);
  const result = bestQuote({ cart, activities, stackablePairs: [] });
  // 1500 - 900 = 600
  assert.equal(result.payableCents, 600);
  assertAllocationsValid(result, activities, cart);
});

test('买赠条件不满足时回退到其他活动', () => {
  const activities: Activity[] = [
    {
      kind: 'buyXGetY',
      id: 'bxgy',
      thresholdSkus: ['A'],
      giftSkus: ['B'],
      x: 2,
      y: 1,
    },
    { kind: 'fixedOff', id: 'f50', amountOffCents: 50 },
  ];
  const result = bestQuote({
    cart: cartOf([['A', 1000, 1]]),
    activities,
    stackablePairs: [['bxgy', 'f50']],
  });
  assert.equal(result.payableCents, 950);
  assert.deepEqual(result.selectedActivityIds, ['f50']);
});

test('多份数量下每份餐品在两个买赠活动中最多用一次', () => {
  const activities: Activity[] = [
    {
      kind: 'buyXGetY',
      id: 'g1',
      thresholdSkus: ['A'],
      giftSkus: ['B'],
      x: 1,
      y: 1,
    },
    {
      kind: 'buyXGetY',
      id: 'g2',
      thresholdSkus: ['B'],
      giftSkus: ['A'],
      x: 1,
      y: 1,
    },
  ];
  const cart = cartOf([
    ['A', 1000, 1],
    ['B', 800, 1],
  ]);
  const result = bestQuote({
    cart,
    activities,
    stackablePairs: [['g1', 'g2']],
  });
  // g1: 门槛 A、赠 B(800)；g2 无剩余 B 当门槛 -> 不可同用
  // 最优单用 g1 或 g2：1800-1000=800（g2 赠 A）
  assert.equal(result.payableCents, 800);
  assertAllocationsValid(result, activities, cart);
});
