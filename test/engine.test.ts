import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/engine.js';
import { DIMENSION_WEIGHTS } from '../src/types.js';
import type { Dimension, Rating, TemplateNode } from '../src/types.js';
import { leavesOf, makeCtx, oracleCoefficient, oracleRoot } from './oracle.js';
import type { Ctx } from './oracle.js';

const DIMENSIONS: readonly Dimension[] = ['manager', 'peer', 'self'];
const TOL = 1e-9;

function approxEqual(actual: number | null, expected: number | null, what: string): void {
  if (actual === null || expected === null) {
    assert.strictEqual(actual, expected, `${what}: nullness mismatch`);
    return;
  }
  const scale = Math.max(1, Math.abs(expected));
  assert.ok(
    Math.abs(actual - expected) <= TOL * scale,
    `${what}: actual=${actual} expected=${expected}`,
  );
}

/** 确定性伪随机数 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 混合量程、不同深度的小树 */
function sampleTemplate(): TemplateNode {
  return {
    kind: 'internal',
    id: 'root',
    children: [
      {
        weight: 2,
        node: {
          kind: 'internal',
          id: 'quality',
          children: [
            { weight: 1, node: { kind: 'leaf', id: 'code', min: 0, max: 5 } },
            { weight: 3, node: { kind: 'leaf', id: 'design', min: 0, max: 10 } },
          ],
        },
      },
      {
        weight: 1,
        node: {
          kind: 'internal',
          id: 'delivery',
          children: [
            {
              weight: 1,
              node: {
                kind: 'internal',
                id: 'speed',
                children: [
                  { weight: 4, node: { kind: 'leaf', id: 'velocity', min: -50, max: 50 } },
                  { weight: 1, node: { kind: 'leaf', id: 'oncall', min: 0, max: 1 } },
                ],
              },
            },
            { weight: 2, node: { kind: 'leaf', id: 'docs', min: 10, max: 110 } },
          ],
        },
      },
      { weight: 5, node: { kind: 'leaf', id: 'impact', min: 0, max: 100 } },
    ],
  };
}

interface Shadow {
  ratings: Map<string, number>; // metric|dim|eval -> score
  recused: Set<string>;
}

function shadowCtx(shadow: Shadow): Ctx {
  const list: Rating[] = [];
  for (const [k, score] of shadow.ratings) {
    const [metricId, dimension, evaluatorId] = k.split('|') as [string, Dimension, string];
    list.push({ metricId, dimension, evaluatorId, score });
  }
  return makeCtx(list, [...shadow.recused]);
}

const keyOf = (m: string, d: string, e: string): string => `${m}|${d}|${e}`;

/** 全量核对：根分数 + 所有候选三元组系数 + 系数和 + 系数加权还原根分 */
function fullCheck(
  engine: ReturnType<typeof createEngine>,
  template: TemplateNode,
  shadow: Shadow,
  evaluators: string[],
  label: string,
): void {
  const ctx = shadowCtx(shadow);
  const expectedRoot = oracleRoot(template, ctx);
  approxEqual(engine.read().root, expectedRoot, `${label} root`);

  const leaves = leavesOf(template);
  const candidates: { metricId: string; dimension: Dimension; evaluatorId: string }[] = [];
  for (const leaf of leaves) {
    for (const dim of DIMENSIONS) {
      for (const ev of [...evaluators, 'ghost']) {
        candidates.push({ metricId: leaf.id, dimension: dim, evaluatorId: ev });
      }
    }
  }
  candidates.push({ metricId: 'nope', dimension: 'manager', evaluatorId: evaluators[0] ?? 'x' });

  let coefSum = 0;
  let reconstruct = 0;
  for (const probe of candidates) {
    const expected = oracleCoefficient(template, ctx, probe);
    const got = engine.read(probe);
    approxEqual(got.root, expectedRoot, `${label} root(via probe)`);
    approxEqual(
      got.coefficient ?? null,
      expected,
      `${label} coef ${probe.metricId}/${probe.dimension}/${probe.evaluatorId}`,
    );
    coefSum += got.coefficient ?? 0;
    const raw = shadow.ratings.get(keyOf(probe.metricId, probe.dimension, probe.evaluatorId));
    if (raw !== undefined && !shadow.recused.has(probe.evaluatorId)) {
      const leaf = leaves.find((l) => l.id === probe.metricId);
      assert.ok(leaf !== undefined);
      const norm = ((raw - leaf.min) / (leaf.max - leaf.min)) * 100;
      reconstruct += (got.coefficient ?? 0) * norm;
    }
  }
  if (expectedRoot === null) {
    approxEqual(coefSum, 0, `${label} coef sum (empty)`);
  } else {
    approxEqual(coefSum, 1, `${label} coef sum`);
    approxEqual(reconstruct, expectedRoot, `${label} coef*score reconstructs root`);
  }
}

