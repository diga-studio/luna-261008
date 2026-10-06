import assert from "node:assert/strict";
import test from "node:test";
import { polygonContains, validatePolygon } from "../src/polygon.js";
import type { GeoPoint, PolygonFence } from "../src/types.js";

/**
 * 基准实现：按业务规则逐个判定。
 * 经度沿较短方向展开后，在展开经纬度平面上用绕数法判定，边界单独精确判定。
 */
function baselineContains(fence: PolygonFence, point: GeoPoint): boolean {
  const norm = (lon: number) => {
    let v = lon % 360;
    if (v <= -180) v += 360;
    else if (v > 180) v -= 360;
    return v;
  };
  const xs: number[] = [fence.vertices[0]!.lon];
  const ys: number[] = [fence.vertices[0]!.lat];
  for (let i = 1; i < fence.vertices.length; i++) {
    xs.push(xs[i - 1]! + norm(fence.vertices[i]!.lon - xs[i - 1]!));
    ys.push(fence.vertices[i]!.lat);
  }
  let minX = Math.min(...xs);
  let maxX = Math.max(...xs);
  const px = ((point.lon - (minX + maxX) / 2) % 360 + 540) % 360 - 180 + (minX + maxX) / 2;
  const py = point.lat;
  // 边界判定：点到线段的二维距离。
  const n = xs.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = xs[i]!, ay = ys[i]!, bx = xs[j]!, by = ys[j]!;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const ex = ax + t * dx - px, ey = ay + t * dy - py;
    if (Math.hypot(ex, ey) < 1e-9) return true;
  }
  // 绕数法。
  let wn = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const cross = (xs[j]! - xs[i]!) * (py - ys[i]!) - (px - xs[i]!) * (ys[j]! - ys[i]!);
    if (ys[i]! <= py) {
      if (ys[j]! > py && cross > 0) wn++;
    } else {
      if (ys[j]! <= py && cross < 0) wn--;
    }
  }
  return wn !== 0;
}

function polygon(id: string, vertices: GeoPoint[]): PolygonFence {
  return { kind: "polygon", id, vertices };
}

/** 跨 180 度经线的凹多边形：占据 179..-179 之间的短跨度区域，呈 L 形凹槽。 */
const concaveAcrossMeridian = polygon("p1", [
  { lat: 10, lon: 179 },
  { lat: 10, lon: -179 },
  { lat: 0, lon: -179 },
  { lat: 0, lon: 179.5 },
  { lat: 5, lon: 179.5 },
  { lat: 5, lon: 179 },
]);

test("跨经线凹多边形：覆盖短跨度区域而不是世界其余部分", () => {
  // 凹槽外的两个矩形区域（经线两侧各一块）。
  assert.ok(polygonContains(concaveAcrossMeridian, { lat: 7.5, lon: 179.25 }));
  assert.ok(polygonContains(concaveAcrossMeridian, { lat: 7.5, lon: -179.75 }));
  assert.ok(polygonContains(concaveAcrossMeridian, { lat: 2.5, lon: -179.25 }));
  assert.ok(polygonContains(concaveAcrossMeridian, { lat: 7.5, lon: -179.5 }));
  // 凹口内部（0..5 纬度、179..179.5 经度）不命中。
  assert.ok(!polygonContains(concaveAcrossMeridian, { lat: 2.5, lon: 179.25 }));
  // 短跨度之外：世界其余部分不命中。
  assert.ok(!polygonContains(concaveAcrossMeridian, { lat: 7.5, lon: 170 }));
  assert.ok(!polygonContains(concaveAcrossMeridian, { lat: 7.5, lon: -170 }));
  assert.ok(!polygonContains(concaveAcrossMeridian, { lat: 7.5, lon: 0 }));
});

test("边界计入：顶点和边上的点都命中", () => {
  for (const v of concaveAcrossMeridian.vertices) {
    assert.ok(polygonContains(concaveAcrossMeridian, v), `vertex ${JSON.stringify(v)}`);
  }
  // 跨经线的边 (10,179)-(10,-179) 的中点 (10, 180)。
  assert.ok(polygonContains(concaveAcrossMeridian, { lat: 10, lon: 180 }));
  assert.ok(polygonContains(concaveAcrossMeridian, { lat: 10, lon: -180 }));
  // 普通边的中点。
  assert.ok(polygonContains(concaveAcrossMeridian, { lat: 5, lon: 179.25 }));
  // 边外紧邻点不命中。
  assert.ok(!polygonContains(concaveAcrossMeridian, { lat: 10.01, lon: 180 }));
});

test("简单矩形多边形（不跨经线）", () => {
  const rect = polygon("p2", [
    { lat: 0, lon: 100 },
    { lat: 0, lon: 101 },
    { lat: 1, lon: 101 },
    { lat: 1, lon: 100 },
  ]);
  assert.ok(polygonContains(rect, { lat: 0.5, lon: 100.5 }));
  assert.ok(polygonContains(rect, { lat: 0, lon: 100.5 }));
  assert.ok(!polygonContains(rect, { lat: 0.5, lon: 101.5 }));
  assert.ok(!polygonContains(rect, { lat: -0.5, lon: 100.5 }));
});

test("与基准实现在采样网格上一致（跨经线凹多边形）", () => {
  for (let lat = -1; lat <= 11; lat += 0.1) {
    for (let lon = -180; lon < 180; lon += 0.25) {
      const p = { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) };
      assert.equal(
        polygonContains(concaveAcrossMeridian, p),
        baselineContains(concaveAcrossMeridian, p),
        `point=(${p.lat},${p.lon})`,
      );
    }
  }
});

test("与基准实现在采样网格上一致（随机凹多边形）", () => {
  // 手工构造的凹多边形，顶点乱序方向、含凹陷。
  const star = polygon("p3", [
    { lat: 20, lon: -30 },
    { lat: 22, lon: -25 },
    { lat: 18, lon: -24 },
    { lat: 21, lon: -20 },
    { lat: 16, lon: -21 },
    { lat: 15, lon: -27 },
  ]);
  for (let lat = 14; lat <= 23; lat += 0.05) {
    for (let lon = -31; lon <= -19; lon += 0.05) {
      const p = { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) };
      assert.equal(
        polygonContains(star, p),
        baselineContains(star, p),
        `point=(${p.lat},${p.lon})`,
      );
    }
  }
});

test("参数校验：顶点数、纬度范围、经度跨度", () => {
  assert.throws(() =>
    validatePolygon(polygon("v1", [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 1 },
    ])),
  );
  assert.throws(() =>
    validatePolygon(polygon("v2", [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 1 },
      { lat: 86, lon: 0.5 },
    ])),
  );
  // 展开后跨度 >= 180 度。
  assert.throws(() =>
    validatePolygon(polygon("v3", [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 90 },
      { lat: 1, lon: 90 },
      { lat: 1, lon: -90 },
      { lat: 0, lon: -90 },
    ])),
  );
  validatePolygon(polygon("ok", [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 1 },
    { lat: 1, lon: 0 },
  ]));
});
