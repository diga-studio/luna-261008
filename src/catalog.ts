import { arcLowerBoundToBoxM, haversineM, toXYZ } from "./geo.js";
import { buildKdTree, flattenBranches } from "./kdtree.js";
import type { KdTree } from "./kdtree.js";
import type {
  InstitutionInput,
  SearchHit,
  SearchResult,
  SearchQuery,
  ZipCenter,
  ZipCenters,
} from "./types.js";

export interface Catalog {
  search(query: SearchQuery): SearchResult;
}

interface Best {
  distanceM: number;
  branchId: string;
}

/** 节点下界的最小堆。 */
class NodeHeap {
  private lbs: number[] = [];
  private idxs: number[] = [];

  get size(): number {
    return this.lbs.length;
  }

  push(lb: number, idx: number): void {
    this.lbs.push(lb);
    this.idxs.push(idx);
    let i = this.lbs.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.lbs[parent]! <= this.lbs[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.idxs[0]!;
    const lastLb = this.lbs.pop()!;
    const lastIdx = this.idxs.pop()!;
    if (this.lbs.length > 0) {
      this.lbs[0] = lastLb;
      this.idxs[0] = lastIdx;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.lbs.length && this.lbs[l]! < this.lbs[smallest]!) smallest = l;
        if (r < this.lbs.length && this.lbs[r]! < this.lbs[smallest]!) smallest = r;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  peekLb(): number {
    return this.lbs[0]!;
  }

  private swap(a: number, b: number): void {
    const tl = this.lbs[a]!;
    this.lbs[a] = this.lbs[b]!;
    this.lbs[b] = tl;
    const ti = this.idxs[a]!;
    this.idxs[a] = this.idxs[b]!;
    this.idxs[b] = ti;
  }
}

/** 第 k 小（0 起第 k-1 个）距离，用于收紧剪枝阈值。 */
function kthSmallest(values: number[], k: number): number {
  const arr = values.slice();
  let lo = 0;
  let hi = arr.length - 1;
  const target = k - 1;
  while (lo < hi) {
    const pivot = arr[(lo + hi) >> 1]!;
    let i = lo;
    let j = hi;
    do {
      while (arr[i]! < pivot) i++;
      while (arr[j]! > pivot) j--;
      if (i <= j) {
        const t = arr[i]!;
        arr[i] = arr[j]!;
        arr[j] = t;
        i++;
        j--;
      }
    } while (i <= j);
    if (target <= j) hi = j;
    else if (target >= i) lo = i;
    else break;
  }
  return arr[target]!;
}

export function buildCatalog(
  data: readonly InstitutionInput[],
  zipCenters: ZipCenters,
): Catalog {
  const tree: KdTree = buildKdTree(flattenBranches(data));
  const zips = new Map<string, ZipCenter>();
  for (const [zip, center] of Object.entries(zipCenters)) {
    zips.set(zip, { lat: center.lat, lon: center.lon });
  }

  function search(query: SearchQuery): SearchResult {
    if (query.k <= 0 || tree.root < 0) {
      return { results: [], examined: 0 };
    }
    const center = zips.get(query.zip);
    if (center === undefined) {
      throw new Error(`unknown zip: ${query.zip}`);
    }
    const [qx, qy, qz] = toXYZ(center.lat, center.lon);
    const { vehicle, priceMin, priceMax, radiusM, k } = query;

    let examined = 0;
    let threshold = radiusM;
    const best = new Map<string, Best>();
    const heap = new NodeHeap();
    heap.push(0, tree.root);

    while (heap.size > 0) {
      if (heap.peekLb() > threshold) break;
      const nodeIdx = heap.pop();
      const node = tree.nodes[nodeIdx]!;
      if (node.start >= 0) {
        for (let i = node.start; i < node.end; i++) {
          const b = tree.branches[i]!;
          examined++;
          if (vehicle !== undefined && !b.vehicles.has(vehicle)) continue;
          if (priceMin !== undefined && b.priceCents < priceMin) continue;
          if (priceMax !== undefined && b.priceCents > priceMax) continue;
          const dist = haversineM(center.lat, center.lon, b.lat, b.lon);
          if (dist > threshold) continue;
          const prev = best.get(b.institutionId);
          if (
            prev === undefined ||
            dist < prev.distanceM ||
            (dist === prev.distanceM && b.branchId < prev.branchId)
          ) {
            best.set(b.institutionId, { distanceM: dist, branchId: b.branchId });
            if (best.size >= k) {
              const distances = [...best.values()].map((v) => v.distanceM);
              const kth = kthSmallest(distances, k);
              threshold = Math.min(radiusM, kth);
            }
          }
        }
      } else {
        const left = tree.nodes[node.left]!;
        const leftLb = arcLowerBoundToBoxM(
          qx, qy, qz,
          left.minX, left.minY, left.minZ,
          left.maxX, left.maxY, left.maxZ,
        );
        if (leftLb <= threshold) heap.push(leftLb, node.left);
        const right = tree.nodes[node.right]!;
        const rightLb = arcLowerBoundToBoxM(
          qx, qy, qz,
          right.minX, right.minY, right.minZ,
          right.maxX, right.maxY, right.maxZ,
        );
        if (rightLb <= threshold) heap.push(rightLb, node.right);
      }
    }

    const hits: SearchHit[] = [...best.entries()]
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
      .slice(0, k);
    return { results: hits, examined };
  }

  return { search };
}
