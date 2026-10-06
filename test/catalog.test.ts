import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCatalog } from "../src/catalog.js";
import { haversineM } from "../src/geo.js";
import type {
  Branch,
  CatalogData,
  ZipCenters,
} from "../src/types.js";
import { assertHitsEqual, bruteForceSearch } from "./reference.js";

function branch(
  id: string,
  lat: number,
  lon: number,
  vehicles: string[],
  priceCents: number,
): Branch {
  return { id, lat, lon, vehicles: new Set(vehicles), priceCents };
}

function runAndCompare(
  data: CatalogData,
  zips: ZipCenters,
  query: Parameters<ReturnType<typeof buildCatalog>["search"]>[0],
): void {
  const catalog = buildCatalog(data, zips);
  const actual = catalog.search(query);
  const expected = bruteForceSearch(data, zips, query);
  assertHitsEqual(actual.hits, expected, assert);
}

test("nearest branch unqualified; farther branch of same school contributes", () => {
  const zips: ZipCenters = { "00000": { lat: 40, lon: -105 } };
  const data: CatalogData = {
    institutions: [
      {
        id: "A",
        branches: [
          branch("a-near", 40.001, -105, ["truck"], 20000),
          branch("a-far", 40.02, -105, ["sedan"], 23000),
        ],
      },
      {
        id: "B",
        branches: [branch("b-mid", 40.01, -105, ["sedan"], 23000)],
      },
    ],
  };
  const catalog = buildCatalog(data, zips);
  const result = catalog.search({
    zip: "00000",
    radiusM: 100_000,
    k: 5,
    vehicle: "sedan",
    priceMin: 22000,
    priceMax: 24000,
  });
  assert.deepStrictEqual(
    result.hits.map((h) => [h.institutionId, h.branchId]),
    [
      ["B", "b-mid"],
      ["A", "a-far"],
    ],
  );
  const expectedFar = haversineM(40, -105, 40.02, -105);
  assert.ok(Math.abs(result.hits[1].distanceM - expectedFar) <= 0.001);
  assertHitsEqual(
    result.hits,
    bruteForceSearch(data, zips, {
      zip: "00000",
      radiusM: 100_000,
      k: 5,
      vehicle: "sedan",
      priceMin: 22000,
      priceMax: 24000,
    }),
    assert,
  );
});

test("many nearest branches of one school; dedup keeps correct top-k", () => {
  const zips: ZipCenters = { z: { lat: 35, lon: 139 } };
  const crowded: Branch[] = [];
  for (let i = 0; i < 50; i++) {
    crowded.push(
      branch(`c-${i}`, 35 + 0.0001 * (i + 1), 139, ["sedan"], 23000),
    );
  }
  const data: CatalogData = {
    institutions: [
      { id: "C", branches: crowded },
      { id: "D", branches: [branch("d-0", 35.05, 139, ["sedan"], 23000)] },
      { id: "E", branches: [branch("e-0", 35.06, 139, ["sedan"], 23000)] },
    ],
  };
  const catalog = buildCatalog(data, zips);
  const result = catalog.search({ zip: "z", radiusM: 50_000, k: 2 });
  assert.deepStrictEqual(
    result.hits.map((h) => h.institutionId),
    ["C", "D"],
  );
  assert.strictEqual(result.hits[0].branchId, "c-0");
  assertHitsEqual(
    result.hits,
    bruteForceSearch(data, zips, { zip: "z", radiusM: 50_000, k: 2 }),
    assert,
  );
});

test("vehicle and price filters cannot be stitched across branches", () => {
  const zips: ZipCenters = { z: { lat: 34, lon: -118 } };
  const data: CatalogData = {
    institutions: [
      {
        id: "F",
        branches: [
          branch("f-sedan-expensive", 34.001, -118, ["sedan"], 50000),
          branch("f-truck-cheap", 34.002, -118, ["truck"], 23000),
        ],
      },
      {
        id: "G",
        branches: [branch("g-ok", 34.01, -118, ["sedan"], 23000)],
      },
    ],
  };
  const catalog = buildCatalog(data, zips);
  const result = catalog.search({
    zip: "z",
    radiusM: 50_000,
    k: 5,
    vehicle: "sedan",
    priceMin: 22000,
    priceMax: 24000,
  });
  assert.deepStrictEqual(
    result.hits.map((h) => h.institutionId),
    ["G"],
  );
});

