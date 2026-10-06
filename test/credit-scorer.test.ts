import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CreditScorer } from '../src/index.js';
import type { DimensionValues, Weights } from '../src/index.js';

// ---------- 独立于库实现的历史重建器（精确有理数） ----------

interface Frac {
  n: bigint;
  d: bigint;
}

function fracGcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0n ? 1n : x;
}

function frac(n: bigint, d: bigint): Frac {
  if (d < 0n) return frac(-n, -d);
  const g = fracGcd(n, d);
  return { n: n / g, d: d / g };
}

function fracFromNumber(value: number): Frac {
  const text = value.toString().toLowerCase();
  const [mantissaPart, exponentPart] = text.split('e');
  const exponent = exponentPart === undefined ? 0 : Number(exponentPart);
  const negative = mantissaPart.startsWith('-');
  const mantissa = negative ? mantissaPart.slice(1) : mantissaPart;
  const [intPart, fracPart = ''] = mantissa.split('.');
  const digits = BigInt((intPart === '' ? '0' : intPart) + fracPart);
  const num = negative ? -digits : digits;
  const scale = fracPart.length - exponent;
  return scale >= 0
    ? frac(num, 10n ** BigInt(scale))
    : frac(num * 10n ** BigInt(-scale), 1n);
}

function fracAdd(a: Frac, b: Frac): Frac {
  return frac(a.n * b.d + b.n * a.d, a.d * b.d);
}

function fracMul(a: Frac, b: Frac): Frac {
  return frac(a.n * b.n, a.d * b.d);
}

type Event =
  | { kind: 'configure'; weights: Weights }
  | {
      kind: 'record';
      subjectId: string;
      ratingId: string;
      values: DimensionValues;
    };

/** 从完整历史独立重建某主体在某业务下的精确结果。 */
function rebuild(
  events: Event[],
  subjectId: string,
): { score: number; restricted: boolean } {
  let weights: Weights = {};
  const ratings = new Map<string, { subjectId: string; values: DimensionValues }>();
  for (const event of events) {
    if (event.kind === 'configure') {
      weights = { ...event.weights };
    } else {
      ratings.set(event.ratingId, {
        subjectId: event.subjectId,
        values: event.values,
      });
    }
  }

  const sums = new Map<string, bigint>();
  const counts = new Map<string, bigint>();
  for (const rating of ratings.values()) {
    if (rating.subjectId !== subjectId) continue;
    if (Object.keys(rating.values).length === 0) continue;
    for (const [label, value] of Object.entries(rating.values)) {
      if (!(label in weights)) continue;
      sums.set(label, (sums.get(label) ?? 0n) + BigInt(value));
      counts.set(label, (counts.get(label) ?? 0n) + 1n);
    }
  }

  let weightedSum = frac(0n, 1n);
  let weightTotal = frac(0n, 1n);
  for (const [label, sum] of sums) {
    const count = counts.get(label)!;
    const weight = fracFromNumber(weights[label]);
    const average = frac(sum, 100n * count);
    weightedSum = fracAdd(weightedSum, fracMul(weight, average));
    weightTotal = fracAdd(weightTotal, weight);
  }

  const score: Frac =
    weightTotal.n === 0n
      ? frac(100n, 1n)
      : frac(weightedSum.n * weightTotal.d, weightedSum.d * weightTotal.n);
  const restricted = score.n * 1n < 40n * score.d;
  return { score: Number(score.n) / Number(score.d), restricted };
}

function assertMatchesRebuild(
  scorer: CreditScorer,
  businessId: string,
  subjectId: string,
  events: Event[],
  step: string,
): void {
  const actual = scorer.credit(businessId, subjectId);
  const expected = rebuild(events, subjectId);
  assert.ok(
    Math.abs(actual.score - expected.score) < 1e-9,
    `${step}: score ${actual.score} != rebuilt ${expected.score}`,
  );
  assert.equal(
    actual.restricted,
    expected.restricted,
    `${step}: restricted ${actual.restricted} != rebuilt ${expected.restricted}`,
  );
}

// ---------- 场景 1：多步变更，每步与历史重建核对 ----------

