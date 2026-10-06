import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FenceStore } from '../src/index.js';
import type { CircleFence, Fence, PolygonFence } from '../src/index.js';

const circleA: CircleFence = {
  kind: 'circle',
  id: 'a',
  center: { lat: 31.2, lng: 121.5 },
  radiusMeters: 1000,
};
const circleB: CircleFence = {
  kind: 'circle',
  id: 'b',
  center: { lat: 31.2005, lng: 121.5005 },
  radiusMeters: 2000,
};
const polyC: PolygonFence = {
  kind: 'polygon',
  id: 'c',
  vertices: [
    { lat: 31.19, lng: 121.49 },
    { lat: 31.19, lng: 121.51 },
    { lat: 31.21, lng: 121.51 },
    { lat: 31.21, lng: 121.49 },
  ],
};

test('整体装载后查询，重叠围栏全部返回且无重复', () => {
  const store = new FenceStore();
  store.loadAll([circleA, circleB, polyC]);
  assert.equal(store.size, 3);
  const hits = store.query({ lat: 31.2, lng: 121.5 });
  assert.deepEqual([...hits].sort(), ['a', 'b', 'c']);
  assert.equal(new Set(hits).size, hits.length);
  // 未命中处返回空。
  assert.deepEqual(store.query({ lat: 40, lng: 116 }), []);
});

test('装载时标识重复则拒绝', () => {
  const store = new FenceStore();
  assert.throws(() => store.loadAll([circleA, { ...circleB, id: 'a' }]), /重复/);
});

test('替换可以改变形状和位置，旧位置不再命中', () => {
  const store = new FenceStore();
  store.loadAll([circleA]);
  const oldSpot = { lat: 31.2, lng: 121.5 };
  assert.deepEqual(store.query(oldSpot), ['a']);

  // 同标识替换为多边形，搬到经线另一侧。
  const moved: PolygonFence = {
    kind: 'polygon',
    id: 'a',
    vertices: [
      { lat: 0, lng: -179.9 },
      { lat: 0, lng: -179.8 },
      { lat: 0.01, lng: -179.8 },
      { lat: 0.01, lng: -179.9 },
    ],
  };
  store.replace(moved);
  assert.equal(store.size, 1);
  assert.deepEqual(store.query(oldSpot), [], '旧位置不得残留命中');
  assert.deepEqual(store.query({ lat: 0.005, lng: -179.85 }), ['a']);

  // 再替换为跨经线的圆。
  const across: CircleFence = {
    kind: 'circle',
    id: 'a',
    center: { lat: 0, lng: 180 },
    radiusMeters: 500,
  };
  store.replace(across);
  assert.deepEqual(store.query({ lat: 0.005, lng: -179.85 }), [], '上一次位置不得残留');
  assert.deepEqual(store.query({ lat: 0, lng: -179.999 }), ['a']);
  assert.deepEqual(store.query({ lat: 0, lng: 179.999 }), ['a']);
});

test('删除后查询不再命中，重复删除返回 false', () => {
  const store = new FenceStore();
  store.loadAll([circleA, circleB]);
  assert.equal(store.remove('a'), true);
  assert.deepEqual(store.query({ lat: 31.2, lng: 121.5 }), ['b']);
  assert.equal(store.remove('a'), false);
  assert.equal(store.remove('nope'), false);
  assert.equal(store.size, 1);
});

test('重新整体装载会清掉旧集合', () => {
  const store = new FenceStore();
  store.loadAll([circleA]);
  store.loadAll([polyC]);
  assert.equal(store.size, 1);
  assert.deepEqual(store.query({ lat: 31.2, lng: 121.5 }), ['c']);
});

test('非法围栏被拒绝', () => {
  const store = new FenceStore();
  // 半径越界。
  assert.throws(() => store.replace({ ...circleA, id: 'r1', radiusMeters: 49 }), /半径/);
  assert.throws(() => store.replace({ ...circleA, id: 'r2', radiusMeters: 5001 }), /半径/);
  // 顶点数越界。
  assert.throws(
    () =>
      store.replace({
        kind: 'polygon',
        id: 'p1',
        vertices: [
          { lat: 0, lng: 0 },
          { lat: 0, lng: 1 },
        ],
      }),
    /顶点数/,
  );
  // 顶点纬度越界。
  assert.throws(
    () =>
      store.replace({
        kind: 'polygon',
        id: 'p2',
        vertices: [
          { lat: 86, lng: 0 },
          { lat: 0, lng: 1 },
          { lat: 1, lng: 0 },
        ],
      }),
    /纬度/,
  );
  // 展开后经度跨度 >= 180。
  assert.throws(
    () =>
      store.replace({
        kind: 'polygon',
        id: 'p3',
        vertices: [
          { lat: 0, lng: 0 },
          { lat: 0, lng: 120 },
          { lat: 10, lng: -120 },
        ],
      }),
    /跨度/,
  );
  // 空标识。
  assert.throws(() => store.replace({ ...circleA, id: '' }), /标识/);
  // 非法查询点。
  assert.throws(() => store.query({ lat: 91, lng: 0 }), /纬度/);
  assert.throws(() => store.query({ lat: NaN, lng: 0 }), /有限/);
  assert.equal(store.size, 0, '非法围栏不得写入集合');
});

test('180 与 -180 是同一条经线', () => {
  const store = new FenceStore();
  const fences: Fence[] = [
    { kind: 'circle', id: 'east', center: { lat: 0, lng: 180 }, radiusMeters: 1000 },
    { kind: 'circle', id: 'west', center: { lat: 0, lng: -180 }, radiusMeters: 1000 },
  ];
  store.loadAll(fences);
  const hits = store.query({ lat: 0, lng: 179.999 });
  assert.deepEqual([...hits].sort(), ['east', 'west']);
});
