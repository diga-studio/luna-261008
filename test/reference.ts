import { haversineM } from "../src/geo.js";
import type {
  InstitutionInput,
  SearchHit,
  SearchResult,
  SearchQuery,
  ZipCenters,
} from "../src/types.js";

/**
 * 独立穷举参考实现：逐校区评估、按驾校去重、排序取前 k。
 * examined 为全部校区数（穷举评估了每一个校区）。
 */
export function referenceSearch(
  data: readonly InstitutionInput[],
  zipCenters: ZipCenters,
  query: SearchQuery,
): SearchResult {
  const center = zipCenters[query.zip];
  if (center === undefined) {
    throw new Error(`unknown zip: ${query.zip}`);
  }
  let examined = 0;
  const best = new Map<string, { distanceM: number; branchId: string }>();
  for (const inst of data) {
    for (const b of inst.branches) {
      examined++;
      if (query.vehicle !== undefined && !b.vehicles.includes(query.vehicle)) {
        continue;
      }
      if (query.priceMin !== undefined && b.priceCents < query.priceMin) {
        continue;
      }
      if (query.priceMax !== undefined && b.priceCents > query.priceMax) {
        continue;
      }
      const distanceM = haversineM(center.lat, center.lon, b.lat, b.lon);
      if (distanceM > query.radiusM) continue;
      const prev = best.get(inst.id);
      if (
        prev === undefined ||
        distanceM < prev.distanceM ||
        (distanceM === prev.distanceM && b.id < prev.branchId)
      ) {
        best.set(inst.id, { distanceM, branchId: b.id });
      }
    }
  }
  const results: SearchHit[] = [...best.entries()]
    .map(([institutionId, v]) => ({
      institutionId,
      branchId: v.branchId,
      distanceM: v.distanceM,
    }))
    .sort((a, b) =>
      a.distanceM !== b.distanceM
        ? a.distanceM - b.distanceM
        : a.institutionId < b.institutionId
          ? -1
          : a.institutionId > b.institutionId
            ? 1
            : 0,
    )
    .slice(0, Math.max(0, query.k));
  return { results, examined };
}