test('随机修改与独立全量计算核对（混合量程/不同深度/部分维度缺值/含有效零分）', () => {
  const template = sampleTemplate();
  const evaluators = ['alice', 'bob', 'carol', 'dave', 'erin'];
  const leaves = leavesOf(template);
  const rand = mulberry32(20261006);
  const pick = <T>(arr: readonly T[]): T => {
    const item = arr[Math.floor(rand() * arr.length)];
    assert.ok(item !== undefined);
    return item;
  };

  const shadow: Shadow = { ratings: new Map(), recused: new Set() };
  const engine = createEngine(template, [], []);

  // 初始载入一批评分（含边界值与原始 0 分）
  const seedRatings: Rating[] = [
    { metricId: 'code', dimension: 'manager', evaluatorId: 'alice', score: 0 }, // 归一化 0，有效
    { metricId: 'code', dimension: 'peer', evaluatorId: 'bob', score: 5 },
    { metricId: 'impact', dimension: 'self', evaluatorId: 'carol', score: 0 },
    { metricId: 'velocity', dimension: 'manager', evaluatorId: 'dave', score: -50 }, // 归一化 0
    { metricId: 'docs', dimension: 'peer', evaluatorId: 'erin', score: 60 },
  ];
  for (const r of seedRatings) {
    engine.setRating(r.metricId, r.dimension, r.evaluatorId, r.score);
    shadow.ratings.set(keyOf(r.metricId, r.dimension, r.evaluatorId), r.score);
  }
  fullCheck(engine, template, shadow, evaluators, 'seed');

  for (let step = 0; step < 400; step++) {
    const op = rand();
    const leaf = pick(leaves);
    const dim = pick(DIMENSIONS);
    const ev = pick(evaluators);
    if (op < 0.55) {
      // 新增/替换评分：偶尔取边界或 0，保证出现有效零分
      const r = rand();
      let score: number;
      if (r < 0.15) score = leaf.min;
      else if (r < 0.25) score = leaf.max;
      else if (r < 0.35) score = 0;
      else score = leaf.min + rand() * (leaf.max - leaf.min);
      engine.setRating(leaf.id, dim, ev, score);
      shadow.ratings.set(keyOf(leaf.id, dim, ev), score);
    } else if (op < 0.75) {
      // 撤回评分（可能不存在）
      engine.setRating(leaf.id, dim, ev, null);
      shadow.ratings.delete(keyOf(leaf.id, dim, ev));
    } else {
      // 切换回避
      const flag = rand() < 0.5;
      engine.setRecused(ev, flag);
      if (flag) shadow.recused.add(ev);
      else shadow.recused.delete(ev);
    }
    fullCheck(engine, template, shadow, evaluators, `step${step}`);
  }
});

