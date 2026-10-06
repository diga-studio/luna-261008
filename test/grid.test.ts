import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCatalog } from "../src/catalog.js";
import type {
  Branch,
  CatalogData,
  Query,
  ZipCenters,
} from "../src/types.js";
import { assertHitsEqual, bruteForceSearch } from "./reference.js";

const ROWS = 400;
const COLS = 400;
const QUERIES = 100;
const VEHICLES = ["sedan", "SUV", "truck"] as const;

function buildGrid(): CatalogData {
  const institutions = [];
  for (let row = 0; row < ROWS; row++) {
    const branches: Branch[] = [];
    const lat = 25 + (row * 24) / (ROWS - 1);
    for (let col = 0; col < COLS; col++) {
      const lon = -125 + (col * 58) / (COLS - 1);
      branches.push({
        id: `br-${row}-${col}`,
        lat,
        lon,
        vehicles: new Set([VEHICLES[(row + col) % 3]]),
        priceCents: 20000 + 1000 * (col % 11),
      });
    }
    institutions.push({ id: `inst-row-${row}`, branches });
  }
  return { institutions };
}

function makeQueries(): { zips: ZipCenters; queries: Query[] } {
  let state = 0x9e3779b9;
  const next = (): number => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x80000000;
  };
  const zips: ZipCenters = {};
  const queries: Query[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < QUERIES; i++) {
    const lat = 25 + next() * 24;
    const lon = -125 + next() * 58;
    const zip = `zip-${i}`;
    seen.add(zip);
    zips[zip] = { lat, lon };
    const filtered = i % 2 === 0;
    queries.push({
      zip,
      radiusM: 10_000_000,
      k: 10,
      ...(filtered
        ? { vehicle: "sedan", priceMin: 22000, priceMax: 24000 }
        : {}),
    });
  }
  assert.strictEqual(seen.size, QUERIES);
  return { zips, queries };
}

test("160k-branch grid: 100 queries match brute force within examined budget", () => {
  const data = buildGrid();
  const { zips, queries } = makeQueries();
  const catalog = buildCatalog(data, zips);
  let filteredCount = 0;
  let maxExamined = 0;
  for (const query of queries) {
    if (query.vehicle !== undefined) {
      filteredCount++;
    }
    const actual = catalog.search(query);
    const expected = bruteForceSearch(data, zips, query);
    assertHitsEqual(actual.hits, expected, assert);
    assert.ok(
      actual.examined <= 2000,
      `examined ${actual.examined} exceeds 2000 for zip ${query.zip}`,
    );
    if (actual.examined > maxExamined) {
      maxExamined = actual.examined;
    }
  }
  assert.ok(
    filteredCount >= QUERIES / 2,
    `expected at least half filtered queries, got ${filteredCount}`,
  );
  assert.ok(maxExamined > 0);
});
