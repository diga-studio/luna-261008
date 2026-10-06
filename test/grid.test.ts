import assert from "node:assert/strict";
import test from "node:test";
import { buildCatalog } from "../src/catalog.js";
import type {
  InstitutionInput,
  SearchQuery,
  ZipCenters,
} from "../src/types.js";
import { referenceSearch } from "./reference.js";

const ROWS = 400;
const COLS = 400;
const VEHICLES = ["sedan", "SUV", "truck"] as const;

function gridData(): InstitutionInput[] {
  const data: InstitutionInput[] = [];
  for (let row = 0; row < ROWS; row++) {
    const lat = 25 + (row * (49 - 25)) / (ROWS - 1);
    const branches = [];
    for (let col = 0; col < COLS; col++) {
      const lon = -125 + (col * (58)) / (COLS - 1);
      branches.push({
        id: `b_${row}_${col}`,
        lat,
        lon,
        vehicles: [VEHICLES[(row + col) % 3]!],
        priceCents: 20000 + 1000 * (col % 11),
      });
    }
    data.push({ id: `inst_${row}`, branches });
  }
  return data;
}

class Lcg {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state * 1664525 + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }
}

test("160000 校区网格：100 次查询与穷举一致且 examined <= 2000", { timeout: 120000 }, () => {
  const data = gridData();
  const rng = new Lcg(20261006);
  const zips: Record<string, { lat: number; lon: number }> = {};
  const centers = new Set<string>();
  for (let i = 0; i < 100; i++) {
    let lat: number;
    let lon: number;
    do {
      lat = 25 + rng.next() * 24;
      lon = -125 + rng.next() * 58;
    } while (centers.has(`${lat},${lon}`));
    centers.add(`${lat},${lon}`);
    zips[`q${i}`] = { lat, lon };
  }
  const zipCenters: ZipCenters = zips;
  const catalog = buildCatalog(data, zipCenters);

  let filtered = 0;
  let maxExamined = 0;
  for (let i = 0; i < 100; i++) {
    const q: SearchQuery = {
      zip: `q${i}`,
      radiusM: 10000000,
      k: 10,
    };
    // 至少一半查询限定 sedan 且价格 22000..24000
    if (i % 2 === 0) {
      q.vehicle = "sedan";
      q.priceMin = 22000;
      q.priceMax = 24000;
      filtered++;
    }
    const actual = catalog.search(q);
    const expected = referenceSearch(data, zipCenters, q);
    assert.deepEqual(
      actual.results,
      expected.results,
      `query ${i} mismatch: ${JSON.stringify(q)}`,
    );
    assert.ok(
      actual.examined <= 2000,
      `query ${i} examined=${actual.examined} exceeds 2000`,
    );
    maxExamined = Math.max(maxExamined, actual.examined);
  }
  assert.ok(filtered >= 50, `filtered queries: ${filtered}`);
  console.log(`grid test: max examined = ${maxExamined}`);
});