test('多步变更：权重、启用标签、更正删标签、撤销，每步与重建核对', () => {
  const scorer = new CreditScorer(':memory:');
  const business = 'shop-1';
  const subject = 'customer-1';
  const events: Event[] = [];

  const apply = (event: Event, step: string) => {
    events.push(event);
    if (event.kind === 'configure') {
      scorer.configure(business, event.weights);
    } else {
      scorer.record(business, event.subjectId, event.ratingId, event.values);
    }
    assertMatchesRebuild(scorer, business, subject, events, step);
  };

  apply({ kind: 'configure', weights: { a: 1, b: 1 } }, '初始配置');
  apply(
    {
      kind: 'record',
      subjectId: subject,
      ratingId: 'r1',
      values: { a: 5000, b: 8000 },
    },
    '首条评级',
  );
  // 维度观测数量不同：a 有 2 条观测，b 只有 1 条
  apply(
    { kind: 'record', subjectId: subject, ratingId: 'r2', values: { a: 3000 } },
    '第二条评级仅含 a',
  );
  // 未配置标签 c：暂不参与评分，但当前值必须保留
  apply(
    { kind: 'record', subjectId: subject, ratingId: 'r3', values: { c: 2000 } },
    '记录未配置标签 c',
  );
  apply({ kind: 'configure', weights: { a: 3, b: 1 } }, '连续改变权重（一）');
  apply({ kind: 'configure', weights: { a: 1, b: 4 } }, '连续改变权重（二）');
  // 启用此前未配置的标签 c，其保留值立即生效
  apply(
    { kind: 'configure', weights: { a: 1, b: 4, c: 2 } },
    '启用此前未配置的标签 c',
  );
  // 更正 r1：删除标签 b，b 不再由 r1 贡献
  apply(
    {
      kind: 'record',
      subjectId: subject,
      ratingId: 'r1',
      values: { a: 6000 },
    },
    '更正 r1 并删除标签 b',
  );
  // 撤销整条 r2：空映射，不恢复旧版本
  apply(
    { kind: 'record', subjectId: subject, ratingId: 'r2', values: {} },
    '撤销整条 r2',
  );
  // 撤销后再更正 r3，确认撤销记录不会被旧版本复活
  apply(
    {
      kind: 'record',
      subjectId: subject,
      ratingId: 'r3',
      values: { c: 9000, d: 1000 },
    },
    '更正 r3 并引入新的未配置标签 d',
  );

  scorer.close();
});

// ---------- 场景 2：限制邀评边界 ----------

test('精确信用分 39.995 仍限制邀评，精确 40 不限制', () => {
  const scorer = new CreditScorer(':memory:');
  scorer.configure('shop', { a: 1 });

  // (4000 + 3999) / 2 = 3999.5（0.01 分单位）=> 精确 39.995 分
  scorer.record('shop', 's-below', 'r1', { a: 4000 });
  scorer.record('shop', 's-below', 'r2', { a: 3999 });
  const below = scorer.credit('shop', 's-below');
  assert.equal(below.score, 39.995);
  assert.equal(below.restricted, true);

  // 精确 40 分：不限制
  scorer.record('shop', 's-exact', 'r3', { a: 4000 });
  const exact = scorer.credit('shop', 's-exact');
  assert.equal(exact.score, 40);
  assert.equal(exact.restricted, false);

  // 更正后精确 40：也不限制（4000 与 4000 平均为 4000）
  scorer.record('shop', 's-below', 'r2', { a: 4000 });
  const corrected = scorer.credit('shop', 's-below');
  assert.equal(corrected.score, 40);
  assert.equal(corrected.restricted, false);

  scorer.close();
});

// ---------- 附加：业务隔离、主体归属、持久化 ----------

test('业务之间的评级与配置互不影响', () => {
  const scorer = new CreditScorer(':memory:');
  scorer.configure('b1', { a: 1 });
  scorer.configure('b2', { a: 1 });
  scorer.record('b1', 's1', 'r1', { a: 1000 });
  scorer.record('b2', 's1', 'r2', { a: 9000 });

  assert.equal(scorer.credit('b1', 's1').score, 10);
  assert.equal(scorer.credit('b2', 's1').score, 90);

  scorer.configure('b2', { a: 1, b: 3 });
  scorer.record('b2', 's1', 'r3', { b: 5000 });
  assert.equal(scorer.credit('b1', 's1').score, 10);
  assert.equal(scorer.credit('b2', 's1').score, 60);

  scorer.close();
});

test('同一 ratingId 的主体归属不可变', () => {
  const scorer = new CreditScorer(':memory:');
  scorer.configure('b1', { a: 1 });
  scorer.record('b1', 's1', 'r1', { a: 5000 });
  assert.throws(() => scorer.record('b1', 's2', 'r1', { a: 8000 }));
  assert.equal(scorer.credit('b1', 's1').score, 50);
  assert.equal(scorer.credit('b1', 's2').score, 100);
  scorer.close();
});

test('无参与维度时信用分为 100 且不限制', () => {
  const scorer = new CreditScorer(':memory:');
  assert.deepEqual(scorer.credit('b1', 's1'), { score: 100, restricted: false });
  scorer.configure('b1', { a: 1 });
  scorer.record('b1', 's1', 'r1', { unconfigured: 100 });
  assert.deepEqual(scorer.credit('b1', 's1'), { score: 100, restricted: false });
  scorer.record('b1', 's1', 'r2', { a: 3000 });
  scorer.record('b1', 's1', 'r2', {});
  assert.deepEqual(scorer.credit('b1', 's1'), { score: 100, restricted: false });
  scorer.close();
});

test('SQLite 持久化：重开后结果一致且历史版本保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'credit-scorer-'));
  try {
    const dbPath = join(dir, 'credit.db');
    const first = new CreditScorer(dbPath);
    first.configure('b1', { a: 1 });
    first.record('b1', 's1', 'r1', { a: 5000 });
    first.record('b1', 's1', 'r1', { a: 7000 });
    first.close();

    const second = new CreditScorer(dbPath);
    assert.equal(second.credit('b1', 's1').score, 70);
    second.record('b1', 's1', 'r1', {});
    assert.equal(second.credit('b1', 's1').score, 100);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
