"use strict";

// 随机小规模用例：与指数级暴力 DP 对比。
// 暴力 DP 直接按题面定义求最小成本与字典序最小时间轴，
// 作为求解器的独立参照实现。

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { alignSubtitleTrack, MIN_GAP_MS } = require("../dist/index.js");

const INF = Infinity;

/**
 * 暴力求解：返回 { feasible, cost, timeline }。
 * timeline 为长度 2n 的数组（s1,e1,s2,e2,...）。
 */
function bruteForce(segments, videoDuration) {
  const n = segments.length;
  const varCount = 2 * n;
  const T = videoDuration;
  const a = [];
  const w = [];
  const c = [];
  const lockedVal = [];
  for (let i = 0; i < n; i++) {
    const seg = segments[i];
    a.push(seg.start, seg.end);
    w.push(seg.weight, seg.weight);
    lockedVal.push(seg.locked ? seg.start : null, seg.locked ? seg.end : null);
    if (i < n - 1) c.push(seg.minDuration, MIN_GAP_MS);
    else c.push(seg.minDuration);
  }
  // c[j] 为 x[j+1]-x[j] 下限，j = 0..2n-2
  const gaps = c.slice(0, varCount - 1);

  const costAt = (j, v) => {
    if (lockedVal[j] !== null && lockedVal[j] !== v) return INF;
    return w[j] * Math.abs(v - a[j]);
  };

  // 前向 DP：dp[j][v] = 前 j+1 个变量且 x[j]=v 的最小成本
  const dp = [];
  for (let j = 0; j < varCount; j++) dp.push(new Array(T + 1).fill(INF));
  for (let v = 0; v <= T; v++) dp[0][v] = costAt(0, v);
  for (let j = 1; j < varCount; j++) {
    // 标准前缀最小：dp[j][v] = cost_j(v) + min_{u <= v - gaps[j-1]} dp[j-1][u]
    let run = INF;
    for (let v = 0; v <= T; v++) {
      const limit = v - gaps[j - 1];
      if (limit >= 0 && dp[j - 1][limit] < run) run = dp[j - 1][limit];
      dp[j][v] = run === INF ? INF : run + costAt(j, v);
    }
  }

  let totalMin = INF;
  for (let v = 0; v <= T; v++) {
    if (dp[varCount - 1][v] < totalMin) totalMin = dp[varCount - 1][v];
  }
  if (totalMin === INF) return { feasible: false };

  // 后向 DP：suff[j][v] = 变量 j..2n-1 且 x[j]=v 的最小成本
  const suff = [];
  for (let j = 0; j < varCount; j++) suff.push(new Array(T + 1).fill(INF));
  for (let v = 0; v <= T; v++) suff[varCount - 1][v] = costAt(varCount - 1, v);
  for (let j = varCount - 2; j >= 0; j--) {
    let run = INF;
    for (let v = T; v >= 0; v--) {
      const from = v + gaps[j];
      if (from <= T && suff[j + 1][from] < run) run = suff[j + 1][from];
      suff[j][v] = run === INF ? INF : run + costAt(j, v);
    }
  }

  // 字典序最小：逐变量取能达成总成本的最小 v
  const timeline = new Array(varCount);
  let prev = 0;
  for (let j = 0; j < varCount; j++) {
    const lo = j === 0 ? 0 : prev + gaps[j - 1];
    let chosen = -1;
    for (let v = lo; v <= T; v++) {
      if (dp[j][v] === INF || suff[j][v] === INF) continue;
      if (dp[j][v] + suff[j][v] - costAt(j, v) === totalMin) {
        chosen = v;
        break;
      }
    }
    if (chosen < 0) throw new Error("brute force internal error");
    timeline[j] = chosen;
    prev = chosen;
  }
  return { feasible: true, cost: totalMin, timeline };
}

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomCase(rand) {
  const n = 1 + Math.floor(rand() * 4); // 1..4 段
  const T = 8 + Math.floor(rand() * 33); // 8..40 ms
  const segments = [];
  for (let i = 0; i < n; i++) {
    const start = Math.floor(rand() * (T - 1));
    const end = start + 1 + Math.floor(rand() * (T - start - 1));
    segments.push({
      start,
      end,
      minDuration: Math.floor(rand() * 5), // 0..4，可能制造无解
      weight: 1 + Math.floor(rand() * 9),
      locked: rand() < 0.3,
    });
  }
  return { segments, videoDuration: T };
}

test("随机小规模用例与暴力 DP 对比（成本最优 + 字典序最小）", () => {
  const rand = mulberry32(20261006);
  const caseCount = 3000;
  let infeasibleCount = 0;
  for (let k = 0; k < caseCount; k++) {
    const { segments, videoDuration } = randomCase(rand);
    const expected = bruteForce(segments, videoDuration);
    const actual = alignSubtitleTrack(segments, videoDuration);
    if (!expected.feasible) {
      infeasibleCount++;
      assert.equal(
        actual.ok,
        false,
        `case ${k} 应判无解: ${JSON.stringify(segments)} T=${videoDuration}`
      );
      continue;
    }
    assert.equal(
      actual.ok,
      true,
      `case ${k} 应有解: ${JSON.stringify(segments)} T=${videoDuration}`
    );
    const actualTimeline = [];
    for (const seg of actual.segments) actualTimeline.push(seg.start, seg.end);
    assert.deepEqual(
      actualTimeline,
      expected.timeline,
      `case ${k} 时间轴不一致: ${JSON.stringify(segments)} T=${videoDuration}`
    );
    assert.equal(
      actual.totalCost,
      BigInt(expected.cost),
      `case ${k} 成本不一致: ${JSON.stringify(segments)} T=${videoDuration}`
    );
  }
  assert.ok(infeasibleCount > 0, "随机用例应覆盖无解场景");
});

test("随机用例加强版：更多段、更大下限、更高锁定比例", () => {
  const rand = mulberry32(987654321);
  const caseCount = 2000;
  for (let k = 0; k < caseCount; k++) {
    const n = 1 + Math.floor(rand() * 6); // 1..6 段
    const T = 10 + Math.floor(rand() * 51); // 10..60 ms
    const segments = [];
    for (let i = 0; i < n; i++) {
      const start = Math.floor(rand() * (T - 1));
      const end = start + 1 + Math.floor(rand() * (T - start - 1));
      segments.push({
        start,
        end,
        minDuration: Math.floor(rand() * 9), // 0..8
        weight: 1 + Math.floor(rand() * 9),
        locked: rand() < 0.5,
      });
    }
    const expected = bruteForce(segments, T);
    const actual = alignSubtitleTrack(segments, T);
    if (!expected.feasible) {
      assert.equal(
        actual.ok,
        false,
        `case ${k} 应判无解: ${JSON.stringify(segments)} T=${T}`
      );
      continue;
    }
    assert.equal(
      actual.ok,
      true,
      `case ${k} 应有解: ${JSON.stringify(segments)} T=${T}`
    );
    const actualTimeline = [];
    for (const seg of actual.segments) actualTimeline.push(seg.start, seg.end);
    assert.deepEqual(
      actualTimeline,
      expected.timeline,
      `case ${k} 时间轴不一致: ${JSON.stringify(segments)} T=${T}`
    );
    assert.equal(
      actual.totalCost,
      BigInt(expected.cost),
      `case ${k} 成本不一致: ${JSON.stringify(segments)} T=${T}`
    );
  }
});
