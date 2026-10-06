import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { PartsInventory } from '../dist/index.js';
import type { GroupSummary } from '../dist/index.js';

/** 可复现的伪随机数生成器（mulberry32）。 */
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

const SKU_COUNT = 500_000;
const BIG_SIZE = 300_000;
const EDGE_TARGET = 1_000_000;
const WAREHOUSE_COUNT = 25;
const SMALL_GROUP_COUNT = 200;
const RELATION_CHANGES = 2_000;
const STOCK_SETS = 20_000;
const QUERIES = 50_000;
const TIME_BUDGET_MS = 30_000;
const MEMORY_BUDGET_BYTES = 768 * 1024 * 1024;

const sku = (i: number): string => `sku-${i}`;
const wh = (i: number): string => `wh-${i}`;

test(
  `负载：${SKU_COUNT} SKU / ${EDGE_TARGET} 引用 / ${WAREHOUSE_COUNT} 仓库，大组 ${BIG_SIZE}`,
  { timeout: 600_000 },
  () => {
    const rng = makeRng(51);
    const inv = new PartsInventory();
    /** 当前全部直接引用（用于最终独立核对），编码为 a * SKU_COUNT + b（a < b）。 */
    const edges = new Set<number>();
    /** 当前每个 SKU 各仓库库存（用于最终独立核对），编码为 skuIdx * 25 + whIdx。 */
    const stockRef = new Map<number, number>();
    const edgeKey = (a: number, b: number): number =>
      a < b ? a * SKU_COUNT + b : b * SKU_COUNT + a;
    const doLink = (a: number, b: number): void => {
      inv.link(sku(a), sku(b));
      if (a !== b) edges.add(edgeKey(a, b));
    };
    const doUnlink = (a: number, b: number): void => {
      inv.unlink(sku(a), sku(b));
      if (a !== b) edges.delete(edgeKey(a, b));
    };
    const doSetStock = (s: number, w: number, qty: number): void => {
      inv.setStock(sku(s), wh(w), qty);
      const key = s * WAREHOUSE_COUNT + w;
      if (qty === 0) stockRef.delete(key);
      else stockRef.set(key, qty);
    };

    // ---------- 初始载入（不计入耗时） ----------
    const loadStart = performance.now();
    // 大组：30 万个 SKU 连成链。
    for (let i = 1; i < BIG_SIZE; i += 1) doLink(i - 1, i);
    // 小组：200 个，规模 1..100 循环，各自成链，与大组无连接。
    const smallGroups: number[][] = [];
    let nextSku = BIG_SIZE;
    for (let g = 0; g < SMALL_GROUP_COUNT; g += 1) {
      const size = (g % 100) + 1;
      const members: number[] = [];
      for (let k = 0; k < size; k += 1) members.push(nextSku++);
      for (let k = 1; k < size; k += 1) doLink(members[k - 1], members[k]);
      smallGroups.push(members);
    }
    // 其余 SKU 保持孤立；用随机边把总引用数补齐到 100 万（两端都在大组内，避免改变拓扑）。
    let edgeCount = edges.size;
    while (edgeCount < EDGE_TARGET) {
      const a = Math.floor(rng() * BIG_SIZE);
      const b = Math.floor(rng() * BIG_SIZE);
      if (a === b) continue;
      const key = edgeKey(a, b);
      if (edges.has(key)) continue;
      inv.link(sku(a), sku(b));
      edges.add(key);
      edgeCount += 1;
    }
    // 初始库存：每 10 个 SKU 在 2 个仓库有货。
    for (let s = 0; s < SKU_COUNT; s += 10) {
      doSetStock(s, s % WAREHOUSE_COUNT, 1 + (s % 500));
      doSetStock(s, (s * 7) % WAREHOUSE_COUNT, 1 + (s % 300));
    }
    const loadMs = performance.now() - loadStart;

    // ---------- 操作计划（不计入耗时） ----------
    // 关系变更：大组与小组反复建立/解除唯一连接，端点顺序随机互换。
    const relationOps: Array<{ kind: 'link' | 'unlink'; a: number; b: number }> = [];
    for (let k = 0; k < RELATION_CHANGES / 2; k += 1) {
      const members = smallGroups[k % SMALL_GROUP_COUNT];
      const smallEnd = members[Math.floor(rng() * members.length)];
      const bigEnd = Math.floor(rng() * BIG_SIZE);
      const swap1 = rng() < 0.5;
      const swap2 = rng() < 0.5;
      relationOps.push({ kind: 'link', a: swap1 ? bigEnd : smallEnd, b: swap1 ? smallEnd : bigEnd });
      relationOps.push({ kind: 'unlink', a: swap2 ? bigEnd : smallEnd, b: swap2 ? smallEnd : bigEnd });
    }
    // 库存设置：大组与小组件成员都涉及，含归零。
    const stockOps: Array<{ s: number; w: number; qty: number }> = [];
    for (let k = 0; k < STOCK_SETS; k += 1) {
      let s: number;
      if (k % 2 === 0) {
        s = Math.floor(rng() * BIG_SIZE);
      } else {
        const members = smallGroups[Math.floor(rng() * SMALL_GROUP_COUNT)];
        s = members[Math.floor(rng() * members.length)];
      }
      stockOps.push({ s, w: Math.floor(rng() * WAREHOUSE_COUNT), qty: rng() < 0.1 ? 0 : Math.floor(rng() * 10_000) });
    }
    // 查询：90% 指向大组。
    const queryOps: number[] = [];
    for (let k = 0; k < QUERIES; k += 1) {
      if (rng() < 0.9) {
        queryOps.push(Math.floor(rng() * BIG_SIZE));
      } else {
        const members = smallGroups[Math.floor(rng() * SMALL_GROUP_COUNT)];
        queryOps.push(members[Math.floor(rng() * members.length)]);
      }
    }

    // ---------- 计时执行 ----------
    let peakRss = process.memoryUsage().rss;
    const sample = (): void => {
      const rss = process.memoryUsage().rss;
      if (rss > peakRss) peakRss = rss;
    };
    const timedStart = performance.now();
    for (const op of relationOps) {
      if (op.kind === 'link') doLink(op.a, op.b);
      else doUnlink(op.a, op.b);
      sample();
    }
    for (const op of stockOps) doSetStock(op.s, op.w, op.qty);
    sample();
    let checksum = 0;
    for (const s of queryOps) {
      const summary = inv.query(sku(s));
      checksum += summary.skuCount;
    }
    const timedMs = performance.now() - timedStart;
    sample();
    assert.ok(checksum > 0, '查询应返回有效汇总');

    console.log(
      `[load] 初始载入 ${loadMs.toFixed(0)}ms（不计入）；` +
        `组件操作 ${timedMs.toFixed(0)}ms（预算 ${TIME_BUDGET_MS}ms）；` +
        `峰值 RSS ${(peakRss / 1024 / 1024).toFixed(0)} MiB（预算 768 MiB）`,
    );
    assert.ok(timedMs <= TIME_BUDGET_MS, `组件操作耗时 ${timedMs.toFixed(0)}ms 超过预算`);
    assert.ok(peakRss <= MEMORY_BUDGET_BYTES, `峰值内存 ${(peakRss / 1024 / 1024).toFixed(0)} MiB 超过预算`);

    // ---------- 独立核对（不计入耗时）：按当前全部关系重新展开并逐 SKU 求和 ----------
    const verifyStart = performance.now();
    const adj: number[][] = Array.from({ length: SKU_COUNT }, () => []);
    for (const key of edges) {
      const a = Math.floor(key / SKU_COUNT);
      const b = key % SKU_COUNT;
      adj[a].push(b);
      adj[b].push(a);
    }
    const compOf = new Int32Array(SKU_COUNT).fill(-1);
    const compSize: number[] = [];
    const compStock: Array<Map<number, number>> = [];
    const queue: number[] = [];
    for (let start = 0; start < SKU_COUNT; start += 1) {
      if (compOf[start] !== -1) continue;
      const compId = compSize.length;
      let size = 0;
      const totals = new Map<number, number>();
      queue.length = 0;
      queue.push(start);
      compOf[start] = compId;
      for (let head = 0; head < queue.length; head += 1) {
        const node = queue[head];
        size += 1;
        for (let w = 0; w < WAREHOUSE_COUNT; w += 1) {
          const qty = stockRef.get(node * WAREHOUSE_COUNT + w);
          if (qty !== undefined) totals.set(w, (totals.get(w) ?? 0) + qty);
        }
        for (const next of adj[node]) {
          if (compOf[next] === -1) {
            compOf[next] = compId;
            queue.push(next);
          }
        }
      }
      compSize.push(size);
      compStock.push(totals);
    }
    // 抽样比对：全部小组成员 + 大组与孤立 SKU 的随机样本。
    const sampleSkus: number[] = [];
    for (const members of smallGroups) sampleSkus.push(...members);
    for (let k = 0; k < 5_000; k += 1) sampleSkus.push(Math.floor(rng() * SKU_COUNT));
    for (const s of sampleSkus) {
      const actual = inv.query(sku(s));
      const compId = compOf[s];
      const expected: GroupSummary = { skuCount: compSize[compId], stock: {} };
      for (const [w, qty] of compStock[compId]) expected.stock[wh(w)] = qty;
      assert.deepEqual(actual, expected, `SKU ${s} 的最终汇总与独立核对不一致`);
    }
    console.log(
      `[load] 独立核对 ${(performance.now() - verifyStart).toFixed(0)}ms（不计入），` +
        `比对 ${sampleSkus.length} 个 SKU，等价组数量 ${compSize.length}`,
    );
  },
);
