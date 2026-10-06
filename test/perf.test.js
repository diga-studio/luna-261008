"use strict";

// 10 万段长轨道性能与已知结果测试。
//
// 场景设计（结果可手工推导）：
// - 每段最低展示时长 1000ms，段间间隔 80ms，故段 i 的最早可行位置为
//   [i*1080, i*1080+1000]。
// - 所有未锁定段的原始时码都是 0..1ms，即它们都想尽量靠前，
//   而成本随位置单调递增，因此全局最优 = 逐分量最小可行点 = 最早可行位置。
// - 每第 1000 段锁定，且其原始时码就取最早可行位置（与链一致，成本为 0）。
// - 视频总长取到刚好容纳全轨，测试右边界。
// 已知结果：段 i 的时间轴必为 [i*1080, i*1080+1000]，
// 总成本 = sum_i w_i * (|i*1080 - 0| + |i*1080+1000 - 1|)（锁定段为 0）。

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { alignSubtitleTrack, MIN_GAP_MS } = require("../dist/index.js");

const N = 100000;
const DURATION = 1000;
const STRIDE = DURATION + MIN_GAP_MS; // 1080
const LOCK_EVERY = 1000;

function buildTrack() {
  const segments = [];
  for (let i = 0; i < N; i++) {
    const locked = i % LOCK_EVERY === LOCK_EVERY - 1;
    if (locked) {
      segments.push({
        start: i * STRIDE,
        end: i * STRIDE + DURATION,
        minDuration: DURATION,
        weight: 9,
        locked: true,
      });
    } else {
      segments.push({
        start: 0,
        end: 1,
        minDuration: DURATION,
        weight: (i % 9) + 1,
        locked: false,
      });
    }
  }
  const videoDuration = (N - 1) * STRIDE + DURATION;
  return { segments, videoDuration };
}

function expectedTimeline() {
  const out = [];
  for (let i = 0; i < N; i++) {
    out.push({ start: i * STRIDE, end: i * STRIDE + DURATION });
  }
  return out;
}

function expectedCost(segments) {
  let total = 0n;
  for (let i = 0; i < N; i++) {
    const seg = segments[i];
    const start = i * STRIDE;
    const end = i * STRIDE + DURATION;
    total +=
      BigInt(seg.weight) *
      BigInt(Math.abs(start - seg.start) + Math.abs(end - seg.end));
  }
  return total;
}

test("100000 段长轨道：5 秒 / 256MiB 内完成且结果与已知最优一致", () => {
  if (typeof global.gc === "function") global.gc();
  const memBefore = process.memoryUsage().heapUsed;

  const { segments, videoDuration } = buildTrack();
  const startedAt = process.hrtime.bigint();
  const result = alignSubtitleTrack(segments, videoDuration);
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  if (typeof global.gc === "function") global.gc();
  const memAfter = process.memoryUsage().heapUsed;
  const memDeltaMiB = (memAfter - memBefore) / (1024 * 1024);

  assert.equal(result.ok, true);
  assert.equal(result.segments.length, N);

  // 与已知最优时间轴逐段一致（同时覆盖等成本选择规则）
  const expected = expectedTimeline();
  assert.deepEqual(result.segments, expected);

  // 总成本与已知最优成本一致
  assert.equal(result.totalCost, expectedCost(segments));

  // 约束逐一验证：范围、最低展示时长、顺序与间隔、锁定保持
  for (let i = 0; i < N; i++) {
    const seg = result.segments[i];
    assert.ok(seg.start >= 0, `段 ${i} 开始早于 0`);
    assert.ok(seg.end <= videoDuration, `段 ${i} 结束超出视频时长`);
    assert.ok(seg.end - seg.start >= DURATION, `段 ${i} 展示时长不足`);
    assert.ok(Number.isInteger(seg.start) && Number.isInteger(seg.end));
    if (i > 0) {
      assert.ok(
        seg.start - result.segments[i - 1].end >= MIN_GAP_MS,
        `段 ${i} 与前一段间隔不足`
      );
    }
    if (segments[i].locked) {
      assert.equal(seg.start, segments[i].start, `锁定段 ${i} 开始被移动`);
      assert.equal(seg.end, segments[i].end, `锁定段 ${i} 结束被移动`);
    }
  }

  assert.ok(elapsedMs < 5000, `耗时 ${elapsedMs.toFixed(1)}ms 超过 5s`);
  assert.ok(memDeltaMiB < 256, `内存增量 ${memDeltaMiB.toFixed(1)}MiB 超过 256MiB`);
});
