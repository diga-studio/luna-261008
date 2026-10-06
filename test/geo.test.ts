import { test } from 'node:test';
import assert from 'node:assert/strict';
import { circleContains, polygonContains } from '../src/index.js';
import { destinationPoint, refCircleContains, refPolygonContains } from './helpers.js';

test('跨 180 经线的圆：短距离命中，远距离不命中', () => {
  const center = { lat: 0, lng: 179.98 };
  const radius = 5000;
  // 经线另一侧，球面距离约 4.45km < 5km。
  assert.equal(circleContains(center, radius, { lat: 0, lng: -179.98 }), true);
  assert.equal(refCircleContains(center, radius, { lat: 0, lng: -179.98 }), true);
  // 同侧远处不命中。
  assert.equal(circleContains(center, radius, { lat: 0, lng: 170 }), false);
  // 圆心另一侧 10km 处不命中。
  assert.equal(circleContains(center, radius, { lat: 0, lng: -179.8 }), false);
});

test('覆盖极点的圆：极点任意经度都命中', () => {
  const center = { lat: 89.97, lng: 0 };
  const radius = 5000;
  // 极点本身，经度任意。
  assert.equal(circleContains(center, radius, { lat: 90, lng: 0 }), true);
  assert.equal(circleContains(center, radius, { lat: 90, lng: 137 }), true);
  assert.equal(circleContains(center, radius, { lat: 90, lng: -120 }), true);
  // 圆心背侧、跨越极点的点。
  assert.equal(circleContains(center, radius, { lat: 89.99, lng: 180 }), true);
  assert.equal(circleContains(center, radius, { lat: 89.98, lng: 180 }), false);
  // 远处不命中。
  assert.equal(circleContains(center, radius, { lat: 89.5, lng: 0 }), false);
  // 与基准一致。
  for (const lng of [-180, -90, 0, 90, 179]) {
    const p = { lat: 89.99, lng };
    assert.equal(circleContains(center, radius, p), refCircleContains(center, radius, p));
  }
});

test('圆的边界点计入围栏', () => {
  const center = { lat: 30, lng: 120 };
  const radius = 3000;
  for (const bearing of [0, Math.PI / 3, Math.PI / 2, Math.PI, 4.2]) {
    const onEdge = destinationPoint(center, bearing, radius);
    assert.equal(circleContains(center, radius, onEdge), true, `bearing=${bearing}`);
    const outside = destinationPoint(center, bearing, radius + 1);
    assert.equal(circleContains(center, radius, outside), false, `bearing=${bearing}`);
  }
});

// 凹多边形（飞镖形），展开经度 170..190，跨 180 经线。
const dart = [
  { lat: 0, lng: 170 },
  { lat: 10, lng: 180 },
  { lat: 0, lng: -170 }, // 展开后为 190
  { lat: 3, lng: 180 }, // 凹点
];

test('跨 180 经线的凹多边形：覆盖短跨度区域', () => {
  // 凹口内的点不命中。
  assert.equal(polygonContains(dart, { lat: 1, lng: 180 }), false);
  // 主体内的点命中。
  assert.equal(polygonContains(dart, { lat: 5, lng: 180 }), true);
  assert.equal(polygonContains(dart, { lat: 5, lng: 179 }), true);
  assert.equal(polygonContains(dart, { lat: 5, lng: -179 }), true);
  assert.equal(polygonContains(dart, { lat: 1, lng: 172 }), true);
  // 主体三角形之外、靠近顶点经度的点不命中。
  assert.equal(polygonContains(dart, { lat: 1, lng: 170.1 }), false);
  // 短跨度之外（世界其余部分）不命中。
  assert.equal(polygonContains(dart, { lat: 5, lng: 0 }), false);
  assert.equal(polygonContains(dart, { lat: 5, lng: 90 }), false);
  assert.equal(polygonContains(dart, { lat: 5, lng: -90 }), false);
  assert.equal(polygonContains(dart, { lat: 20, lng: 180 }), false);
  // 与基准一致。
  for (const p of [
    { lat: 1, lng: 180 },
    { lat: 5, lng: 180 },
    { lat: 5, lng: -179 },
    { lat: 1, lng: 172 },
    { lat: 1, lng: 170.1 },
    { lat: 5, lng: 0 },
    { lat: 0.5, lng: -170 },
  ]) {
    assert.equal(polygonContains(dart, p), refPolygonContains(dart, p), JSON.stringify(p));
  }
});

test('多边形顶点与边上的点计入围栏', () => {
  // 顶点（含跨经线顶点）。
  assert.equal(polygonContains(dart, { lat: 0, lng: -170 }), true);
  assert.equal(polygonContains(dart, { lat: 10, lng: 180 }), true);
  assert.equal(polygonContains(dart, { lat: 3, lng: 180 }), true);
  // 跨经线段 (10,180)-(0,190) 的中点 (5,185) 即 (5,-175)。
  assert.equal(polygonContains(dart, { lat: 5, lng: -175 }), true);
  // 普通正方形。
  const square = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 10 },
    { lat: 10, lng: 10 },
    { lat: 10, lng: 0 },
  ];
  assert.equal(polygonContains(square, { lat: 0, lng: 0 }), true); // 顶点
  assert.equal(polygonContains(square, { lat: 0, lng: 5 }), true); // 边中点
  assert.equal(polygonContains(square, { lat: 10, lng: 10 }), true); // 顶点
  assert.equal(polygonContains(square, { lat: 5, lng: 5 }), true); // 内部
  assert.equal(polygonContains(square, { lat: -0.001, lng: 5 }), false); // 边外一点
});

test('高纬度多边形与极点附近查询点', () => {
  const poly = [
    { lat: 80, lng: -10 },
    { lat: 80, lng: 10 },
    { lat: 84, lng: 0 },
  ];
  assert.equal(polygonContains(poly, { lat: 82, lng: 0 }), true);
  // 极点在所有顶点纬度之上，不命中。
  assert.equal(polygonContains(poly, { lat: 90, lng: 0 }), false);
  assert.equal(polygonContains(poly, { lat: -90, lng: 0 }), false);
});
