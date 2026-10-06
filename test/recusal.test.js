'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../dist/engine.js');
const { approxEqual } = require('./helpers.js');

// 树：
//   root
//   ├──(w=1) branchA
//   │         └──(w=1) leafA  (量程 0..10)
//   └──(w=3) branchB
//             ├──(w=1) leafB1 (量程 0..100)
//             └──(w=2) leafB2 (量程 -5..5)
// leafA 只有 self 维度、且唯一评价人 eva —— 回避 eva 后 leafA 缺值，
// branchA 随之缺值，root 只剩 branchB 一支。
const template = {
  id: 'root',
  children: [
    {
      node: {
        id: 'branchA',
        children: [{ node: { id: 'leafA', min: 0, max: 10 }, weight: 1 }],
      },
      weight: 1,
    },
    {
      node: {
        id: 'branchB',
        children: [
          { node: { id: 'leafB1', min: 0, max: 100 }, weight: 1 },
          { node: { id: 'leafB2', min: -5, max: 5 }, weight: 2 },
        ],
      },
      weight: 3,
    },
  ],
};

test('回避使叶子最后维度消失 → 子树缺值；回避期间改分；取消回避用最新分', () => {
  const engine = createEngine(template, [
    // leafA：仅 self / eva
    { metricId: 'leafA', dimension: 'self', evaluatorId: 'eva', score: 8 }, // norm 80
    // leafB1：manager 两人
    { metricId: 'leafB1', dimension: 'manager', evaluatorId: 'max', score: 60 }, // norm 60
    { metricId: 'leafB1', dimension: 'manager', evaluatorId: 'mia', score: 80 }, // norm 80
    // leafB2：peer 一人 + self 一人
    { metricId: 'leafB2', dimension: 'peer', evaluatorId: 'pat', score: 0 }, // norm 50
    { metricId: 'leafB2', dimension: 'self', evaluatorId: 'sam', score: 5 }, // norm 100
  ], []);

  // 初始根分数：
  // leafA = 80
  // leafB1 = 70；leafB2 = (30*50 + 20*100)/50 = 70
  // branchA = 80；branchB = (1*70 + 2*70)/3 = 70
  // root = (1*80 + 3*70)/4 = 72.5
  assert.ok(approxEqual(engine.read().rootScore, 72.5));

  // 回避 eva：leafA 失去最后一个有效维度 → branchA 缺值
  engine.setRecused('eva', true);
  // root = branchB = 70（branchA 缺值，边权重重新归一化后只剩 branchB）
  assert.ok(approxEqual(engine.read().rootScore, 70));
  // 被回避记录的系数为 0
  assert.equal(
    engine.read({ metricId: 'leafA', dimension: 'self', evaluatorId: 'eva' }).coefficient,
    0,
  );

  // 回避期间修改被回避者的评分：仍须保存，但暂不影响结果
  engine.setRating('leafA', 'self', 'eva', 2); // norm 20
  assert.ok(approxEqual(engine.read().rootScore, 70));
  // 回避期间其他修改正常生效
  engine.setRating('leafB1', 'manager', 'max', 100); // leafB1 = (100+80)/2 = 90
  // branchB = (1*90 + 2*70)/3 = 230/3
  assert.ok(approxEqual(engine.read().rootScore, 230 / 3));

  // 取消回避：使用其最新评分（norm 20，而非初始的 80）
  engine.setRecused('eva', false);
  // branchA = 20；root = (1*20 + 3*(230/3))/4 = (20+230)/4 = 62.5
  assert.ok(approxEqual(engine.read().rootScore, 62.5));
  const probe = engine.read({ metricId: 'leafA', dimension: 'self', evaluatorId: 'eva' });
  // 系数 = leafA 内 self 权重 1 × branchA 内 1 × root 处 1/(1+3)
  assert.ok(approxEqual(probe.coefficient, 0.25));

  // 重复设置回避不得改变结果
  engine.setRecused('eva', false);
  assert.ok(approxEqual(engine.read().rootScore, 62.5));
  engine.setRecused('eva', true);
  engine.setRecused('eva', true);
  assert.ok(approxEqual(engine.read().rootScore, 230 / 3));
});

test('全部维度缺失时根为 null，撤回评分可恢复', () => {
  const t = { id: 'r', children: [{ node: { id: 'm', min: 0, max: 4 }, weight: 1 }] };
  const engine = createEngine(t, [
    { metricId: 'm', dimension: 'peer', evaluatorId: 'x', score: 4 },
  ], []);
  assert.ok(approxEqual(engine.read().rootScore, 100));
  engine.setRating('m', 'peer', 'x', null); // 撤回
  assert.equal(engine.read().rootScore, null);
  assert.equal(
    engine.read({ metricId: 'm', dimension: 'peer', evaluatorId: 'x' }).coefficient,
    0,
  );
  engine.setRating('m', 'peer', 'x', 2);
  assert.ok(approxEqual(engine.read().rootScore, 50));
});