test("high latitude queries match brute force", () => {
  const zips: ZipCenters = { z: { lat: 80, lon: 0 } };
  const data: CatalogData = {
    institutions: [
      { id: "H1", branches: [branch("h1", 80.5, 30, ["SUV"], 30000)] },
      { id: "H2", branches: [branch("h2", 79.8, -40, ["SUV"], 30000)] },
      { id: "H3", branches: [branch("h3", 81.2, 170, ["SUV"], 30000)] },
      { id: "H4", branches: [branch("h4", 85, 0, ["SUV"], 30000)] },
    ],
  };
  runAndCompare(data, zips, { zip: "z", radiusM: 500_000, k: 3 });
  runAndCompare(data, zips, { zip: "z", radiusM: 2_000_000, k: 10 });
});

test("crossing the 180th meridian takes the short arc", () => {
  const zips: ZipCenters = { z: { lat: 10, lon: 179.9 } };
  const data: CatalogData = {
    institutions: [
      { id: "M1", branches: [branch("m1", 10, -179.9, ["sedan"], 10000)] },
      { id: "M2", branches: [branch("m2", 10, 170, ["sedan"], 10000)] },
    ],
  };
  const catalog = buildCatalog(data, zips);
  const result = catalog.search({ zip: "z", radiusM: 50_000, k: 5 });
  assert.deepStrictEqual(
    result.hits.map((h) => h.institutionId),
    ["M1"],
  );
  const expected = haversineM(10, 179.9, 10, -179.9);
  assert.ok(expected < 25_000, `short arc expected, got ${expected}`);
  assert.ok(Math.abs(result.hits[0].distanceM - expected) <= 0.001);
  runAndCompare(data, zips, { zip: "z", radiusM: 2_000_000, k: 5 });
});

test("zero radius only matches branches exactly at the center", () => {
  const zips: ZipCenters = { z: { lat: 35, lon: 140 } };
  const data: CatalogData = {
    institutions: [
      { id: "Z1", branches: [branch("z1", 35, 140, ["sedan"], 10000)] },
      { id: "Z2", branches: [branch("z2", 35.00001, 140, ["sedan"], 10000)] },
    ],
  };
  const catalog = buildCatalog(data, zips);
  const result = catalog.search({ zip: "z", radiusM: 0, k: 5 });
  assert.deepStrictEqual(
    result.hits.map((h) => [h.institutionId, h.distanceM]),
    [["Z1", 0]],
  );
});

test("equal distances break ties by institution id and branch id", () => {
  const zips: ZipCenters = { z: { lat: 30, lon: 50 } };
  const data: CatalogData = {
    institutions: [
      {
        id: "I0",
        branches: [
          branch("b2", 30.01, 50, ["sedan"], 10000),
          branch("b1", 30.01, 50, ["sedan"], 10000),
        ],
      },
      { id: "I2", branches: [branch("i2", 30.01, 50, ["sedan"], 10000)] },
      { id: "I1", branches: [branch("i1", 30.01, 50, ["sedan"], 10000)] },
    ],
  };
  const catalog = buildCatalog(data, zips);
  const result = catalog.search({ zip: "z", radiusM: 10_000, k: 3 });
  assert.deepStrictEqual(
    result.hits.map((h) => [h.institutionId, h.branchId]),
    [
      ["I0", "b1"],
      ["I1", "i1"],
      ["I2", "i2"],
    ],
  );
  assert.ok(
    result.hits.every((h) => h.distanceM === result.hits[0].distanceM),
  );
});

test("branch exactly on the radius boundary is included", () => {
  const zips: ZipCenters = { z: { lat: 45, lon: 7 } };
  const data: CatalogData = {
    institutions: [
      { id: "B1", branches: [branch("b1", 45.5, 7.3, ["sedan"], 10000)] },
    ],
  };
  const d = haversineM(45, 7, 45.5, 7.3);
  const catalog = buildCatalog(data, zips);
  const included = catalog.search({ zip: "z", radiusM: d, k: 5 });
  assert.strictEqual(included.hits.length, 1);
  assert.strictEqual(included.hits[0].distanceM, d);
  const excluded = catalog.search({ zip: "z", radiusM: d - 0.01, k: 5 });
  assert.strictEqual(excluded.hits.length, 0);
});

test("no filters: plain nearest-neighbour ordering", () => {
  const zips: ZipCenters = { z: { lat: 0, lon: 0 } };
  const data: CatalogData = {
    institutions: [
      { id: "N3", branches: [branch("n3", 0.3, 0, ["sedan"], 10000)] },
      { id: "N1", branches: [branch("n1", 0.1, 0, ["sedan"], 10000)] },
      { id: "N2", branches: [branch("n2", 0.2, 0, ["sedan"], 10000)] },
    ],
  };
  const catalog = buildCatalog(data, zips);
  const result = catalog.search({ zip: "z", radiusM: 100_000, k: 2 });
  assert.deepStrictEqual(
    result.hits.map((h) => h.institutionId),
    ["N1", "N2"],
  );
  assert.ok(result.examined > 0);
});
