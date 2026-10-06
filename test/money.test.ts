import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baselineAmount, withinTolerance } from '../src/index.js';

test('基准金额：仅最后一步四舍五入到分，半分向上', () => {
  assert.equal(baselineAmount(1000n, 5n), 5n); // 1 单位 * 5 分
  assert.equal(baselineAmount(100n, 5n), 1n); // 0.5 分 -> 半分向上为 1
  assert.equal(baselineAmount(99n, 5n), 0n); // 0.495 分 -> 0
  assert.equal(baselineAmount(300n, 5n), 2n); // 1.5 分 -> 2
  assert.equal(baselineAmount(0n, 5n), 0n);
  assert.equal(baselineAmount(2500n, 0n), 0n);
});

test('容差比较：恰好 2% 通过，超过不通过', () => {
  // 基准 100 分，偏差 2 分 = 恰好 2%
  assert.equal(withinTolerance(102n, 1000n, 100n), true);
  assert.equal(withinTolerance(98n, 1000n, 100n), true);
  assert.equal(withinTolerance(103n, 1000n, 100n), false);
  assert.equal(withinTolerance(97n, 1000n, 100n), false);
});

test('容差比较：基准为零时金额只能为零', () => {
  assert.equal(withinTolerance(0n, 0n, 100n), true);
  assert.equal(withinTolerance(1n, 0n, 100n), false);
  assert.equal(withinTolerance(0n, 1000n, 0n), true);
  assert.equal(withinTolerance(1n, 1000n, 0n), false);
});

test('容差比较：不舍入，依据已舍入基准精确判断', () => {
  // 票量 155 千分之一 * 100 分 = 15.5 分 -> 基准 16 分；2% = 0.32 分，任何 1 分偏差都不通过
  assert.equal(withinTolerance(16n, 155n, 100n), true);
  assert.equal(withinTolerance(15n, 155n, 100n), false);
  assert.equal(withinTolerance(17n, 155n, 100n), false);
});

test('18 位整数精确计算：double 无法区分的边界', () => {
  // 精确基准 = 2^53 = 9007199254740992（double 从 2^53+1 起丢失精度）
  const qty = 9007199254740992n; // 16 位
  const price = 1000n;
  const baseline = baselineAmount(qty, price);
  assert.equal(baseline, 9007199254740992n);
  // 2% = 180143985094819.84：偏差 180143985094819 通过，180143985094820 不通过
  assert.equal(withinTolerance(baseline + 180143985094819n, qty, price), true);
  assert.equal(withinTolerance(baseline + 180143985094820n, qty, price), false);
  // 18 位上限值相乘不溢出、不丢精度
  const big = 999999999999999999n;
  const b2 = baselineAmount(big, big);
  assert.equal(b2, (big * big + 500n) / 1000n);
  assert.equal(withinTolerance(b2, big, big), true);
  assert.equal(withinTolerance(b2 + b2 / 50n + 1n, big, big), false);
});
