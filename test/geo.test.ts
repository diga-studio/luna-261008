import assert from "node:assert/strict";
import test from "node:test";
import {
  EARTH_RADIUS_METERS,
  normalizeLon,
  sphericalDistanceMeters,
  unwrapLonNear,
} from "../src/geo.js";

test("normalizeLon 将经度归一化到 (-180, 180]", () => {
  assert.equal(normalizeLon(0), 0);
  assert.equal(normalizeLon(180), 180);
  assert.equal(normalizeLon(-180), 180);
  assert.equal(normalizeLon(190), -170);
  assert.equal(normalizeLon(-190), 170);
  assert.equal(normalizeLon(540), 180);
});

test("unwrapLonNear 沿较短方向展开", () => {
  assert.equal(unwrapLonNear(-179, 179), 181);
  assert.equal(unwrapLonNear(179, -179), -181);
  assert.equal(unwrapLonNear(10, 20), 10);
  assert.equal(unwrapLonNear(-170, 175), 190);
});

test("球面距离：跨 180 度经线取较短方向", () => {
  const a = { lat: 0, lon: 179.9 };
  const b = { lat: 0, lon: -179.9 };
  const d = sphericalDistanceMeters(a, b);
  // 0.2 个经度在赤道上的弧长。
  const expected = EARTH_RADIUS_METERS * ((0.2 * Math.PI) / 180);
  assert.ok(Math.abs(d - expected) < 1e-6 * expected, `${d} vs ${expected}`);
});

test("球面距离：180 与 -180 是同一条经线", () => {
  const a = { lat: 10, lon: 180 };
  const b = { lat: 10, lon: -180 };
  assert.ok(sphericalDistanceMeters(a, b) < 1e-6);
});

test("球面距离：同一极点不同经度是同一点", () => {
  const a = { lat: 90, lon: 0 };
  const b = { lat: 90, lon: 120 };
  assert.ok(sphericalDistanceMeters(a, b) < 1e-6);
});

test("球面距离：赤道到极点为四分之一周长", () => {
  const d = sphericalDistanceMeters({ lat: 0, lon: 0 }, { lat: 90, lon: 0 });
  const expected = (EARTH_RADIUS_METERS * Math.PI) / 2;
  assert.ok(Math.abs(d - expected) < 1e-9 * expected);
});
