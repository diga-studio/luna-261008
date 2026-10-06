import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PartsInventory } from '../dist/index.js';

test('无引用的 SKU 自成一组', () => {
  const inv = new PartsInventory();
  inv.setStock('A', 'w1', 5);
  assert.deepEqual(inv.query('A'), { skuCount: 1, stock: { w1: 5 } });
  // 完全未登记的 SKU 也自成一组、无库存。
  assert.deepEqual(inv.query('ghost'), { skuCount: 1, stock: {} });
});

test('直接引用合并分组并汇总库存', () => {
  const inv = new PartsInventory();
  inv.setStock('A', 'w1', 5);
  inv.setStock('B', 'w1', 3);
  inv.setStock('B', 'w2', 7);
  inv.link('A', 'B');
  const expected = { skuCount: 2, stock: { w1: 8, w2: 7 } };
  assert.deepEqual(inv.query('A'), expected);
  assert.deepEqual(inv.query('B'), expected);
});

test('传递性：A-B、B-C 使三者同组', () => {
  const inv = new PartsInventory();
  inv.link('A', 'B');
  inv.link('B', 'C');
  inv.setStock('C', 'w1', 10);
  assert.deepEqual(inv.query('A'), { skuCount: 3, stock: { w1: 10 } });
});

test('重复建立与撤销不存在的关系均为空操作', () => {
  const inv = new PartsInventory();
  inv.link('A', 'B');
  inv.link('A', 'B');
  inv.link('B', 'A'); // 端点顺序互换也算同一关系
  inv.setStock('A', 'w1', 4);
  assert.deepEqual(inv.query('B'), { skuCount: 2, stock: { w1: 4 } });
  inv.unlink('A', 'C'); // 不存在的关系
  inv.unlink('X', 'Y'); // 未登记的 SKU
  assert.deepEqual(inv.query('B'), { skuCount: 2, stock: { w1: 4 } });
});

test('带环：删除一条边仍连通，汇总不变', () => {
  const inv = new PartsInventory();
  // 环 A-B-C-D-A
  inv.link('A', 'B');
  inv.link('B', 'C');
  inv.link('C', 'D');
  inv.link('D', 'A');
  inv.setStock('A', 'w1', 1);
  inv.setStock('B', 'w1', 2);
  inv.setStock('C', 'w2', 3);
  inv.setStock('D', 'w2', 4);
  const before = inv.query('A');
  assert.deepEqual(before, { skuCount: 4, stock: { w1: 3, w2: 7 } });
  inv.unlink('D', 'A'); // 断开环的一边，仍连通
  for (const sku of ['A', 'B', 'C', 'D']) {
    assert.deepEqual(inv.query(sku), before, `${sku} 的汇总应与删边前一致`);
  }
});

test('多条连通路径：逐条删除直到真正拆组', () => {
  const inv = new PartsInventory();
  // A、B 之间有两条独立路径：A-B 与 A-C-B
  inv.link('A', 'B');
  inv.link('A', 'C');
  inv.link('C', 'B');
  inv.setStock('A', 'w1', 10);
  inv.setStock('B', 'w1', 20);
  inv.setStock('C', 'w1', 30);
  inv.unlink('A', 'B'); // 仍有 A-C-B 路径
  assert.deepEqual(inv.query('A'), { skuCount: 3, stock: { w1: 60 } });
  inv.unlink('C', 'B'); // 真正拆开：{A,C} 与 {B}
  assert.deepEqual(inv.query('A'), { skuCount: 2, stock: { w1: 40 } });
  assert.deepEqual(inv.query('C'), { skuCount: 2, stock: { w1: 40 } });
  assert.deepEqual(inv.query('B'), { skuCount: 1, stock: { w1: 20 } });
});

test('拆组后再次合并不重复累计', () => {
  const inv = new PartsInventory();
  inv.link('A', 'B');
  inv.link('B', 'C');
  inv.setStock('A', 'w1', 1);
  inv.setStock('B', 'w1', 2);
  inv.setStock('C', 'w1', 3);
  inv.unlink('B', 'C'); // 拆成 {A,B} 与 {C}
  assert.deepEqual(inv.query('A'), { skuCount: 2, stock: { w1: 3 } });
  assert.deepEqual(inv.query('C'), { skuCount: 1, stock: { w1: 3 } });
  inv.link('B', 'C'); // 再次合并
  const merged = { skuCount: 3, stock: { w1: 6 } };
  assert.deepEqual(inv.query('A'), merged);
  assert.deepEqual(inv.query('B'), merged);
  assert.deepEqual(inv.query('C'), merged);
});

