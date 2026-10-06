import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { ProfitLedger } from "../src/index.js";
import type { RevenueInput } from "../src/index.js";

// 规模：24 个月 x 100 产品 x 2000 合同 x 500000 笔收入，最大池 100000 笔。
const MONTHS = 24;
const PRODUCTS = 100;
const CONTRACTS = 2000;
const POOL_A_REVENUES = 100_000;
const OTHER_REVENUES = 400_000;
const QUERY_COUNT = 100;
const REVISE_COUNT = 1000;

function monthOf(index: number): string {
  const year = 2026 + Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

function firstDayOf(monthIndex: number): string {
  return `${monthOf(monthIndex)}-01`;
}

// 确定性伪随机数（mulberry32），保证规模验证可复现。
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mib(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

test("规模验证：500000 笔收入下的查询、批量修订与内存", { timeout: 600_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-scale-"));
  let peakRss = process.memoryUsage().rss;
  const sampleRss = () => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  };
  try {
    const rng = makeRng(20261008);
    const ledger = new ProfitLedger(join(dir, "scale.db"));

    // 1. 先录入全部 2400 个成本池的固定成本（此时无收入，不触发分摊）。
    const poolFixedCost = new Map<string, bigint>();
    for (let product = 1; product <= PRODUCTS; product++) {
      for (let m = 0; m < MONTHS; m++) {
        const cost = BigInt(1_000_000 + Math.floor(rng() * 1_000_000_000));
        poolFixedCost.set(`${product}|${monthOf(m)}`, cost);
        ledger.setPoolFixedCost(product, monthOf(m), cost);
      }
    }

    // 2. 池 A：产品 1 的 2026-01，100000 笔，一次批量写入（只触发一次整池重分摊）。
    //    原始金额留在紧凑的类型化数组里，供后续修订校验使用。
    const amountOf = (i: number): bigint =>
      i % 97 === 0
        ? BigInt(1_000_000_000_000) // 穿插上限大额
        : BigInt(1 + Math.floor(rng() * 1_000_000_000));

    const poolAAmounts = new BigInt64Array(POOL_A_REVENUES);
    let expectedJanRevenue = 0n;
    const tLoad = performance.now();
    {
      const poolA: RevenueInput[] = new Array<RevenueInput>(POOL_A_REVENUES);
      for (let i = 0; i < POOL_A_REVENUES; i++) {
        const amount = amountOf(i);
        poolAAmounts[i] = amount;
        expectedJanRevenue += amount;
        poolA[i] = {
          id: BigInt(i + 1),
          contractId: 1 + (i % CONTRACTS),
          productId: 1,
          bizDate: `2026-01-${String(1 + (i % 28)).padStart(2, "0")}`,
          amount,
          directCost: BigInt(Math.floor(rng() * 1_000_000)),
        };
      }
      ledger.upsertRevenues(poolA);
    }

    // 3. 其余 400000 笔按池生成并立即写入，不在内存中累积。
    //    产品 2..100 x 24 个月 = 2376 个池，每池 168 或 169 笔。
    const otherPools = (PRODUCTS - 1) * MONTHS;
    const baseSize = Math.floor(OTHER_REVENUES / otherPools);
    const largerPools = OTHER_REVENUES % otherPools;
    let nextId = POOL_A_REVENUES + 1;
    let globalIndex = POOL_A_REVENUES;
    let poolIndex = 0;
    for (let product = 2; product <= PRODUCTS; product++) {
      for (let m = 0; m < MONTHS; m++) {
        const size = baseSize + (poolIndex < largerPools ? 1 : 0);
        poolIndex++;
        const month = monthOf(m);
        const batch: RevenueInput[] = new Array<RevenueInput>(size);
        for (let k = 0; k < size; k++) {
          const amount = amountOf(globalIndex);
          if (m === 0) {
            expectedJanRevenue += amount;
          }
          batch[k] = {
            id: BigInt(nextId++),
            contractId: 1 + (globalIndex % CONTRACTS),
            productId: product,
            bizDate: `${month}-${String(1 + (globalIndex % 28)).padStart(2, "0")}`,
            amount,
            directCost: BigInt(Math.floor(rng() * 1_000_000)),
          };
          globalIndex++;
        }
        ledger.upsertRevenues(batch);
      }
    }
    const loadMs = performance.now() - tLoad;
    sampleRss();

    // 加载后校验：全区间分摊总额 = 有收入的池的固定成本之和。
    // 有收入的池 = 池 A + 全部 2376 个其他池（每池至少 168 笔）。
    let expectedAllocated = poolFixedCost.get("1|2026-01")!;
    let expectedJanAllocated = poolFixedCost.get("1|2026-01")!;
    for (let product = 2; product <= PRODUCTS; product++) {
      for (let m = 0; m < MONTHS; m++) {
        const cost = poolFixedCost.get(`${product}|${monthOf(m)}`)!;
        expectedAllocated += cost;
        if (m === 0) {
          expectedJanAllocated += cost;
        }
      }
    }
    const all = ledger.queryProfits({ from: firstDayOf(0), to: firstDayOf(MONTHS) });
    assert.equal(all.length, CONTRACTS);
    assert.equal(
      all.reduce((acc, r) => acc + r.allocatedFixedCost, 0n),
      expectedAllocated,
    );

    // 4. 连续 100 次覆盖 1..24 个月区间的查询，统计耗时。
    const queryMs: number[] = [];
    let under300 = 0;
    for (let q = 0; q < QUERY_COUNT; q++) {
      const startMonth = Math.floor(rng() * MONTHS);
      const span = 1 + Math.floor(rng() * (MONTHS - startMonth));
      const from = firstDayOf(startMonth);
      const to = firstDayOf(Math.min(startMonth + span, MONTHS));
      const t0 = performance.now();
      const rows = ledger.queryProfits({ from, to });
      const elapsed = performance.now() - t0;
      queryMs.push(elapsed);
      if (elapsed < 300) under300++;
      assert.ok(rows.length > 0, "query should return contracts");
      sampleRss();
    }
    const sorted = [...queryMs].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
    const p100 = sorted[sorted.length - 1]!;

    // 5. 对 100000 笔收入的池 A 批量修订 1000 笔，计时并校验后续查询反映完整结果。
    const reviseBatch: RevenueInput[] = [];
    const picked = new Set<number>();
    while (picked.size < REVISE_COUNT) {
      picked.add(Math.floor(rng() * POOL_A_REVENUES));
    }
    for (const index of picked) {
      const newAmount = BigInt(1 + Math.floor(rng() * 1_000_000_000));
      expectedJanRevenue += newAmount - poolAAmounts[index]!;
      reviseBatch.push({
        id: BigInt(index + 1),
        contractId: 1 + (index % CONTRACTS),
        productId: 1,
        bizDate: `2026-01-${String(1 + (index % 28)).padStart(2, "0")}`,
        amount: newAmount,
        directCost: BigInt(Math.floor(rng() * 1_000_000)),
      });
    }
    const tRevise = performance.now();
    ledger.upsertRevenues(reviseBatch);
    const reviseMs = performance.now() - tRevise;
    sampleRss();

    // 修订后：1 月各池分摊总额仍等于各池固定成本之和，收入总额反映整批修订。
    const jan = ledger.queryProfits({ from: "2026-01-01", to: "2026-02-01" });
    assert.equal(
      jan.reduce((acc, r) => acc + r.allocatedFixedCost, 0n),
      expectedJanAllocated,
    );
    assert.equal(
      jan.reduce((acc, r) => acc + r.revenue, 0n),
      expectedJanRevenue,
    );
    // 全区间分摊总额不变（其他池未受影响）。
    const allAfter = ledger.queryProfits({ from: firstDayOf(0), to: firstDayOf(MONTHS) });
    assert.equal(
      allAfter.reduce((acc, r) => acc + r.allocatedFixedCost, 0n),
      expectedAllocated,
    );

    // 6. 关闭重开，结果一致。
    ledger.close();
    sampleRss();
    const reopened = new ProfitLedger(join(dir, "scale.db"));
    const janAfter = reopened.queryProfits({ from: "2026-01-01", to: "2026-02-01" });
    assert.deepEqual(janAfter, jan);
    reopened.close();

    // 7. 报告与断言。
    console.log("==== 规模验证报告 ====");
    console.log(`收入加载（500000 笔）: ${loadMs.toFixed(0)} ms`);
    console.log(`查询 ${QUERY_COUNT} 次: p95=${p95.toFixed(1)} ms, p100=${p100.toFixed(1)} ms, <300ms 占比=${under300}/${QUERY_COUNT}`);
    console.log(`批量修订 ${REVISE_COUNT} 笔（100000 笔池）: ${reviseMs.toFixed(0)} ms`);
    console.log(`进程驻留内存峰值: ${mib(peakRss)} MiB`);

    assert.ok(under300 >= 95, `only ${under300}/100 queries under 300ms`);
    assert.ok(reviseMs < 3000, `batch revise took ${reviseMs.toFixed(0)}ms`);
    assert.ok(peakRss < 256 * 1024 * 1024, `peak RSS ${mib(peakRss)} MiB exceeds 256 MiB`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
