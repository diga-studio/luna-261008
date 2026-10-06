import test from "node:test";
import assert from "node:assert/strict";
import { InventoryAggregator } from "../src/index";

function totalsOf(agg: InventoryAggregator, sku: string): Record<string, number> {
  return Object.fromEntries(agg.query(sku).totals);
}

test("无引用的 SKU 自身就是独立等价组", () => {
  const agg = new InventoryAggregator();
  agg.setStock("a", "w1", 5);
  const summary = agg.query("a");
  assert.equal(summary.skuCount, 1);
  assert.deepEqual(Object.fromEntries(summary.totals), { w1: 5 });
  // 从未出现过的 SKU 也是独立组，库存为零
  const empty = agg.query("ghost");
  assert.equal(empty.skuCount, 1);
  assert.equal(empty.totals.size, 0);
});

test("等价关系可传递，任一成员查询结果相同", () => {
  const agg = new InventoryAggregator();
  agg.link("a", "b");
  agg.link("b", "c");
  agg.setStock("a", "w1", 1);
  agg.setStock("b", "w2", 2);
  agg.setStock("c", "w1", 3);
  for (const sku of ["a", "b", "c"]) {
    const summary = agg.query(sku);
    assert.equal(summary.skuCount, 3);
    assert.deepEqual(Object.fromEntries(summary.totals), { w1: 4, w2: 2 });
  }
});

test("重复建立已有引用、撤销不存在的引用不改变状态", () => {
  const agg = new InventoryAggregator();
  agg.link("a", "b");
  agg.link("a", "b");
  agg.link("b", "a");
  agg.setStock("a", "w1", 7);
  agg.unlink("a", "c");
  agg.unlink("c", "d");
  agg.unlink("a", "a");
  const summary = agg.query("b");
  assert.equal(summary.skuCount, 2);
  assert.deepEqual(Object.fromEntries(summary.totals), { w1: 7 });
});

test("带环引用：删除一条边仍连通，汇总不变", () => {
  const agg = new InventoryAggregator();
  // 环 a-b-c-d-a，外加 e 挂在 d 上
  agg.link("a", "b");
  agg.link("b", "c");
  agg.link("c", "d");
  agg.link("d", "a");
  agg.link("d", "e");
  agg.setStock("a", "w1", 10);
  agg.setStock("c", "w2", 20);
  agg.setStock("e", "w1", 5);
  const before = agg.query("a");
  assert.equal(before.skuCount, 5);

  agg.unlink("d", "a"); // 断开环的一边，a-b-c-d-e 仍全部连通
  for (const sku of ["a", "b", "c", "d", "e"]) {
    const summary = agg.query(sku);
    assert.equal(summary.skuCount, 5);
    assert.deepEqual(Object.fromEntries(summary.totals), { w1: 15, w2: 20 });
  }
});

test("多条连通路径：逐条删除后真正拆组，各组数量与库存正确", () => {
  const agg = new InventoryAggregator();
  // 两个三角 {a,b,c} 与 {d,e,f}，中间两条桥 b-d、c-e
  for (const [x, y] of [
    ["a", "b"], ["b", "c"], ["a", "c"],
    ["d", "e"], ["e", "f"], ["d", "f"],
    ["b", "d"], ["c", "e"],
  ] as Array<[string, string]>) {
    agg.link(x, y);
  }
  agg.setStock("a", "w1", 1);
  agg.setStock("b", "w1", 2);
  agg.setStock("c", "w2", 4);
  agg.setStock("d", "w1", 8);
  agg.setStock("e", "w2", 16);
  agg.setStock("f", "w3", 32);
  assert.equal(agg.query("a").skuCount, 6);

  agg.unlink("b", "d"); // 还有 c-e 桥，不拆组
  assert.equal(agg.query("a").skuCount, 6);
  assert.deepEqual(totalsOf(agg, "f"), { w1: 11, w2: 20, w3: 32 });

  agg.unlink("c", "e"); // 真正拆成两个三角
  assert.equal(agg.query("a").skuCount, 3);
  assert.deepEqual(totalsOf(agg, "a"), { w1: 3, w2: 4 });
  assert.deepEqual(totalsOf(agg, "b"), { w1: 3, w2: 4 });
  assert.deepEqual(totalsOf(agg, "c"), { w1: 3, w2: 4 });
  assert.equal(agg.query("d").skuCount, 3);
  assert.deepEqual(totalsOf(agg, "d"), { w1: 8, w2: 16, w3: 32 });
  assert.deepEqual(totalsOf(agg, "f"), { w1: 8, w2: 16, w3: 32 });
});

test("拆组后再次合并不重复累计", () => {
  const agg = new InventoryAggregator();
  agg.link("a", "b");
  agg.link("c", "d");
  agg.link("b", "c");
  agg.setStock("a", "w1", 100);
  agg.setStock("d", "w1", 200);
  agg.unlink("b", "c");
  assert.deepEqual(totalsOf(agg, "a"), { w1: 100 });
  assert.deepEqual(totalsOf(agg, "d"), { w1: 200 });
  agg.link("b", "c");
  assert.equal(agg.query("a").skuCount, 4);
  assert.deepEqual(totalsOf(agg, "a"), { w1: 300 });
  assert.deepEqual(totalsOf(agg, "d"), { w1: 300 });
  // 再拆一次，数值仍应一致
  agg.unlink("c", "b");
  assert.deepEqual(totalsOf(agg, "b"), { w1: 100 });
  assert.deepEqual(totalsOf(agg, "c"), { w1: 200 });
});

test("库存覆盖旧值，可设为零，各 SKU 独立记账", () => {
  const agg = new InventoryAggregator();
  agg.link("a", "b");
  agg.setStock("a", "w1", 10);
  agg.setStock("a", "w1", 4); // 覆盖
  agg.setStock("b", "w1", 1);
  assert.deepEqual(totalsOf(agg, "a"), { w1: 5 });
  agg.setStock("a", "w1", 0); // 归零
  assert.deepEqual(totalsOf(agg, "a"), { w1: 1 });
  agg.setStock("b", "w1", 0);
  assert.equal(agg.query("a").totals.size, 0);
});

test("库存设置发生在拆组之后仍归属正确的组", () => {
  const agg = new InventoryAggregator();
  agg.link("a", "b");
  agg.setStock("a", "w1", 10);
  agg.unlink("a", "b");
  agg.setStock("b", "w1", 5);
  assert.deepEqual(totalsOf(agg, "a"), { w1: 10 });
  assert.deepEqual(totalsOf(agg, "b"), { w1: 5 });
});

test("非法可用量被拒绝", () => {
  const agg = new InventoryAggregator();
  assert.throws(() => agg.setStock("a", "w1", -1));
  assert.throws(() => agg.setStock("a", "w1", 1.5));
  assert.throws(() => agg.setStock("a", "w1", Number.NaN));
});