test('库存设置覆盖旧值，归零后从汇总中移除', () => {
  const inv = new PartsInventory();
  inv.link('A', 'B');
  inv.setStock('A', 'w1', 5);
  inv.setStock('A', 'w1', 8); // 覆盖
  assert.deepEqual(inv.query('B'), { skuCount: 2, stock: { w1: 8 } });
  inv.setStock('A', 'w1', 0); // 归零
  assert.deepEqual(inv.query('A'), { skuCount: 2, stock: {} });
});

test('拆组后库存变动只影响所在组', () => {
  const inv = new PartsInventory();
  inv.link('A', 'B');
  inv.setStock('A', 'w1', 5);
  inv.unlink('A', 'B');
  inv.setStock('A', 'w1', 9);
  assert.deepEqual(inv.query('A'), { skuCount: 1, stock: { w1: 9 } });
  assert.deepEqual(inv.query('B'), { skuCount: 1, stock: {} });
});

test('非法库存数量被拒绝', () => {
  const inv = new PartsInventory();
  assert.throws(() => inv.setStock('A', 'w1', -1), RangeError);
  assert.throws(() => inv.setStock('A', 'w1', 1.5), RangeError);
  assert.throws(() => inv.setStock('A', 'w1', NaN), RangeError);
});

test('较大环与桥：拆桥后两侧各自成组', () => {
  const inv = new PartsInventory();
  // 两个环用一座桥连接：环1 A-B-C-A，环2 D-E-F-D，桥 C-D
  const ring1 = ['A', 'B', 'C'];
  const ring2 = ['D', 'E', 'F'];
  inv.link('A', 'B'); inv.link('B', 'C'); inv.link('C', 'A');
  inv.link('D', 'E'); inv.link('E', 'F'); inv.link('F', 'D');
  inv.link('C', 'D');
  ring1.forEach((s, i) => inv.setStock(s, 'w1', i + 1)); // 1+2+3=6
  ring2.forEach((s, i) => inv.setStock(s, 'w2', (i + 1) * 10)); // 10+20+30=60
  assert.deepEqual(inv.query('A'), { skuCount: 6, stock: { w1: 6, w2: 60 } });
  inv.unlink('C', 'D');
  assert.deepEqual(inv.query('B'), { skuCount: 3, stock: { w1: 6 } });
  assert.deepEqual(inv.query('E'), { skuCount: 3, stock: { w2: 60 } });
});

test('回归：拆桥时两侧都可能成为被切分的一侧（端点顺序不影响结果）', () => {
  // 链 y-x-z 与链 w-v，桥 x-w。两种端点顺序撤销，结果必须一致。
  for (const [first, second] of [['x', 'w'], ['w', 'x']] as const) {
    const inv = new PartsInventory();
    inv.link('y', 'x'); inv.link('x', 'z');
    inv.link('w', 'v');
    inv.link('x', 'w');
    inv.setStock('x', 'w1', 1);
    inv.setStock('y', 'w1', 2);
    inv.setStock('z', 'w1', 4);
    inv.setStock('w', 'w1', 8);
    inv.setStock('v', 'w1', 16);
    inv.unlink(first, second);
    assert.deepEqual(inv.query('x'), { skuCount: 3, stock: { w1: 7 } }, `unlink(${first},${second}) 后 x 侧`);
    assert.deepEqual(inv.query('z'), { skuCount: 3, stock: { w1: 7 } }, `unlink(${first},${second}) 后 z 侧`);
    assert.deepEqual(inv.query('w'), { skuCount: 2, stock: { w1: 24 } }, `unlink(${first},${second}) 后 w 侧`);
    assert.deepEqual(inv.query('v'), { skuCount: 2, stock: { w1: 24 } }, `unlink(${first},${second}) 后 v 侧`);
    // 再次合并后无重复累计
    inv.link(first, second);
    assert.deepEqual(inv.query('x'), { skuCount: 5, stock: { w1: 31 } });
    assert.deepEqual(inv.query('v'), { skuCount: 5, stock: { w1: 31 } });
  }
});
