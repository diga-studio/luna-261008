import { haversineM } from "./geo.js";
import { BranchIndex, type IndexedBranch } from "./kdtree.js";
import type {
  Catalog,
  CatalogData,
  Query,
  SearchHit,
  SearchResult,
  ZipCenters,
} from "./types.js";

interface Best {
  branchId: string;
  distanceM: number;
}

export function buildCatalog(
  data: CatalogData,
  zipCenters: ZipCenters,
): Catalog {
  const branches: IndexedBranch[] = [];
  for (const institution of data.institutions) {
    for (const branch of institution.branches) {
      branches.push({
        institutionId: institution.id,
        branchId: branch.id,
        lat: branch.lat,
        lon: branch.lon,
        vehicles: branch.vehicles,
        priceCents: branch.priceCents,
      });
    }
  }
  const index = new BranchIndex(branches);

  const search = (query: Query): SearchResult => {
    const center = zipCenters[query.zip];
    const k = query.k;
    const best = new Map<string, Best>();
    const dists: number[] = [];
    let examined = 0;

    const removeDistance = (value: number): void => {
      const i = dists.indexOf(value);
      if (i >= 0) {
        dists.splice(i, 1);
      }
    };
    const insertDistance = (value: number): void => {
      let lo = 0;
      let hi = dists.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (dists[mid] < value) lo = mid + 1;
        else hi = mid;
      }
      dists.splice(lo, 0, value);
    };

    const shouldContinue = (lowerBoundM: number): boolean => {
      if (dists.length < k) {
        return true;
      }
      return lowerBoundM <= dists[k - 1];
    };

    const visit = (branch: IndexedBranch): void => {
      examined++;
      if (query.vehicle !== undefined && !branch.vehicles.has(query.vehicle)) {
        return;
      }
      if (query.priceMin !== undefined && branch.priceCents < query.priceMin) {
        return;
      }
      if (query.priceMax !== undefined && branch.priceCents > query.priceMax) {
        return;
      }
      const distanceM = haversineM(
        center.lat,
        center.lon,
        branch.lat,
        branch.lon,
      );
      if (distanceM > query.radiusM) {
        return;
      }
      const current = best.get(branch.institutionId);
      if (
        current === undefined ||
        distanceM < current.distanceM ||
        (distanceM === current.distanceM && branch.branchId < current.branchId)
      ) {
        if (current !== undefined) {
          removeDistance(current.distanceM);
        }
        best.set(branch.institutionId, {
          branchId: branch.branchId,
          distanceM,
        });
        insertDistance(distanceM);
      }
    };

    index.visitByDistance(
      center.lat,
      center.lon,
      query.radiusM,
      shouldContinue,
      visit,
    );

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
    return { hits: hits.slice(0, k), examined };
  };

  return { search };
}
