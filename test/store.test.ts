import assert from "node:assert/strict";
import test from "node:test";
import { FenceStore } from "../src/store.js";
import type { CircleFence, PolygonFence } from "../src/types.js";

function circle(id: string, lat: number, lon: number, radiusMeters: number): CircleFence {
  return { kind: "circle", id, center: { lat, lon }, radiusMeters };
}

function square(id: string, lat0: number, lon0: number, size: number): PolygonFence {
  return {
    kind: "polygon",
    id,
    vertices: [
      { lat: lat0, lon: lon0 },
      { lat: lat0, lon: lon0 + size },
      { lat: lat0 + size, lon: lon0 + size },
      { lat: lat0 + size, lon: lon0 },
    ],
  };
}

test("整体装载与命中查询：重叠围栏全部返回且无重复", () => {
  const store = new FenceStore();
  store.loadAll([
    circle("a", 0, 0, 5000),
    circle("b", 0, 0, 1000),
    square("c", -1, -1, 2),
    square("d", 10, 10, 1),
  ]);
  assert.equal(store.size, 4);
  const hits = store.query({ lat: 0, lon: 0 });
  assert.deepEqual(new Set(hits), new Set(["a", "b", "c"]));
  assert.equal(hits.length, new Set(hits).size);
  assert.deepEqual(store.query({ lat: 10.5, lon: 10.5 }), ["d"]);
  assert.deepEqual(store.query({ lat: 40, lon: 40 }), []);
});

test("loadAll 拒绝重复标识", () => {
  const store = new FenceStore();
  assert.throws(() =>
    store.loadAll([circle("x", 0, 0, 100), circle("x", 1, 1, 100)]),
  );
  // 装载失败后保持原有状态。
  store.loadAll([circle("y", 0, 0, 100)]);
  assert.throws(() =>
    store.loadAll([circle("x", 0, 0, 100), circle("x", 1, 1, 100)]),
  );
  assert.deepEqual(store.query({ lat: 0, lon: 0 }), ["y"]);
});

test("替换可以改变形状和位置，下一次查询立即生效", () => {
  const store = new FenceStore();
  store.loadAll([circle("f", 0, 0, 1000)]);
  assert.deepEqual(store.query({ lat: 0, lon: 0 }), ["f"]);

  // 同标识替换为多边形，位置移到别处。
  store.replace(square("f", 50, 50, 1));
  assert.deepEqual(store.query({ lat: 0, lon: 0 }), []);
  assert.deepEqual(store.query({ lat: 50.5, lon: 50.5 }), ["f"]);
  assert.equal(store.size, 1);

  // 再替换回圆形，移到 180 度经线另一侧。
  store.replace(circle("f", 0, -179.98, 5000));
  assert.deepEqual(store.query({ lat: 50.5, lon: 50.5 }), []);
  assert.deepEqual(store.query({ lat: 0, lon: 179.98 }), ["f"]);
  assert.deepEqual(store.query({ lat: 0, lon: -179.98 }), ["f"]);
});

test("移动到经线另一侧并删除后，旧区域无残留命中", () => {
  const store = new FenceStore();
  // 初始：圆在经线东侧。
  store.loadAll([circle("m", 0, 179.98, 5000)]);
  assert.deepEqual(store.query({ lat: 0, lon: 179.98 }), ["m"]);

  // 替换：移到经线另一侧（西侧），旧中心位置不再命中。
  store.replace(circle("m", 0, -179.5, 5000));
  assert.deepEqual(store.query({ lat: 0, lon: -179.5 }), ["m"]);
  assert.deepEqual(store.query({ lat: 0, lon: 179.98 }), [], "旧位置无残留命中");

  // 替换：彻底移走。
  store.replace(circle("m", 60, 0, 5000));
  assert.deepEqual(store.query({ lat: 0, lon: 179.98 }), []);
  assert.deepEqual(store.query({ lat: 0, lon: -179.98 }), []);

  // 删除后任何位置都不再命中。
  assert.equal(store.remove("m"), true);
  assert.equal(store.remove("m"), false);
  assert.deepEqual(store.query({ lat: 60, lon: 0 }), []);
  assert.equal(store.size, 0);
});

test("loadAll 整体替换后旧围栏不再命中", () => {
  const store = new FenceStore();
  store.loadAll([circle("old", 0, 0, 5000)]);
  store.loadAll([circle("new", 80, 0, 5000)]);
  assert.deepEqual(store.query({ lat: 0, lon: 0 }), []);
  assert.deepEqual(store.query({ lat: 80, lon: 0 }), ["new"]);
  assert.equal(store.size, 1);
});

test("查询点坐标范围校验", () => {
  const store = new FenceStore();
  assert.throws(() => store.query({ lat: 91, lon: 0 }));
  assert.throws(() => store.query({ lat: 0, lon: 181 }));
});
