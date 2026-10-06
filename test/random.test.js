'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../dist/engine.js');
const {
  DIMENSIONS,
  key,
  makeRng,
  fullCompute,
  randomTemplate,
  collectLeaves,
  approxEqual,
} = require('./helpers.js');

const EVALUATORS = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank'];

function randomScore(rng, leaf) {
  const r = rng();
  // 约 1/6 概率取原始分 0（可能是有效零分），1/6 取下界（归一化后为 0）
  if (r < 1 / 6) return 0;
  if (r < 2 / 6) return leaf.min;
  return leaf.min + rng() * (leaf.max - leaf.min);
}

function checkAll(engine, template, records, recused, leaves, ctx) {
  const ref = fullCompute(template, records, recused);
  const { rootScore } = engine.read();
  assert.ok(
    approxEqual(rootScore, ref.rootScore),
    `${ctx}: rootScore engine=${rootScore} ref=${ref.rootScore}`,
  );
  // 校验全部可能三元组的贡献系数
  let coefSum = 0;
  let coefScoreSum = 0;
  for (const leaf of leaves) {
    for (const dim of DIMENSIONS) {
      for (const ev of EVALUATORS) {
        const got = engine.read({ metricId: leaf.id, dimension: dim, evaluatorId: ev }).coefficient;
        const want = ref.coefficient(leaf.id, dim, ev);
        assert.ok(
          approxEqual(got, want),
          `${ctx}: coef(${leaf.id},${dim},${ev}) engine=${got} ref=${want}`,
        );
        coefSum += got;
        const raw = records.get(key(leaf.id, dim, ev));
        if (raw !== undefined && !recused.has(ev)) {
          const norm = ((raw - leaf.min) / (leaf.max - leaf.min)) * 100;
          coefScoreSum += got * norm;
        }
      }
    }
  }
  if (rootScore !== null) {
    assert.ok(
      approxEqual(coefSum, 1, 1e-9),
      `${ctx}: coefficient sum=${coefSum} expected 1`,
    );
    assert.ok(
      approxEqual(coefScoreSum, rootScore, 1e-9),
      `${ctx}: sum(coef*norm)=${coefScoreSum} root=${rootScore}`,
    );
  } else {
    assert.ok(approxEqual(coefSum, 0), `${ctx}: null root but coef sum=${coefSum}`);
  }
}

test('随机修改 vs 独立全量计算（根分数 + 全部贡献系数 + 系数和）', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const rng = makeRng(seed * 7919);
    const template = randomTemplate(rng);
    const leaves = collectLeaves(template);
    const records = new Map();
    const recused = new Set();

    // 初始评分：随机铺满一部分三元组，含被回避者的评分
    for (const ev of EVALUATORS) {
      if (rng() < 0.25) recused.add(ev);
    }
    const initialRatings = [];
    for (const leaf of leaves) {
      for (const dim of DIMENSIONS) {
        for (const ev of EVALUATORS) {
          if (rng() < 0.4) {
            const s = randomScore(rng, leaf);
            records.set(key(leaf.id, dim, ev), s);
            initialRatings.push({ metricId: leaf.id, dimension: dim, evaluatorId: ev, score: s });
          }
        }
      }
    }

    const engine = createEngine(template, initialRatings, [...recused]);
    checkAll(engine, template, records, recused, leaves, `seed=${seed} init`);

    // 随机修改序列
    for (let step = 0; step < 200; step++) {
      const op = rng();
      if (op < 0.7) {
        // setRating：新增 / 替换 / 撤回
        const leaf = leaves[Math.floor(rng() * leaves.length)];
        const dim = DIMENSIONS[Math.floor(rng() * 3)];
        const ev = EVALUATORS[Math.floor(rng() * EVALUATORS.length)];
        const k = key(leaf.id, dim, ev);
        if (rng() < 0.2) {
          engine.setRating(leaf.id, dim, ev, null);
          records.delete(k);
        } else {
          const s = randomScore(rng, leaf);
          engine.setRating(leaf.id, dim, ev, s);
          records.set(k, s);
        }
      } else {
        // setRecused：含重复设置
        const ev = EVALUATORS[Math.floor(rng() * EVALUATORS.length)];
        const target = rng() < 0.5;
        engine.setRecused(ev, target);
        if (rng() < 0.3) engine.setRecused(ev, target); // 重复设置不得改变结果
        if (target) recused.add(ev);
        else recused.delete(ev);
      }
      checkAll(engine, template, records, recused, leaves, `seed=${seed} step=${step}`);
    }
  }
});

test('有效零分参与聚合且系数非零', () => {
  const template = { id: 'root', children: [{ node: { id: 'm1', min: 0, max: 10 }, weight: 1 }] };
  const engine = createEngine(template, [
    { metricId: 'm1', dimension: 'self', evaluatorId: 'a', score: 0 },
  ], []);
  const { rootScore, coefficient } = engine.read({ metricId: 'm1', dimension: 'self', evaluatorId: 'a' });
  assert.equal(rootScore, 0); // 零分是有效分数，不是缺值
  assert.equal(coefficient, 1);
});
