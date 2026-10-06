import assert from "node:assert/strict";
import test from "node:test";
import { buildCatalog } from "../src/catalog.js";
import { haversineM } from "../src/geo.js";
import type {
  InstitutionInput,
  SearchQuery,
  ZipCenters,
} from "../src/types.js";
import { referenceSearch } from "./reference.js";

function makeZip(lat: number, lon: number): ZipCenters {
  return { "00000": { lat, lon } };
}

function query(partial: Partial<SearchQuery>): SearchQuery {
  return { zip: "00000", radiusM: 100000, k: 10, ...partial };
}

test("车辆与价格条件必须在同一校区上同时成立", () => {
  const data: InstitutionInput[] = [
    {
      id: "A",
      branches: [
        // 近、有 sedan、但太贵
        { id: "a1", lat: 40.005, lon: -105, vehicles: ["sedan"], priceCents: 50000 },
        // 近、便宜、但没有 sedan
        { id: "a2", lat: 40.01, lon: -105, vehicles: ["truck"], priceCents: 20000 },
      ],
    },
    {
      id: "B",
      branches: [
        { id: "b1", lat: 40.05, lon: -105, vehicles: ["sedan"], priceCents: 25000 },
      ],
    },
  ];
  const zips = makeZip(40, -105);
  const catalog = buildCatalog(data, zips);
  const q = query({ vehicle: "sedan", priceMax: 30000 });
  const actual = catalog.search(q);
  const expected = referenceSearch(data, zips, q);
  assert.deepEqual(actual.results, expected.results);
  assert.equal(actual.results.length, 1);
  assert.equal(actual.results[0]!.institutionId, "B");
});

test("最近校区不合格时由同校更远校区贡献距离", () => {
  const data: InstitutionInput[] = [
    {
      id: "C",
      branches: [
        { id: "c1", lat: 40.005, lon: -105, vehicles: ["truck"], priceCents: 20000 },
        { id: "c2", lat: 40.03, lon: -105, vehicles: ["sedan"], priceCents: 20000 },
      ],
    },
    {
      id: "D",
      branches: [
        { id: "d1", lat: 40.02, lon: -105, vehicles: ["sedan"], priceCents: 20000 },
      ],
    },
  ];
  const zips = makeZip(40, -105);
  const catalog = buildCatalog(data, zips);
  const q = query({ vehicle: "sedan" });
  const actual = catalog.search(q);
  const expected = referenceSearch(data, zips, q);
  assert.deepEqual(actual.results, expected.results);
  // D 的 2km 合格校区比 C 的 3km 合格校区近；C 的 0.5km truck 校区不得贡献距离
  assert.deepEqual(
    actual.results.map((r) => [r.institutionId, r.branchId]),
    [
      ["D", "d1"],
      ["C", "c2"],
    ],
  );
});

test("大量最近校区属于同一驾校时去重后仍取正确前 k", () => {
  const data: InstitutionInput[] = [
    {
      id: "BIG",
      branches: Array.from({ length: 30 }, (_, i) => ({
        id: `big${i}`,
        lat: 40 + 0.001 * (i + 1),
        lon: -105,
        vehicles: ["sedan"],
        priceCents: 20000,
      })),
    },
    ...Array.from({ length: 8 }, (_, i) => ({
      id: `S${i}`,
      branches: [
        {
          id: `s${i}`,
          lat: 40.1 + 0.01 * i,
          lon: -105,
          vehicles: ["sedan"],
          priceCents: 20000,
        },
      ],
    })),
  ];
  const zips = makeZip(40, -105);
  const catalog = buildCatalog(data, zips);
  const q = query({ k: 5 });
  const actual = catalog.search(q);
  const expected = referenceSearch(data, zips, q);
  assert.deepEqual(actual.results, expected.results);
  assert.equal(actual.results.length, 5);
  assert.equal(actual.results[0]!.institutionId, "BIG");
  assert.equal(actual.results[0]!.branchId, "big0");
  assert.deepEqual(
    actual.results.slice(1).map((r) => r.institutionId),
    ["S0", "S1", "S2", "S3"],
  );
});

test("跨 180 度经线走短弧", () => {
  const data: InstitutionInput[] = [
    {
      id: "W",
      branches: [
        { id: "w1", lat: 0, lon: -179.9, vehicles: ["sedan"], priceCents: 20000 },
      ],
    },
    {
      id: "FAR",
      branches: [
        { id: "f1", lat: 0, lon: 170, vehicles: ["sedan"], priceCents: 20000 },
      ],
    },
  ];
  const zips = makeZip(0, 179.9);
  const catalog = buildCatalog(data, zips);
  const q = query({ radiusM: 50000 });
  const actual = catalog.search(q);
  const expected = referenceSearch(data, zips, q);
  assert.deepEqual(actual.results, expected.results);
  assert.equal(actual.results.length, 1);
  assert.equal(actual.results[0]!.institutionId, "W");
  // 0.2 度赤道弧长约 22.2km，绝不能按 340 度长弧计算
  assert.ok(actual.results[0]!.distanceM < 30000);
});

test("高纬度区域与参考实现一致", () => {
  const data: InstitutionInput[] = [
    {
      id: "N1",
      branches: [
        { id: "n1", lat: 82, lon: 10, vehicles: ["sedan"], priceCents: 20000 },
      ],
    },
    {
      id: "N2",
      branches: [
        { id: "n2", lat: 82, lon: -10, vehicles: ["sedan"], priceCents: 20000 },
      ],
    },
    {
      id: "N3",
      branches: [
        { id: "n3", lat: 85, lon: 120, vehicles: ["sedan"], priceCents: 20000 },
      ],
    },
  ];
  const zips = makeZip(80, 0);
  const catalog = buildCatalog(data, zips);
  const q = query({ radiusM: 2000000, k: 3 });
  const actual = catalog.search(q);
  const expected = referenceSearch(data, zips, q);
  assert.deepEqual(actual.results, expected.results);
  // 高纬度 20 度经差远小于赤道，N2 应排在 N1 前（两侧对称时按 id）
  assert.deepEqual(
    actual.results.map((r) => r.institutionId),
    expected.results.map((r) => r.institutionId),
  );
});

