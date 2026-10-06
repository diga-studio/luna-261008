"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { alignSubtitleTrack } = require("../dist/index.js");

test("验收场景：4000ms 两段重叠，权重 1 和 9", () => {
  const result = alignSubtitleTrack(
    [
      { start: 1000, end: 2000, minDuration: 1000, weight: 1, locked: false },
      { start: 1500, end: 2500, minDuration: 1000, weight: 9, locked: false },
    ],
    4000
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.segments, [
    { start: 420, end: 1420 },
    { start: 1500, end: 2500 },
  ]);
  assert.equal(result.totalCost, 1160n);
});

test("验收场景：权重均为 1 时同成本并列，仍选 420-1420 / 1500-2500", () => {
  const result = alignSubtitleTrack(
    [
      { start: 1000, end: 2000, minDuration: 1000, weight: 1, locked: false },
      { start: 1500, end: 2500, minDuration: 1000, weight: 1, locked: false },
    ],
    4000
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.segments, [
    { start: 420, end: 1420 },
    { start: 1500, end: 2500 },
  ]);
  assert.equal(result.totalCost, 1160n);
});

test("锁定段之间空间不足：返回无解", () => {
  // 锁定 1000-2000 与 2500-3500，中间自由段最低 1000ms，
  // 可用区间 [2080, 2420] 仅 340ms，无解
  const result = alignSubtitleTrack(
    [
      { start: 1000, end: 2000, minDuration: 500, weight: 3, locked: true },
      { start: 2100, end: 2400, minDuration: 1000, weight: 5, locked: false },
      { start: 2500, end: 3500, minDuration: 500, weight: 7, locked: true },
    ],
    10000
  );
  assert.deepEqual(result, { ok: false });
});

test("相邻锁定段间隔不足 80ms：返回无解", () => {
  const result = alignSubtitleTrack(
    [
      { start: 1000, end: 2000, minDuration: 500, weight: 3, locked: true },
      { start: 2050, end: 3000, minDuration: 500, weight: 3, locked: true },
    ],
    10000
  );
  assert.deepEqual(result, { ok: false });
});

test("锁定段自身不满足最低展示时长：返回无解", () => {
  const result = alignSubtitleTrack(
    [
      { start: 1000, end: 1500, minDuration: 800, weight: 3, locked: true },
    ],
    10000
  );
  assert.deepEqual(result, { ok: false });
});

test("锁定段空间充足：保留锁定时码，中间段取已知全局最优", () => {
  // 中间段原 1500-2500 与左锁冲突，最优为最早可行位置 2080-3080
  const result = alignSubtitleTrack(
    [
      { start: 1000, end: 2000, minDuration: 500, weight: 3, locked: true },
      { start: 1500, end: 2500, minDuration: 1000, weight: 5, locked: false },
      { start: 5000, end: 6000, minDuration: 500, weight: 7, locked: true },
    ],
    10000
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.segments, [
    { start: 1000, end: 2000 },
    { start: 2080, end: 3080 },
    { start: 5000, end: 6000 },
  ]);
  assert.equal(result.totalCost, 5800n);
});

test("右锚点截断：自由段被右锁定段压到最晚可行位置", () => {
  // 中间段原 4000-5000 与右锁冲突，最优为最晚可行位置 2420-3420
  const result = alignSubtitleTrack(
    [
      { start: 1000, end: 2000, minDuration: 500, weight: 3, locked: true },
      { start: 4000, end: 5000, minDuration: 1000, weight: 5, locked: false },
      { start: 3500, end: 4500, minDuration: 500, weight: 7, locked: true },
    ],
    10000
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.segments, [
    { start: 1000, end: 2000 },
    { start: 2420, end: 3420 },
    { start: 3500, end: 4500 },
  ]);
  assert.equal(result.totalCost, 15800n);
});

test("原时间轴已可行：零成本原样返回", () => {
  const result = alignSubtitleTrack(
    [
      { start: 0, end: 1000, minDuration: 500, weight: 2, locked: false },
      { start: 2000, end: 3000, minDuration: 500, weight: 4, locked: true },
    ],
    10000
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.segments, [
    { start: 0, end: 1000 },
    { start: 2000, end: 3000 },
  ]);
  assert.equal(result.totalCost, 0n);
});

test("空轨道：零成本空结果", () => {
  const result = alignSubtitleTrack([], 10000);
  assert.equal(result.ok, true);
  assert.deepEqual(result.segments, []);
  assert.equal(result.totalCost, 0n);
});