test('回避使叶子最后维度消失导致子树缺值；回避期间改分；取消回避用最新分', () => {
  const template: TemplateNode = {
    kind: 'internal',
    id: 'root',
    children: [
      {
        weight: 3,
        node: {
          kind: 'internal',
          id: 'branch',
          children: [{ weight: 1, node: { kind: 'leaf', id: 'solo', min: 0, max: 10 } }],
        },
      },
      { weight: 1, node: { kind: 'leaf', id: 'other', min: 0, max: 100 } },
    ],
  };
  const engine = createEngine(
    template,
    [
      { metricId: 'solo', dimension: 'self', evaluatorId: 'alice', score: 4 },
      { metricId: 'other', dimension: 'manager', evaluatorId: 'bob', score: 80 },
    ],
    [],
  );
  const shadow: Shadow = {
    ratings: new Map([
      [keyOf('solo', 'self', 'alice'), 4],
      [keyOf('other', 'manager', 'bob'), 80],
    ]),
    recused: new Set(),
  };
  const evaluators = ['alice', 'bob'];
  fullCheck(engine, template, shadow, evaluators, 'initial');

  // 回避 alice：solo 唯一有效维度消失 -> branch 整支缺值，根只剩 other
  engine.setRecused('alice', true);
  shadow.recused.add('alice');
  fullCheck(engine, template, shadow, evaluators, 'recused');
  // 回避期间 alice 的系数必须为 0
  assert.strictEqual(
    engine.read({ metricId: 'solo', dimension: 'self', evaluatorId: 'alice' }).coefficient,
    0,
  );

  // 重复设置回避不得改变结果
  engine.setRecused('alice', true);
  fullCheck(engine, template, shadow, evaluators, 'recused-twice');

  // 回避期间修改 alice 的评分：须保存但不生效
  engine.setRating('solo', 'self', 'alice', 9);
  shadow.ratings.set(keyOf('solo', 'self', 'alice'), 9);
  fullCheck(engine, template, shadow, evaluators, 'recused-update');
  assert.strictEqual(
    engine.read({ metricId: 'solo', dimension: 'self', evaluatorId: 'alice' }).coefficient,
    0,
  );

  // 回避期间撤回再重评
  engine.setRating('solo', 'self', 'alice', null);
  shadow.ratings.delete(keyOf('solo', 'self', 'alice'));
  fullCheck(engine, template, shadow, evaluators, 'recused-withdraw');
  engine.setRating('solo', 'self', 'alice', 7);
  shadow.ratings.set(keyOf('solo', 'self', 'alice'), 7);
  fullCheck(engine, template, shadow, evaluators, 'recused-re-rate');

  // 取消回避：使用最新评分 7
  engine.setRecused('alice', false);
  shadow.recused.delete('alice');
  fullCheck(engine, template, shadow, evaluators, 'unrecused');
  const probe = engine.read({ metricId: 'solo', dimension: 'self', evaluatorId: 'alice' });
  assert.ok((probe.coefficient ?? 0) > 0);
  // solo 归一化 70，other 归一化 80；根 = (3*70 + 1*80)/4 = 72.5
  approxEqual(probe.root, 72.5, 'unrecused root value');

  // 回避全部评价人 -> 整树缺值
  engine.setRecused('alice', true);
  engine.setRecused('bob', true);
  shadow.recused.add('alice');
  shadow.recused.add('bob');
  fullCheck(engine, template, shadow, evaluators, 'all-recused');
  assert.strictEqual(engine.read().root, null);
});

test('createEngine 初始参数与 setRating 等价；重复 setRecused 幂等', () => {
  const template = sampleTemplate();
  const ratings: Rating[] = [
    { metricId: 'code', dimension: 'manager', evaluatorId: 'alice', score: 3 },
    { metricId: 'code', dimension: 'peer', evaluatorId: 'bob', score: 4 },
    { metricId: 'impact', dimension: 'self', evaluatorId: 'carol', score: 50 },
  ];
  const a = createEngine(template, ratings, ['bob']);
  const b = createEngine(template, [], []);
  for (const r of ratings) b.setRating(r.metricId, r.dimension, r.evaluatorId, r.score);
  b.setRecused('bob', true);
  b.setRecused('bob', true);
  const leaves = leavesOf(template);
  for (const leaf of leaves) {
    for (const dim of DIMENSIONS) {
      for (const ev of ['alice', 'bob', 'carol']) {
        const probe = { metricId: leaf.id, dimension: dim, evaluatorId: ev };
        assert.strictEqual(a.read(probe).coefficient, b.read(probe).coefficient);
      }
    }
  }
  assert.strictEqual(a.read().root, b.read().root);
});

test('维度权重常量符合题意', () => {
  assert.deepStrictEqual({ ...DIMENSION_WEIGHTS }, { manager: 50, peer: 30, self: 20 });
});
