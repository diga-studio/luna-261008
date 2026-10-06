import { haversineM } from "../src/geo.js";
import type {
  CatalogData,
  Query,
  SearchHit,
  ZipCenters,
} from "../src/types.js";

export function bruteForceSearch(
  data: CatalogData,
  zipCenters: ZipCenters,
  query: Query,
): SearchHit[] {
  const center = zipCenters[query.zip];
  const best = new Map<string, { branchId: string; distanceM: number }>();
  for (const institution of data.institutions) {
    for (const branch of institution.branches) {
      if (query.vehicle !== undefined && !branch.vehicles.has(query.vehicle)) {
        continue;
      }
      if (query.priceMin !== undefined && branch.priceCents < query.priceMin) {
        continue;
      }
      if (query.priceMax !== undefined && branch.priceCents > query.priceMax) {
        continue;
      }
      const distanceM = haversineM(
        center.lat,
        center.lon,
        branch.lat,
        branch.lon,
      );
      if (distanceM > query.radiusM) {
        continue;
      }
      const current = best.get(institution.id);
      if (
        current === undefined ||
        distanceM < current.distanceM ||
        (distanceM === current.distanceM && branch.id < current.branchId)
      ) {
        best.set(institution.id, { branchId: branch.id, distanceM });
      }
    }
  }
  const hits: SearchHit[] = [];
  for (const [institutionId, entry] of best) {
    hits.push({
      institutionId,
      branchId: entry.branchId,
      distanceM: entry.distanceM,
    });
  }
  hits.sort((a, b) =>
    a.distanceM === b.distanceM
      ? a.institutionId < b.institutionId
        ? -1
        : 1
      : a.distanceM - b.distanceM,
  );
  return hits.slice(0, query.k);
}

export function assertHitsEqual(
  actual: SearchHit[],
  expected: SearchHit[],
  assert: {
    strictEqual(a: unknown, b: unknown, msg?: string): void;
    ok(a: unknown, msg?: string): void;
  },
): void {
  assert.strictEqual(
    actual.length,
    expected.length,
    `hit count ${actual.length} != ${expected.length}`,
  );
  for (let i = 0; i < expected.length; i++) {
    assert.strictEqual(
      actual[i].institutionId,
      expected[i].institutionId,
      `hit[${i}].institutionId`,
    );
    assert.strictEqual(
      actual[i].branchId,
      expected[i].branchId,
      `hit[${i}].branchId`,
    );
    assert.ok(
      Math.abs(actual[i].distanceM - expected[i].distanceM) <= 0.001,
      `hit[${i}].distanceM ${actual[i].distanceM} vs ${expected[i].distanceM}`,
    );
  }
}
