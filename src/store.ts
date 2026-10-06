import { circleContains, validateCircle } from "./circle.js";
import { polygonContains, validatePolygon } from "./polygon.js";
import type { Fence, GeoPoint } from "./types.js";

function validateFence(fence: Fence): void {
  if (typeof fence.id !== "string" || fence.id.length === 0) {
    throw new Error("fence id must be a non-empty string");
  }
  if (fence.kind === "circle") validateCircle(fence);
  else if (fence.kind === "polygon") validatePolygon(fence);
  else throw new Error(`unknown fence kind: ${String((fence as Fence).kind)}`);
}

function fenceContains(fence: Fence, point: GeoPoint): boolean {
  return fence.kind === "circle"
    ? circleContains(fence, point)
    : polygonContains(fence, point);
}

/** 内存围栏集合：整体装载、按标识替换、删除、命中查询。 */
export class FenceStore {
  private fences = new Map<string, Fence>();

  /** 整体装载一份围栏集合，替换掉现有全部数据。标识必须唯一。 */
  loadAll(fences: Fence[]): void {
    const next = new Map<string, Fence>();
    for (const fence of fences) {
      validateFence(fence);
      if (next.has(fence.id)) {
        throw new Error(`duplicate fence id: ${fence.id}`);
      }
      next.set(fence.id, fence);
    }
    this.fences = next;
  }

  /** 按标识替换（或新增）一个围栏，形状和位置可以改变。 */
  replace(fence: Fence): void {
    validateFence(fence);
    this.fences.set(fence.id, fence);
  }

  /** 删除一个围栏，返回是否存在并被删除。 */
  remove(id: string): boolean {
    return this.fences.delete(id);
  }

  /** 查询坐标命中的全部围栏标识，完整且无重复。 */
  query(point: GeoPoint): string[] {
    if (!Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90) {
      throw new Error(`query lat out of range: ${point.lat}`);
    }
    if (!Number.isFinite(point.lon) || point.lon < -180 || point.lon > 180) {
      throw new Error(`query lon out of range: ${point.lon}`);
    }
    const hits: string[] = [];
    for (const fence of this.fences.values()) {
      if (fenceContains(fence, point)) hits.push(fence.id);
    }
    return hits;
  }

  /** 当前围栏数量。 */
  get size(): number {
    return this.fences.size;
  }
}
