import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Activity,
  Cart,
  recommendLowestPrice,
  StackablePair,
} from "../src/index";

const abcdCart: Cart = [
  { sku: "A", unitPriceCents: 1000, quantity: 1 },
  { sku: "B", unitPriceCents: 900, quantity: 1 },
  { sku: "C", unitPriceCents: 400, quantity: 1 },
  { sku: "D", unitPriceCents: 300, quantity: 1 },
];

const buy1Get1Activity1: Activity = {
  type: "buyXGetY",
  id: "act1",
  thresholdSkus: ["A", "C"],
  giftSkus: ["B", "D"],
  x: 1,
  y: 1,
};

const buy1Get1Activity2: Activity = {
  type: "buyXGetY",
  id: "act2",
  thresholdSkus: ["B"],
  giftSkus: ["A"],
  x: 1,
  y: 1,
};

test("stacked buy-one-get-one activities share units without double use", () => {
  const pairs: StackablePair[] = [
    { activityIdA: "act1", activityIdB: "act2" },
  ];
  const result = recommendLowestPrice(
    abcdCart,
    [buy1Get1Activity1, buy1Get1Activity2],
    pairs
  );
  // act1: threshold C, gift D (300); act2: threshold B, gift A (1000).
  // payable = 2600 - 1300 = 1300.
  assert.equal(result.payableCents, 1300);
  assert.deepEqual([...result.selectedActivityIds].sort(), ["act1", "act2"]);

  const usedRoles: string[] = [];
  for (const alloc of result.allocations) {
    for (const [sku, qty] of Object.entries(alloc.threshold)) {
      for (let i = 0; i < qty; i++) usedRoles.push(`t:${sku}`);
    }
    for (const [sku, qty] of Object.entries(alloc.gift)) {
      for (let i = 0; i < qty; i++) usedRoles.push(`g:${sku}`);
    }
  }
  // Each unit takes at most one role across both activities.
  const skusUsed = usedRoles.map((role) => role.slice(2));
  assert.equal(new Set(skusUsed).size, skusUsed.length);
});

test("non-stackable buy-one-get-one activities are not combined", () => {
  const result = recommendLowestPrice(
    abcdCart,
    [buy1Get1Activity1, buy1Get1Activity2],
    []
  );
  // Best single activity: act2 gifts A (1000) -> 2600 - 1000 = 1600.
  assert.equal(result.payableCents, 1600);
  assert.equal(result.selectedActivityIds.length, 1);
});

test("no activity selected when nothing helps", () => {
  const result = recommendLowestPrice(abcdCart, [], []);
  assert.equal(result.payableCents, 2600);
  assert.deepEqual(result.selectedActivityIds, []);
  assert.deepEqual(result.allocations, []);
});

test("percent-off floors to cents only once at the end", () => {
  const cart: Cart = [{ sku: "A", unitPriceCents: 105, quantity: 1 }];
  const tenOff1: Activity = { type: "percentOff", id: "p1", percent: 10 };
  const tenOff2: Activity = { type: "percentOff", id: "p2", percent: 10 };
  const pairs: StackablePair[] = [{ activityIdA: "p1", activityIdB: "p2" }];
  const result = recommendLowestPrice(cart, [tenOff1, tenOff2], pairs);
  // Exact: floor(105 * 90 * 90 / 10000) = floor(85.05) = 85.
  // Intermediate rounding would give 84.
  assert.equal(result.payableCents, 85);
});

test("single percent-off rounds down fractional cents", () => {
  const cart: Cart = [{ sku: "A", unitPriceCents: 999, quantity: 1 }];
  const tenOff: Activity = { type: "percentOff", id: "p1", percent: 10 };
  const result = recommendLowestPrice(cart, [tenOff], []);
  // floor(999 * 90 / 100) = floor(899.1) = 899.
  assert.equal(result.payableCents, 899);
});

test("fixed amount off applies after percent and clamps at zero", () => {
  const cart: Cart = [{ sku: "A", unitPriceCents: 100, quantity: 1 }];
  const halfOff: Activity = { type: "percentOff", id: "p", percent: 50 };
  const fixed: Activity = { type: "fixedOff", id: "f", amountCents: 200 };
  const pairs: StackablePair[] = [{ activityIdA: "p", activityIdB: "f" }];
  const result = recommendLowestPrice(cart, [halfOff, fixed], pairs);
  // 100 * 50 / 100 = 50; 50 - 200 < 0 -> 0.
  assert.equal(result.payableCents, 0);
});

test("gift value maximization respects overlapping sku sets", () => {
  // Only A is eligible for both roles; the single A unit cannot do both.
  const cart: Cart = [
    { sku: "A", unitPriceCents: 500, quantity: 1 },
    { sku: "B", unitPriceCents: 500, quantity: 1 },
  ];
  const activity: Activity = {
    type: "buyXGetY",
    id: "bxgy",
    thresholdSkus: ["A"],
    giftSkus: ["A", "B"],
    x: 1,
    y: 1,
  };
  const result = recommendLowestPrice(cart, [activity], []);
  // A must be the threshold, so only B can be gifted: 1000 - 500 = 500.
  assert.equal(result.payableCents, 500);
  assert.deepEqual(result.allocations[0].gift, { B: 1 });
});

test("infeasible buy-x-get-y activity is skipped", () => {
  const cart: Cart = [{ sku: "A", unitPriceCents: 100, quantity: 1 }];
  const activity: Activity = {
    type: "buyXGetY",
    id: "bxgy",
    thresholdSkus: ["A"],
    giftSkus: ["B"],
    x: 1,
    y: 1,
  };
  const result = recommendLowestPrice(cart, [activity], []);
  assert.equal(result.payableCents, 100);
  assert.deepEqual(result.selectedActivityIds, []);
});
