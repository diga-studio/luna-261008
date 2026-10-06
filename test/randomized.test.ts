import test from "node:test";
import assert from "node:assert/strict";
import { InventoryAggregator } from "../src/index";

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

interface RefState {
  edges: Map<string, Set<string>>;
  stock: Map<string, Map<string, number>>;
  skus: Set<string>;
}

/** 朴素参考实现：每次查询都按当前全部关系重新展开并逐 SKU 求和。 */
function referenceQuery(
  state: RefState,
  sku: string,
): { skuCount: number; totals: Map<string, number> } {
  if (!state.skus.has(sku)) {
    return { skuCount: 1, totals: new Map() };
  }
  const visited = new Set<string>([sku]);
  const stack = [sku];
  while (stack.length > 0) {
    const node = stack.pop() as string;
    for (const next of state.edges.get(node) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        stack.push(next);
      }
    }
  }
  const totals = new Map<string, number>();
  for (const member of visited) {
    for (const [wh, qty] of state.stock.get(member) ?? []) {
      totals.set(wh, (totals.get(wh) ?? 0) + qty);
    }
  }
  for (const [wh, qty] of totals) {
    if (qty === 0) totals.delete(wh);
  }
  return { skuCount: visited.size, totals };
}

test("随机增删引用与库存后，汇总与独立重新计算一致", () => {
  const rng = makeRng(20261006);
  const skuCount = 60;
  const warehouses = ["w1", "w2", "w3", "w4"];
  const skus = Array.from({ length: skuCount }, (_, i) => `sku-${i}`);
  const agg = new InventoryAggregator();
  const state: RefState = {
    edges: new Map(),
    stock: new Map(),
    skus: new Set(),
  };
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];
  const refAddEdge = (a: string, b: string) => {
    if (!state.edges.has(a)) state.edges.set(a, new Set());
    if (!state.edges.has(b)) state.edges.set(b, new Set());
    state.edges.get(a)?.add(b);
    state.edges.get(b)?.add(a);
  };
  const refRemoveEdge = (a: string, b: string) => {
    state.edges.get(a)?.delete(b);
    state.edges.get(b)?.delete(a);
  };
  const liveEdges: Array<[string, string]> = [];
  for (let step = 0; step < 4000; step++) {
    const roll = rng();
    if (roll < 0.35) {
      // 建立引用（含重复建立、端点顺序互换）
      const a = pick(skus);
      const b = pick(skus);
      state.skus.add(a);
      state.skus.add(b);
      const existed = state.edges.get(a)?.has(b) ?? false;
      agg.link(a, b);
      if (!existed && a !== b) {
        refAddEdge(a, b);
        liveEdges.push([a, b]);
      }
    } else if (roll < 0.6) {
      // 撤销引用（多数从现存边里挑，偶尔撤销不存在的边）
      if (liveEdges.length > 0 && rng() < 0.9) {
        const idx = Math.floor(rng() * liveEdges.length);
        const pair = liveEdges[idx];
        liveEdges.splice(idx, 1);
        agg.unlink(pair[0], pair[1]);
        refRemoveEdge(pair[0], pair[1]);
      } else {
        const a = pick(skus);
        const b = pick(skus);
        agg.unlink(a, b);
        refRemoveEdge(a, b);
      }
    } else {
      // 设置库存，覆盖非负整数全区间，含从非零变为零
      const sku = pick(skus);
      const wh = pick(warehouses);
      const qty = rng() < 0.25 ? 0 : Math.floor(rng() * 1000);
      state.skus.add(sku);
      agg.setStock(sku, wh, qty);
      if (!state.stock.has(sku)) state.stock.set(sku, new Map());
      const entry = state.stock.get(sku) as Map<string, number>;
      if (qty === 0) {
        entry.delete(wh);
      } else {
        entry.set(wh, qty);
      }
    }
    // 周期性全量比对所有 SKU 的汇总
    if (step % 50 === 49) {
      for (const sku of skus) {
        const expected = referenceQuery(state, sku);
        const actual = agg.query(sku);
        assert.equal(
          actual.skuCount,
          expected.skuCount,
          `step ${step} sku ${sku} skuCount`,
        );
        assert.deepEqual(
          Object.fromEntries(actual.totals),
          Object.fromEntries(expected.totals),
          `step ${step} sku ${sku} totals`,
        );
      }
    }
  }
});
