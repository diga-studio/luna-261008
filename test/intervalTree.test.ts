import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IntervalTree } from '../src/intervalTree.js';

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function collect(tree: IntervalTree<string>, s: number, e: number): string[] {
  const out: string[] = [];
  tree.queryOverlaps(s, e, (k) => void out.push(k));
  return out.sort();
}

test('insert and query basic overlaps', () => {
  const t = new IntervalTree<string>(cmp);
  t.insert('a', 0, 10);
  t.insert('b', 5, 15);
  t.insert('c', 20, 30);
  assert.deepEqual(collect(t, 3, 6), ['a', 'b']);
  assert.deepEqual(collect(t, 15, 20), []); // 首尾相接不算重叠
  assert.deepEqual(collect(t, 10, 20), ['b']);
  assert.deepEqual(collect(t, 9, 21), ['a', 'b', 'c']);
});

test('remove deletes only the target interval', () => {
  const t = new IntervalTree<string>(cmp);
  t.insert('a', 0, 10);
  t.insert('b', 0, 10); // 相同区间不同 key
  t.insert('c', 5, 8);
  t.remove('a', 0);
  assert.deepEqual(collect(t, 0, 100), ['b', 'c']);
  assert.equal(t.size, 2);
  assert.throws(() => t.remove('a', 0));
});

test('stress: random inserts/removes match brute force', () => {
  const t = new IntervalTree<string>(cmp);
  const live = new Map<string, [number, number]>();
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 20000; i++) {
    const op = rnd();
    const id = 'k' + Math.floor(rnd() * 500);
    if (op < 0.55 && !live.has(id)) {
      const s = Math.floor(rnd() * 1000);
      const e = s + 1 + Math.floor(rnd() * 100);
      t.insert(id, s, e);
      live.set(id, [s, e]);
    } else if (live.has(id)) {
      t.remove(id, live.get(id)![0]);
      live.delete(id);
    }
    if (i % 50 === 0) {
      const qs = Math.floor(rnd() * 1000);
      const qe = qs + 1 + Math.floor(rnd() * 200);
      const expect = [...live.entries()]
        .filter(([, [s, e]]) => s < qe && e > qs)
        .map(([k]) => k)
        .sort();
      assert.deepEqual(collect(t, qs, qe), expect);
    }
  }
  assert.equal(t.size, live.size);
});
