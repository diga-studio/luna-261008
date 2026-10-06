import test from "node:test";
import assert from "node:assert/strict";
import { InventoryAggregator } from "../src/index";

/**
 * 负载测试：500,000 SKU、约 1,000,000 条直接引用、25 个仓库，
 * 其中一个等价组 300,000 SKU。计时阶段完成 2,000 次关系变更、
 * 20,000 次库存设置、50,000 次汇总查询（≥90% 指向大组）。
 * 初始载入与结果核对不计入组件操作耗时。
 */

const BIG_SIZE = 300_000;
const BACKGROUND_SIZE = 175_000;
const RESERVED_GROUP_COUNT = 500;
const BIG_RANDOM_EDGES = 400_001; // 连同链式边，大组约 70 万条
const BACKGROUND_EDGES = 300_000;
const WAREHOUSE_COUNT = 25;
const REL_OPS = 2_000;
const STOCK_OPS = 20_000;
const QUERY_OPS = 50_000;
const TIME_BUDGET_MS = 30_000;
const MEMORY_BUDGET_BYTES = 768 * 1024 * 1024;

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

const bigSku = (i: number): string => `b${i}`;
const bgSku = (i: number): string => `g${i}`;
const resSku = (g: number, i: number): string => `r${g}x${i}`;
const warehouse = (i: number): string => `w${i}`;

