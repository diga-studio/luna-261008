import { toXYZ } from "./geo.js";
import type { BranchInput, InstitutionInput } from "./types.js";

/** 扁平化后的校区记录（内部表示）。 */
export interface BranchRec {
  institutionId: string;
  branchId: string;
  lat: number;
  lon: number;
  x: number;
  y: number;
  z: number;
  vehicles: ReadonlySet<string>;
  priceCents: number;
}

export interface KdNode {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  /** 叶子：branches 下标区间 [start, end)；内部节点 start === -1。 */
  start: number;
  end: number;
  /** 内部节点的子节点下标；叶子为 -1。 */
  left: number;
  right: number;
}

export interface KdTree {
  branches: BranchRec[];
  nodes: KdNode[];
  root: number;
}

const LEAF_SIZE = 8;

export function flattenBranches(
  data: readonly InstitutionInput[],
): BranchRec[] {
  const out: BranchRec[] = [];
  for (const inst of data) {
    for (const b of inst.branches) {
      const [x, y, z] = toXYZ(b.lat, b.lon);
      out.push({
        institutionId: inst.id,
        branchId: b.id,
        lat: b.lat,
        lon: b.lon,
        x,
        y,
        z,
        vehicles: new Set(b.vehicles),
        priceCents: b.priceCents,
      });
    }
  }
  return out;
}

function axisOf(rec: BranchRec, axis: 0 | 1 | 2): number {
  return axis === 0 ? rec.x : axis === 1 ? rec.y : rec.z;
}

/** 原地快速选择：使 branches[k] 为按 axis 排序后的第 k 个元素。 */
function quickselect(
  branches: BranchRec[],
  start: number,
  end: number,
  k: number,
  axis: 0 | 1 | 2,
): void {
  let lo = start;
  let hi = end - 1;
  while (lo < hi) {
    const pivot = axisOf(branches[(lo + hi) >> 1]!, axis);
    let i = lo;
    let j = hi;
    do {
      while (axisOf(branches[i]!, axis) < pivot) i++;
      while (axisOf(branches[j]!, axis) > pivot) j--;
      if (i <= j) {
        const tmp = branches[i]!;
        branches[i] = branches[j]!;
        branches[j] = tmp;
        i++;
        j--;
      }
    } while (i <= j);
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return;
  }
}

export function buildKdTree(branches: BranchRec[]): KdTree {
  const nodes: KdNode[] = [];

  function build(start: number, end: number): number {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = start; i < end; i++) {
      const b = branches[i]!;
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.z < minZ) minZ = b.z;
      if (b.x > maxX) maxX = b.x;
      if (b.y > maxY) maxY = b.y;
      if (b.z > maxZ) maxZ = b.z;
    }
    const index = nodes.length;
    if (end - start <= LEAF_SIZE) {
      nodes.push({ minX, minY, minZ, maxX, maxY, maxZ, start, end, left: -1, right: -1 });
      return index;
    }
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const spanZ = maxZ - minZ;
    const axis: 0 | 1 | 2 = spanX >= spanY && spanX >= spanZ ? 0 : spanY >= spanZ ? 1 : 2;
    const mid = (start + end) >> 1;
    quickselect(branches, start, end, mid, axis);
    nodes.push({ minX, minY, minZ, maxX, maxY, maxZ, start: -1, end: -1, left: -1, right: -1 });
    const left = build(start, mid);
    const right = build(mid, end);
    nodes[index]!.left = left;
    nodes[index]!.right = right;
    return index;
  }

  const root = branches.length > 0 ? build(0, branches.length) : -1;
  return { branches, nodes, root };
}
