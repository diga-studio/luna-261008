import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FenceStore } from '../src/index.js';
import type { CircleFence, Fence, LatLng, PolygonFence } from '../src/index.js';
import { destinationPoint, mulberry32, refQuery } from './helpers.js';

function randCircle(rand: () => number, id: string): CircleFence {
  let lat: number;
  const mode = rand();
  if (mode < 0.2) {
    // 靠近极点（含覆盖极点）。
    lat = (85 + rand() * 5) * (rand() < 0.5 ? 1 : -1);
  } else {
    lat = rand() * 170 - 85;
  }
  let lng: number;
  if (rand() < 0.3) {
    // 靠近 180 经线。
    lng = 180 - rand() * 2;
    if (rand() < 0.5) lng = -lng;
    if (lng > 180) lng -= 360;
  } else {
    lng = rand() * 360 - 180;
  }
  return { kind: 'circle', id, center: { lat, lng }, radiusMeters: 50 + rand() * 4950 };
}

/** 星形（可凹）多边形，保证无自交；可跨 180 经线。 */
function randPolygon(rand: () => number, id: string): PolygonFence {
  const nearPole = rand() < 0.15;
  const lat0 = nearPole ? (75 + rand() * 8) * (rand() < 0.5 ? 1 : -1) : rand() * 150 - 75;
  let lng0: number;
  if (rand() < 0.4) {
    lng0 = 180 - rand();
    if (rand() < 0.5) lng0 = -lng0;
    if (lng0 > 180) lng0 -= 360;
  } else {
    lng0 = rand() * 360 - 180;
  }
  const n = 3 + Math.floor(rand() * 18);
  const maxR = Math.min(3, 84.5 - Math.abs(lat0));
  const vertices: LatLng[] = [];
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n + (rand() - 0.5) * (Math.PI / n);
    const r = (0.2 + rand() * 0.8) * maxR;
    const lat = lat0 + r * Math.sin(angle);
    let lng = lng0 + r * Math.cos(angle);
    lng = ((lng + 540) % 360) - 180;
    vertices.push({ lat, lng });
  }
  return { kind: 'polygon', id, vertices };
}

function randFence(rand: () => number, id: string): Fence {
  return rand() < 0.5 ? randCircle(rand, id) : randPolygon(rand, id);
}

/** 生成围绕围栏的探测点：随机邻近点 + 精确边界点。 */
function probePoints(rand: () => number, fences: Fence[]): LatLng[] {
  const points: LatLng[] = [];
  for (const fence of fences) {
    if (fence.kind === 'circle') {
      for (let k = 0; k < 4; k++) {
        const bearing = rand() * 2 * Math.PI;
        // 精确边界点与边界内外各 1 米的点。
        points.push(destinationPoint(fence.center, bearing, fence.radiusMeters));
        points.push(destinationPoint(fence.center, bearing, fence.radiusMeters - 1));
        points.push(destinationPoint(fence.center, bearing, fence.radiusMeters + 1));
        points.push(destinationPoint(fence.center, bearing, rand() * fence.radiusMeters * 2));
      }
    } else {
      const lats = fence.vertices.map((v) => v.lat);
      const lngs = fence.vertices.map((v) => v.lng);
      const latMin = Math.min(...lats);
      const latMax = Math.max(...lats);
      // 顶点与边中点（边界点）。
      for (let i = 0; i < fence.vertices.length; i++) {
        const a = fence.vertices[i]!;
        const b = fence.vertices[(i + 1) % fence.vertices.length]!;
        points.push({ ...a });
        let midLng = (a.lng + b.lng) / 2;
        if (Math.abs(a.lng - b.lng) > 180) {
          midLng = a.lng + (((b.lng - a.lng + 540) % 360) - 180) / 2;
          midLng = ((midLng + 540) % 360) - 180;
        }
        points.push({ lat: (a.lat + b.lat) / 2, lng: midLng });
      }
      // 纬度盒内随机点（经度取顶点附近）。
      for (let k = 0; k < 8; k++) {
        const base = lngs[Math.floor(rand() * lngs.length)]!;
        let lng = base + (rand() - 0.5) * 8;
        lng = ((lng + 540) % 360) - 180;
        points.push({ lat: latMin + rand() * (latMax - latMin), lng });
      }
    }
  }
  // 全局随机点。
  for (let k = 0; k < 20; k++) {
    points.push({ lat: rand() * 180 - 90, lng: rand() * 360 - 180 });
  }
  return points;
}

function assertQueryMatches(store: FenceStore, expected: Fence[], points: LatLng[]): void {
  for (const p of points) {
    const actual = [...store.query(p)].sort();
    const want = [...refQuery(expected, p)].sort();
    assert.deepEqual(actual, want, `查询点 ${JSON.stringify(p)}`);
  }
}

test('随机围栏集合：库查询与基准逐个判定一致', () => {
  const rand = mulberry32(20261008);
  for (let round = 0; round < 30; round++) {
    const count = 1 + Math.floor(rand() * 8);
    const fences: Fence[] = [];
    for (let i = 0; i < count; i++) fences.push(randFence(rand, `f${round}-${i}`));
    const store = new FenceStore();
    store.loadAll(fences);
    assertQueryMatches(store, fences, probePoints(rand, fences));
  }
});

test('随机替换/移动/删除序列：每步后查询都与基准一致，无旧位置残留', () => {
  const rand = mulberry32(987654321);
  const store = new FenceStore();
  let expected: Fence[] = [];
  const liveIds = new Set<string>();
  let nextId = 0;

  for (let step = 0; step < 60; step++) {
    const op = rand();
    if (op < 0.2 || expected.length === 0) {
      // 整体装载新集合。
      const count = 1 + Math.floor(rand() * 6);
      expected = [];
      liveIds.clear();
      for (let i = 0; i < count; i++) {
        const id = `s${nextId++}`;
        expected.push(randFence(rand, id));
        liveIds.add(id);
      }
      store.loadAll(expected);
    } else if (op < 0.7) {
      // 替换：可能沿用旧标识（改变形状和位置），也可能是新标识。
      const reuse = liveIds.size > 0 && rand() < 0.6;
      const id = reuse ? [...liveIds][Math.floor(rand() * liveIds.size)]! : `s${nextId++}`;
      const fence = randFence(rand, id);
      store.replace(fence);
      expected = expected.filter((f) => f.id !== id);
      expected.push(fence);
      liveIds.add(id);
    } else {
      // 删除一个现存标识。
      const id = [...liveIds][Math.floor(rand() * liveIds.size)]!;
      assert.equal(store.remove(id), true);
      expected = expected.filter((f) => f.id !== id);
      liveIds.delete(id);
    }
    assert.equal(store.size, expected.length);
    assertQueryMatches(store, expected, probePoints(rand, expected));
  }
});