test("负载：50 万 SKU / 100 万引用 / 大组反复拆合", () => {
  const rng = makeRng(987654321);
  const agg = new InventoryAggregator();

  // 参考库存（测试侧独立记账，用于最终核对；不计入组件耗时）
  const refStock = new Map<string, Map<string, number>>();
  const refSetStock = (sku: string, wh: string, qty: number): void => {
    let entry = refStock.get(sku);
    if (entry === undefined) {
      entry = new Map();
      refStock.set(sku, entry);
    }
    if (qty === 0) {
      entry.delete(wh);
    } else {
      entry.set(wh, qty);
    }
  };

  // ---- 初始载入（不计时）----
  // 预留小组：1 至 100 个 SKU，链式连接，初始与大组断开
  const reservedSizes: number[] = [];
  let reservedSkuTotal = 0;
  for (let g = 0; g < RESERVED_GROUP_COUNT; g++) {
    const size = 1 + Math.floor(rng() * 100);
    reservedSizes.push(size);
    reservedSkuTotal += size;
  }
  assert.ok(
    BIG_SIZE + BACKGROUND_SIZE + reservedSkuTotal <= 500_000,
    "SKU 总量应在 50 万以内",
  );

  for (let i = 0; i + 1 < BIG_SIZE; i++) {
    agg.link(bigSku(i), bigSku(i + 1));
  }
  for (let e = 0; e < BIG_RANDOM_EDGES; e++) {
    const a = Math.floor(rng() * BIG_SIZE);
    const b = Math.floor(rng() * BIG_SIZE);
    if (a !== b) agg.link(bigSku(a), bigSku(b));
  }
  for (let e = 0; e < BACKGROUND_EDGES; e++) {
    const a = Math.floor(rng() * BACKGROUND_SIZE);
    const b = Math.floor(rng() * BACKGROUND_SIZE);
    if (a !== b) agg.link(bgSku(a), bgSku(b));
  }
  for (let g = 0; g < RESERVED_GROUP_COUNT; g++) {
    for (let i = 0; i + 1 < reservedSizes[g]; i++) {
      agg.link(resSku(g, i), resSku(g, i + 1));
    }
  }
  // 初始库存：大组每 3 个 SKU 一份，背景每 7 个一份
  for (let i = 0; i < BIG_SIZE; i += 3) {
    const qty = (i * 7) % 500;
    const wh = warehouse(i % WAREHOUSE_COUNT);
    agg.setStock(bigSku(i), wh, qty);
    refSetStock(bigSku(i), wh, qty);
  }
  for (let i = 0; i < BACKGROUND_SIZE; i += 7) {
    const qty = (i * 13) % 300;
    const wh = warehouse((i * 3) % WAREHOUSE_COUNT);
    agg.setStock(bgSku(i), wh, qty);
    refSetStock(bgSku(i), wh, qty);
  }

  // ---- 生成计时阶段操作序列 ----
  // 关系变更：大组与预留小组反复建立/解除唯一连接。
  // 每个小组使用两轮；第二轮中每 3 个小组有 1 个保持连接到最后。
  type RelOp = { kind: "link" | "unlink"; a: string; b: string };
  const relOps: RelOp[] = [];
  const attachedAtEnd = new Set<number>();
  const pendingEdges: Array<[string, string, number]> = [];
  for (let k = 0; k < REL_OPS / 2; k++) {
    const g = k % RESERVED_GROUP_COUNT;
    const round = Math.floor(k / RESERVED_GROUP_COUNT);
    const bigEndpoint = bigSku(Math.floor(rng() * BIG_SIZE));
    const smallEndpoint = resSku(g, Math.floor(rng() * reservedSizes[g]));
    const swap = rng() < 0.5;
    const a = swap ? smallEndpoint : bigEndpoint;
    const b = swap ? bigEndpoint : smallEndpoint;
    relOps.push({ kind: "link", a, b });
    if (round === 1 && g % 3 === 0) {
      attachedAtEnd.add(g); // 这条连接保留到最后
    } else {
      pendingEdges.push([a, b, g]);
    }
  }
  // 解除其余连接（端点顺序随机互换），不足 2000 次用无害的
  // “撤销不存在的关系”补齐——按规则这不改变状态。
  for (const [a, b] of pendingEdges) {
    relOps.push(rng() < 0.5 ? { kind: "unlink", a, b } : { kind: "unlink", a: b, b: a });
  }
  while (relOps.length < REL_OPS) {
    relOps.push({
      kind: "unlink",
      a: bigSku(Math.floor(rng() * BIG_SIZE)),
      b: resSku(Math.floor(rng() * RESERVED_GROUP_COUNT), 0),
    });
  }
  assert.equal(relOps.length, REL_OPS);

  // 库存设置：大组与小组（预留/背景）成员都涉及
  const stockOps: Array<[string, string, number]> = [];
  for (let i = 0; i < STOCK_OPS; i++) {
    const roll = rng();
    let sku: string;
    if (roll < 0.7) {
      sku = bigSku(Math.floor(rng() * BIG_SIZE));
    } else if (roll < 0.85) {
      const g = Math.floor(rng() * RESERVED_GROUP_COUNT);
      sku = resSku(g, Math.floor(rng() * reservedSizes[g]));
    } else {
      sku = bgSku(Math.floor(rng() * BACKGROUND_SIZE));
    }
    const wh = warehouse(Math.floor(rng() * WAREHOUSE_COUNT));
    const qty = rng() < 0.2 ? 0 : Math.floor(rng() * 10_000);
    stockOps.push([sku, wh, qty]);
  }

  // 查询：至少 90% 指向大组
  const queryOps: string[] = [];
  for (let i = 0; i < QUERY_OPS; i++) {
    if (rng() < 0.92) {
      queryOps.push(bigSku(Math.floor(rng() * BIG_SIZE)));
    } else if (rng() < 0.5) {
      const g = Math.floor(rng() * RESERVED_GROUP_COUNT);
      queryOps.push(resSku(g, Math.floor(rng() * reservedSizes[g])));
    } else {
      queryOps.push(bgSku(Math.floor(rng() * BACKGROUND_SIZE)));
    }
  }

  // 交错三类操作（关系变更保持既定先后顺序）
  const opKinds: number[] = [];
  for (let i = 0; i < REL_OPS; i++) opKinds.push(0);
  for (let i = 0; i < STOCK_OPS; i++) opKinds.push(1);
  for (let i = 0; i < QUERY_OPS; i++) opKinds.push(2);
  for (let i = opKinds.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = opKinds[i];
    opKinds[i] = opKinds[j];
    opKinds[j] = tmp;
  }

  // ---- 计时阶段：只累计组件操作耗时 ----
  let componentNs = 0n;
  let peakRss = 0;
  let peakHeap = 0;
  const sampleMemory = (): void => {
    const mem = process.memoryUsage();
    if (mem.rss > peakRss) peakRss = mem.rss;
    if (mem.heapUsed > peakHeap) peakHeap = mem.heapUsed;
  };
  sampleMemory();

  let relIdx = 0;
  let stockIdx = 0;
  let queryIdx = 0;
  let queryChecksum = 0;
  for (let op = 0; op < opKinds.length; op++) {
    const kind = opKinds[op];
    const start = process.hrtime.bigint();
    if (kind === 0) {
      const rel = relOps[relIdx++];
      if (rel.kind === "link") {
        agg.link(rel.a, rel.b);
      } else {
        agg.unlink(rel.a, rel.b);
      }
    } else if (kind === 1) {
      const [sku, wh, qty] = stockOps[stockIdx++];
      agg.setStock(sku, wh, qty);
      const end = process.hrtime.bigint();
      componentNs += end - start;
      refSetStock(sku, wh, qty); // 参考记账不计时
      if (op % 4096 === 0) sampleMemory();
      continue;
    } else {
      const summary = agg.query(queryOps[queryIdx++]);
      queryChecksum += summary.skuCount + summary.totals.size;
    }
    const end = process.hrtime.bigint();
    componentNs += end - start;
    if (op % 4096 === 0) sampleMemory();
  }
  sampleMemory();
  const componentMs = Number(componentNs) / 1e6;

  // ---- 结果核对（不计时）：按当前全部关系独立展开并逐 SKU 求和 ----
  const bigMembers = new Set<string>();
  for (let i = 0; i < BIG_SIZE; i++) bigMembers.add(bigSku(i));
  for (const g of attachedAtEnd) {
    for (let i = 0; i < reservedSizes[g]; i++) bigMembers.add(resSku(g, i));
  }
  const sumOver = (members: Set<string>): Map<string, number> => {
    const totals = new Map<string, number>();
    for (const sku of members) {
      const entry = refStock.get(sku);
      if (entry === undefined) continue;
      for (const [wh, qty] of entry) {
        totals.set(wh, (totals.get(wh) ?? 0) + qty);
      }
    }
    return totals;
  };
  const expectedBigTotals = sumOver(bigMembers);
  const actualBig = agg.query(bigSku(0));
  assert.equal(actualBig.skuCount, bigMembers.size, "大组 SKU 数量");
  assert.deepEqual(
    Object.fromEntries(actualBig.totals),
    Object.fromEntries(expectedBigTotals),
    "大组各仓库总量",
  );
  // 大组任一成员查询结果相同
  const probe = agg.query(bigSku(BIG_SIZE - 1));
  assert.equal(probe.skuCount, bigMembers.size);
  assert.deepEqual(Object.fromEntries(probe.totals), Object.fromEntries(expectedBigTotals));

  // 每个预留小组：仍连着大组的应得到大组汇总，已断开的只含自身
  for (let g = 0; g < RESERVED_GROUP_COUNT; g++) {
    const actual = agg.query(resSku(g, 0));
    if (attachedAtEnd.has(g)) {
      assert.equal(actual.skuCount, bigMembers.size, `小组 ${g} 应并入大组`);
      assert.deepEqual(
        Object.fromEntries(actual.totals),
        Object.fromEntries(expectedBigTotals),
        `小组 ${g} 的汇总应与大组一致`,
      );
    } else {
      const own = new Set<string>();
      for (let i = 0; i < reservedSizes[g]; i++) own.add(resSku(g, i));
      assert.equal(actual.skuCount, reservedSizes[g], `小组 ${g} 应独立成组`);
      assert.deepEqual(
        Object.fromEntries(actual.totals),
        Object.fromEntries(sumOver(own)),
        `小组 ${g} 的汇总`,
      );
    }
  }

  const toMiB = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);
  console.log(
    `[load] 组件操作耗时 ${componentMs.toFixed(0)} ms / 预算 ${TIME_BUDGET_MS} ms；` +
      `峰值 RSS ${toMiB(peakRss)} MiB、峰值堆 ${toMiB(peakHeap)} MiB / 预算 768.0 MiB；` +
      `查询校验和 ${queryChecksum}`,
  );
  assert.ok(componentMs <= TIME_BUDGET_MS, `组件操作耗时 ${componentMs}ms 超出预算`);
  assert.ok(peakRss <= MEMORY_BUDGET_BYTES, `峰值 RSS ${peakRss} 超出预算`);
});
