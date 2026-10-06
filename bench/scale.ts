/**
 * 规模验证：24 个月 × 100 产品 × 2000 合同 × 500000 笔收入，单池最大 100000 笔。
 * 报告：100 次区间查询耗时分布、热点池批量修订 1000 笔耗时、内存峰值，
 * 并校验修订后热点池分摊之和仍等于池金额。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ProfitLedger, type RevenueInput } from "../src/index.js";

const MONTHS = 24;
const PRODUCTS = 100;
const CONTRACTS = 2000;
const TOTAL_REVENUES = 500_000;
const HOT_POOL_REVENUES = 100_000;
const QUERY_COUNT = 100;
const REVISE_COUNT = 1000;
const BATCH = 50_000;

const HOT_PRODUCT = "P001";
const HOT_MONTH = "2024-01";

let seed = 20261006n;
function rand(): bigint {
  seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
  return seed >> 11n;
}
function randInt(n: number): number {
  return Number(rand() % BigInt(n));
}

function monthOf(index: number): string {
  const y = 2024 + Math.floor(index / 12);
  const m = (index % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}
function productOf(index: number): string {
  return `P${String(index + 1).padStart(3, "0")}`;
}

const dir = mkdtempSync(join(tmpdir(), "scale-bench-"));
const dbPath = join(dir, "scale.db");
console.log(`数据库：${dbPath}`);

let peakMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
function samplePeak(): void {
  peakMb = Math.max(peakMb, Math.round(process.memoryUsage().rss / 1024 / 1024));
}

const ledger = new ProfitLedger(dbPath);

// 1) 录入全部成本池（100 产品 × 24 个月）
let hotPoolAmount = 0n;
{
  const t0 = performance.now();
  for (let p = 0; p < PRODUCTS; p++) {
    for (let m = 0; m < MONTHS; m++) {
      const amount = 1_000_000n + BigInt(randInt(900_000_000));
      if (productOf(p) === HOT_PRODUCT && monthOf(m) === HOT_MONTH) hotPoolAmount = amount;
      ledger.recordFixedCost(productOf(p), monthOf(m), amount);
    }
  }
  console.log(`录入 ${PRODUCTS * MONTHS} 个成本池：${(performance.now() - t0).toFixed(0)}ms`);
}
samplePeak();

// 2) 分批插入 500000 笔收入；前 100000 笔进入热点池 (P001, 2024-01)
//    同时保留前 REVISE_COUNT 笔热点池原始记录，供后续修订使用
const reviseOriginals: RevenueInput[] = [];
{
  const t0 = performance.now();
  let nextId = 1;
  for (let start = 0; start < TOTAL_REVENUES; start += BATCH) {
    const items: RevenueInput[] = [];
    for (let i = start; i < start + BATCH; i++) {
      let product: string;
      let monthIdx: number;
      if (i < HOT_POOL_REVENUES) {
        product = HOT_PRODUCT;
        monthIdx = 0;
      } else {
        product = productOf(1 + randInt(PRODUCTS - 1));
        monthIdx = randInt(MONTHS);
      }
      const item: RevenueInput = {
        id: BigInt(nextId++),
        contractId: `C${1 + randInt(CONTRACTS)}`,
        product,
        bizDate: `${monthOf(monthIdx)}-${String(1 + randInt(28)).padStart(2, "0")}`,
        amountCents: 1n + BigInt(randInt(1_000_000_000)),
        directCostCents: BigInt(randInt(500_000_000)),
      };
      if (i < REVISE_COUNT) reviseOriginals.push({ ...item });
      items.push(item);
    }
    ledger.upsertRevenues(items);
    samplePeak();
    {
      const mu = process.memoryUsage();
      console.log(
        `  批次 ${start / BATCH + 1}/${TOTAL_REVENUES / BATCH} rss=${Math.round(mu.rss / 1048576)}MB ` +
          `heapUsed=${Math.round(mu.heapUsed / 1048576)}MB heapTotal=${Math.round(mu.heapTotal / 1048576)}MB ` +
          `external=${Math.round(mu.external / 1048576)}MB arrayBuffers=${Math.round(mu.arrayBuffers / 1048576)}MB`,
      );
    }
  }
  console.log(`插入 ${TOTAL_REVENUES} 笔收入：${(performance.now() - t0).toFixed(0)}ms`);
}
samplePeak();
console.log(`插入后 rss=${Math.round(process.memoryUsage().rss / 1048576)}MB`);

// 3) 100 次覆盖 1 至 24 个月区间的查询
{
  const times: number[] = [];
  let sink = 0n;
  for (let q = 0; q < QUERY_COUNT; q++) {
    const len = 1 + randInt(MONTHS);
    const startIdx = randInt(MONTHS - len + 1);
    const from = `${monthOf(startIdx)}-01`;
    const to = `${monthOf(startIdx + len)}-01`;
    const t0 = performance.now();
    const rows = ledger.queryProfit(from, to);
    times.push(performance.now() - t0);
    for (const r of rows) sink += r.netProfitCents;
    samplePeak();
  }
  times.sort((a, b) => a - b);
  const pct = (p: number) =>
    times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))]!;
  const under300 = times.filter((t) => t < 300).length;
  console.log(
    `查询 ${QUERY_COUNT} 次：min=${times[0]!.toFixed(1)}ms p50=${pct(50).toFixed(1)}ms ` +
      `p95=${pct(95).toFixed(1)}ms max=${times[times.length - 1]!.toFixed(1)}ms ` +
      `<300ms 占比=${under300}/${QUERY_COUNT}（校验和 ${sink}）`,
  );
  console.log(`查询后 rss=${Math.round(process.memoryUsage().rss / 1048576)}MB`);
}

// 4) 热点池（100000 笔）批量修订 1000 笔：只改金额与直接成本
{
  const reviseItems: RevenueInput[] = reviseOriginals.map((orig) => ({
    ...orig,
    amountCents: 1n + BigInt(randInt(1_000_000_000)),
    directCostCents: BigInt(randInt(500_000_000)),
  }));
  const t0 = performance.now();
  ledger.upsertRevenues(reviseItems);
  const elapsed = performance.now() - t0;
  console.log(`热点池批量修订 ${REVISE_COUNT} 笔：${elapsed.toFixed(0)}ms`);
  samplePeak();

  // 修订后热点池分摊之和仍等于池金额（直接按池校验，queryProfit 只按合同分组）
  const check = new DatabaseSync(dbPath);
  const stmt = check.prepare(
    `SELECT SUM(allocated_cents) AS s FROM revenue WHERE product = ? AND month = ?`,
  );
  stmt.setReadBigInts(true);
  const allocated = (stmt.get(HOT_PRODUCT, HOT_MONTH) as unknown as { s: bigint }).s;
  check.close();
  console.log(
    `修订后热点池分摊之和=${allocated}，池金额=${hotPoolAmount}，` +
      `一致=${allocated === hotPoolAmount}`,
  );
}

// 5) 正常关闭重开后结果一致（抽验热点池）
{
  ledger.close();
  const reopened = new ProfitLedger(dbPath);
  const a = reopened.queryProfit("2024-01-01", "2024-02-01");
  const b = reopened.queryProfit("2024-01-01", "2025-12-01");
  console.log(`重开后查询：热点月合同数=${a.length}，全区间合同数=${b.length}`);
  reopened.close();
}

console.log(`内存峰值：${peakMb} MiB`);
rmSync(dir, { recursive: true, force: true });
