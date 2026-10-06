import test from 'node:test';
import assert from 'node:assert/strict';
import { ShelfSync } from '../src/index.js';

// 规模：10 个分馆、10 万册、2 万条未完成预约；100 笔并发办理 p95 < 200ms。
test('性能：10 馆 / 10 万册 / 2 万未完成预约下 100 笔办理 p95 < 200ms', { timeout: 120000 }, () => {
  const lib = new ShelfSync(':memory:');
  try {
    const branches = Array.from({ length: 10 }, (_, i) => `BR-${i}`);
    const titleCount = 2000;
    const copiesPerTitle = 50; // 共 100,000 册
    const seed: Array<{ title: string; barcode: string; branch: string }> = [];
    for (let t = 0; t < titleCount; t++) {
      for (let c = 0; c < copiesPerTitle; c++) {
        seed.push({
          title: `TITLE-${t}`,
          barcode: `BC-${t}-${c}`,
          branch: branches[(t + c) % branches.length]!,
        });
      }
    }
    lib.addCopies(seed); // 首次建立馆藏时间不计入指标

    // 建立 20,000 条未完成预约（每个题名 10 条，部分已绑定/在途）。
    const pendingIds: number[] = [];
    for (let t = 0; t < titleCount; t++) {
      for (let r = 0; r < 10; r++) {
        pendingIds.push(lib.reserve(`TITLE-${t}`, `reader-${t}-${r}`, branches[(t + r) % 10]!));
      }
    }

    // 100 笔混合办理：预约、撤销、领取、入馆。
    const durations: number[] = [];
    const loans: string[] = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      const title = `TITLE-${(i * 37) % titleCount}`;
      if (i % 4 === 0) {
        lib.reserve(title, `perf-new-${i}`, branches[i % 10]!);
      } else if (i % 4 === 1) {
        const rid = pendingIds[(i * 13) % pendingIds.length]!;
        try {
          lib.cancel(rid);
        } catch {
          /* 已完成则忽略 */
        }
      } else if (i % 4 === 2) {
        const rid = pendingIds[(i * 7) % pendingIds.length]!;
        const res = lib.getReservation(rid);
        if (res && res.status === 'ready') {
          try {
            loans.push(lib.checkout(rid, res.reader, res.pickupBranch));
          } catch {
            /* 竞争失败 */
          }
        }
      } else {
        const loan = loans.pop();
        if (loan) lib.checkin(loan, branches[i % 10]!);
        else lib.reserve(title, `perf-extra-${i}`, branches[(i + 1) % 10]!);
      }
      durations.push(performance.now() - start);
    }

    durations.sort((a, b) => a - b);
    const p95 = durations[Math.floor(durations.length * 0.95) - 1]!;
    console.log(`p95=${p95.toFixed(2)}ms max=${durations[durations.length - 1]!.toFixed(2)}ms`);
    assert.ok(p95 < 200, `p95 ${p95}ms exceeds 200ms`);
  } finally {
    lib.close();
  }
});
