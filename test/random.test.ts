import { test } from 'node:test';
import assert from 'node:assert/strict';
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

/** 独立参照实现：每次查询都按当前全部关系重新展开并逐 SKU 求和。 */
class ReferenceInventory {
  private readonly edges = new Map<string, Set<string>>();
  private readonly stock = new Map<string, Map<string, number>>();

  private ensure(sku: string): void {
    if (!this.edges.has(sku)) this.edges.set(sku, new Set());
  }

  link(a: string, b: string): void {
    this.ensure(a);
    this.ensure(b);
    this.edges.get(a)!.add(b);
    this.edges.get(b)!.add(a);
  }

  unlink(a: string, b: string): void {
    this.edges.get(a)?.delete(b);
    this.edges.get(b)?.delete(a);
  }

  setStock(sku: string, warehouse: string, qty: number): void {
    this.ensure(sku);
    let s = this.stock.get(sku);
    if (!s) {
      s = new Map();
      this.stock.set(sku, s);
    }
    if (qty === 0) s.delete(warehouse);
    else s.set(warehouse, qty);
  }

  query(sku: string): GroupSummary {
    const visited = new Set<string>([sku]);
    const queue = [sku];
    const stock: Record<string, number> = {};
    for (let head = 0; head < queue.length; head += 1) {
      const node = queue[head];
      for (const [wh, qty] of this.stock.get(node) ?? []) {
        stock[wh] = (stock[wh] ?? 0) + qty;
      }
      for (const next of this.edges.get(node) ?? []) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    return { skuCount: visited.size, stock };
  }
}

function normalize(summary: GroupSummary): GroupSummary {
  const stock: Record<string, number> = {};
  for (const key of Object.keys(summary.stock).sort()) {
    stock[key] = summary.stock[key];
  }
  return { skuCount: summary.skuCount, stock };
}

test('随机增删引用与库存，结果与独立重算一致', () => {
  const rng = makeRng(20261008);
  const skuCount = 60;
  const warehouses = ['w1', 'w2', 'w3', 'w4'];
  const skus = Array.from({ length: skuCount }, (_, i) => `sku-${i}`);
  const inv = new PartsInventory();
  const ref = new ReferenceInventory();
  const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];

  const rounds = 4000;
  for (let i = 0; i < rounds; i += 1) {
    const roll = rng();
    if (roll < 0.3) {
      // 建立引用（含自引用与重复建立）
      const a = pick(skus);
      const b = pick(skus);
      inv.link(a, b);
      ref.link(a, b);
    } else if (roll < 0.5) {
      // 撤销引用（含不存在的关系）
      const a = pick(skus);
      const b = pick(skus);
      inv.unlink(a, b);
      ref.unlink(a, b);
    } else if (roll < 0.8) {
      // 设置库存，约 1/4 概率设为零（覆盖非零 -> 零）
      const sku = pick(skus);
      const wh = pick(warehouses);
      const qty = rng() < 0.25 ? 0 : Math.floor(rng() * 1000);
      inv.setStock(sku, wh, qty);
      ref.setStock(sku, wh, qty);
    } else {
      // 查询并比对
      const sku = pick(skus);
      assert.deepEqual(
        normalize(inv.query(sku)),
        normalize(ref.query(sku)),
        `第 ${i} 步后 ${sku} 的汇总不一致`,
      );
    }
  }
  // 收尾：对所有 SKU 做一次全量比对。
  for (const sku of skus) {
    assert.deepEqual(normalize(inv.query(sku)), normalize(ref.query(sku)), `收尾时 ${sku} 不一致`);
  }
});

test('随机稠密图：带大量环的增删后仍一致', () => {
  const rng = makeRng(42);
  const skus = Array.from({ length: 25 }, (_, i) => `n-${i}`);
  const warehouses = ['a', 'b'];
  const inv = new PartsInventory();
  const ref = new ReferenceInventory();
  const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];

  // 先建一个接近完全图的稠密关系网。
  for (const a of skus) {
    for (const b of skus) {
      if (a < b && rng() < 0.5) {
        inv.link(a, b);
        ref.link(a, b);
      }
    }
  }
  for (const sku of skus) {
    for (const wh of warehouses) {
      const qty = Math.floor(rng() * 100);
      inv.setStock(sku, wh, qty);
      ref.setStock(sku, wh, qty);
    }
  }
  // 随机删边，每步后抽查。
  for (let i = 0; i < 1500; i += 1) {
    const a = pick(skus);
    const b = pick(skus);
    if (rng() < 0.6) {
      inv.unlink(a, b);
      ref.unlink(a, b);
    } else {
      inv.link(a, b);
      ref.link(a, b);
    }
    if (i % 10 === 0) {
      const sku = pick(skus);
      assert.deepEqual(
        normalize(inv.query(sku)),
        normalize(ref.query(sku)),
        `第 ${i} 步后 ${sku} 不一致`,
      );
    }
  }
});
