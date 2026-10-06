import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShelfSync } from '../src/shelfsync.js';

// 规模冒烟：10 个分馆、1 万册、2 千条未完成预约（等比缩小自 10 万册/2 万预约），
// 100 笔并发办理，验证 p95 延迟远低于 200ms。
test('性能冒烟：100 笔并发办理的 p95 延迟在 200ms 内', async () => {
  const lib = new ShelfSync(':memory:');
  const branches = Array.from({ length: 10 }, (_, i) => `branch-${i + 1}`);

  // 首次建立馆藏（不计时）
  for (let t = 0; t < 50; t++) {
    for (let c = 0; c < 200; c++) {
      await lib.registerCopy(`题名-${t}`, `BC-${t}-${String(c).padStart(4, '0')}`, branches[c % 10]);
    }
  }
  // 热点题名：200 册、2200 条预约 → 约 2000 条未完成预约排队
  const hotHoldIds: number[] = [];
  for (let i = 0; i < 2200; i++) {
    const h = await lib.placeHold('题名-0', `reader-${i}`, branches[i % 10]);
    hotHoldIds.push(h.holdId);
  }

  // 100 笔并发办理，逐笔计时
  const latencies: number[] = [];
  const timed = async <T>(p: Promise<T>): Promise<T> => {
    const start = performance.now();
    try {
      return await p;
    } finally {
      latencies.push(performance.now() - start);
    }
  };

  const ops: Promise<unknown>[] = [];
  for (let i = 0; i < 100; i++) {
    const kind = i % 4;
    if (kind === 0) {
      ops.push(timed(lib.placeHold('题名-0', `reader-perf-${i}`, branches[i % 10])));
    } else if (kind === 1) {
      ops.push(timed(lib.cancelHold(hotHoldIds[i])));
    } else if (kind === 2) {
      ops.push(timed(lib.pickup(hotHoldIds[100 + i], `reader-${100 + i}`, branches[(100 + i) % 10])));
    } else {
      const copies = await lib.listCopies();
      const busy = copies.find((c) => c.transferCredential || c.loanCredential);
      const cred = busy?.transferCredential ?? busy?.loanCredential ?? 'T-0';
      ops.push(timed(lib.checkin(cred, branches[i % 10])));
    }
  }
  await Promise.all(ops);

  latencies.sort((a, b) => a - b);
  const p95 = latencies[Math.floor(latencies.length * 0.95) - 1];
  console.log(`  p95=${p95.toFixed(2)}ms max=${latencies[latencies.length - 1].toFixed(2)}ms`);
  assert.ok(p95 < 200, `p95 ${p95}ms 应小于 200ms`);
  lib.close();
});