test("零半径只命中与中心完全重合的校区", () => {
  const data: InstitutionInput[] = [
    {
      id: "HERE",
      branches: [
        { id: "h1", lat: 35.5, lon: -97.5, vehicles: ["sedan"], priceCents: 20000 },
      ],
    },
    {
      id: "NEAR",
      branches: [
        { id: "n1", lat: 35.50001, lon: -97.5, vehicles: ["sedan"], priceCents: 20000 },
      ],
    },
  ];
  const zips = makeZip(35.5, -97.5);
  const catalog = buildCatalog(data, zips);
  const q = query({ radiusM: 0 });
  const actual = catalog.search(q);
  const expected = referenceSearch(data, zips, q);
  assert.deepEqual(actual.results, expected.results);
  assert.equal(actual.results.length, 1);
  assert.equal(actual.results[0]!.institutionId, "HERE");
  assert.equal(actual.results[0]!.distanceM, 0);
});

test("等距驾校按 id 字典序、等距校区按校区 id 字典序", () => {
  const data: InstitutionInput[] = [
    {
      id: "B",
      branches: [
        { id: "b2", lat: 0, lon: 1, vehicles: ["sedan"], priceCents: 20000 },
        { id: "b1", lat: 0, lon: -1, vehicles: ["sedan"], priceCents: 20000 },
      ],
    },
    {
      id: "A",
      branches: [
        { id: "a1", lat: 1, lon: 0, vehicles: ["sedan"], priceCents: 20000 },
      ],
    },
    {
      id: "C",
      branches: [
        { id: "c1", lat: -1, lon: 0, vehicles: ["sedan"], priceCents: 20000 },
      ],
    },
  ];
  const zips = makeZip(0, 0);
  const catalog = buildCatalog(data, zips);
  const q = query({ radiusM: 200000, k: 3 });
  const actual = catalog.search(q);
  const expected = referenceSearch(data, zips, q);
  assert.deepEqual(actual.results, expected.results);
  assert.deepEqual(
    actual.results.map((r) => r.institutionId),
    ["A", "B", "C"],
  );
  // b1 与 b2 等距，取字典序较小的 b1
  assert.equal(actual.results[1]!.branchId, "b1");
});

test("恰好落在半径边界上的校区被包含", () => {
  const branchLat = 41;
  const branchLon = -104;
  const centerLat = 40;
  const centerLon = -105;
  const radius = haversineM(centerLat, centerLon, branchLat, branchLon);
  const data: InstitutionInput[] = [
    {
      id: "EDGE",
      branches: [
        { id: "e1", lat: branchLat, lon: branchLon, vehicles: ["sedan"], priceCents: 20000 },
      ],
    },
    {
      id: "OUT",
      branches: [
        { id: "o1", lat: 42, lon: -103, vehicles: ["sedan"], priceCents: 20000 },
      ],
    },
  ];
  const zips = makeZip(centerLat, centerLon);
  const catalog = buildCatalog(data, zips);
  const q = query({ radiusM: radius });
  const actual = catalog.search(q);
  const expected = referenceSearch(data, zips, q);
  assert.deepEqual(actual.results, expected.results);
  assert.equal(actual.results.length, 1);
  assert.equal(actual.results[0]!.institutionId, "EDGE");
  assert.equal(actual.results[0]!.distanceM, radius);
});

class Lcg {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state * 1664525 + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
}

function randomData(rng: Lcg, institutions: number): InstitutionInput[] {
  const vehiclePool = ["sedan", "SUV", "truck"];
  return Array.from({ length: institutions }, (_, i) => ({
    id: `inst${i}`,
    branches: Array.from({ length: 1 + rng.int(4) }, (_, j) => ({
      id: `b${i}_${j}`,
      lat: 25 + rng.next() * 24,
      lon: -125 + rng.next() * 58,
      vehicles: vehiclePool.filter(() => rng.next() < 0.5),
      priceCents: 20000 + 1000 * rng.int(11),
    })),
  }));
}

test("随机数据集与穷举参考实现完全一致", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const rng = new Lcg(seed);
    const data = randomData(rng, 40);
    const zips: Record<string, { lat: number; lon: number }> = {};
    for (let z = 0; z < 5; z++) {
      zips[`z${z}`] = { lat: 25 + rng.next() * 24, lon: -125 + rng.next() * 58 };
    }
    const catalog = buildCatalog(data, zips);
    for (let t = 0; t < 30; t++) {
      const q: SearchQuery = {
        zip: `z${rng.int(5)}`,
        radiusM: [10000, 100000, 1000000, 5000000][rng.int(4)]!,
        k: 1 + rng.int(15),
      };
      if (rng.next() < 0.6) {
        q.vehicle = ["sedan", "SUV", "truck"][rng.int(3)]!;
      }
      if (rng.next() < 0.5) {
        q.priceMin = 20000 + 1000 * rng.int(6);
      }
      if (rng.next() < 0.5) {
        q.priceMax = 25000 + 1000 * rng.int(6);
      }
      const actual = catalog.search(q);
      const expected = referenceSearch(data, zips, q);
      assert.deepEqual(
        actual.results,
        expected.results,
        `seed=${seed} query=${JSON.stringify(q)}`,
      );
      assert.ok(actual.examined <= expected.examined);
    }
  }
});
