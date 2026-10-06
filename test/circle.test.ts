import assert from "node:assert/strict";
import test from "node:test";
import { circleContains, validateCircle } from "../src/circle.js";
import { EARTH_RADIUS_METERS } from "../src/geo.js";
import type { CircleFence, GeoPoint } from "../src/types.js";

/** 基准实现：按业务规则（haversine 球面最短距离 <= 半径）逐个判定。 */
function baselineContains(fence: CircleFence, point: GeoPoint): boolean {
  const rad = Math.PI / 180;
  const lat1 = fence.center.lat * rad;
  const lat2 = point.lat * rad;
  const dLat = (point.lat - fence.center.lat) * rad;
  let dLonDeg = point.lon - fence.center.lon;
  dLonDeg = ((dLonDeg % 360) + 540) % 360 - 180;
  const dLon = dLonDeg * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h)) <= fence.radiusMeters;
}

function circle(id: string, lat: number, lon: number, radiusMeters: number): CircleFence {
  return { kind: "circle", id, center: { lat, lon }, radiusMeters };
}

test("跨 180 度经线的圆：两侧都命中", () => {
  const fence = circle("c1", 0, 179.98, 5000);
  assert.ok(circleContains(fence, { lat: 0, lon: 179.98 }));
  // 与中心相距 0.04 个经度（约 4451 米），在半径内。
  assert.ok(circleContains(fence, { lat: 0, lon: -179.98 }));
  // 远离经线两侧的点不命中。
  assert.ok(!circleContains(fence, { lat: 0, lon: 179 }));
  assert.ok(!circleContains(fence, { lat: 0, lon: -179 }));
});

test("覆盖北极点的圆：极点及任意经度的高纬点都命中", () => {
  // 中心在 89.99N，极点距中心约 1112 米，在 5000 米半径内。
  const onPole = circle("c3", 89.99, 0, 5000);
  assert.ok(circleContains(onPole, { lat: 90, lon: 0 }));
  assert.ok(circleContains(onPole, { lat: 90, lon: 137 }));
  // 经线另一侧的高纬点，越过极点的球面距离约 4448 米。
  assert.ok(circleContains(onPole, { lat: 89.97, lon: 180 }));
  // 距中心超过半径的点不命中。
  assert.ok(!circleContains(onPole, { lat: 89.9, lon: 180 }));
});

test("覆盖南极点的圆", () => {
  const fence = circle("c4", -89.99, 100, 5000);
  assert.ok(circleContains(fence, { lat: -90, lon: 0 }));
  assert.ok(circleContains(fence, { lat: -90, lon: -100 }));
  assert.ok(!circleContains(fence, { lat: -89.9, lon: -80 }));
});

test("边界上的点计入围栏", () => {
  const fence = circle("c5", 0, 0, 1000);
  // 赤道上沿经线移动 1000 米对应的经度差。
  const dLon = (1000 / EARTH_RADIUS_METERS) * (180 / Math.PI);
  assert.ok(circleContains(fence, { lat: 0, lon: dLon }));
  assert.ok(!circleContains(fence, { lat: 0, lon: dLon * 1.01 }));
});

test("与基准实现在大范围采样点上一致（含跨经线与近极点圆）", () => {
  const fences = [
    circle("f1", 0.3, 179.8, 5000),
    circle("f2", 0.3, -179.8, 50),
    circle("f3", 88, 45, 5000),
    circle("f4", -88, -45, 3000),
    circle("f5", 30, 120, 1500),
  ];
  for (const fence of fences) {
    for (let lat = -90; lat <= 90; lat += 0.5) {
      for (let lon = -180; lon < 180; lon += 0.5) {
        const p = { lat, lon };
        assert.equal(
          circleContains(fence, p),
          baselineContains(fence, p),
          `fence=${fence.id} point=(${lat},${lon})`,
        );
      }
    }
  }
});

test("参数校验：半径与中心坐标范围", () => {
  assert.throws(() => validateCircle(circle("b1", 0, 0, 49)));
  assert.throws(() => validateCircle(circle("b2", 0, 0, 5001)));
  assert.throws(() => validateCircle(circle("b3", 91, 0, 100)));
  assert.throws(() => validateCircle(circle("b4", 0, 181, 100)));
  validateCircle(circle("ok", 0, 0, 50));
  validateCircle(circle("ok2", 0, 0, 5000));
});
