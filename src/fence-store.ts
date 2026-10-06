import { circleContains, normalizeLng, polygonContains } from './geo.js';
import type { CircleFence, Fence, LatLng, PolygonFence } from './types.js';

const MIN_RADIUS_METERS = 50;
const MAX_RADIUS_METERS = 5000;
const MIN_POLYGON_VERTICES = 3;
const MAX_POLYGON_VERTICES = 20;
const MAX_POLYGON_LAT = 85;
const MAX_POLYGON_LNG_SPAN = 180;

function assertFinite(value: number, what: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${what} 必须是有限数值，收到 ${value}`);
  }
}

function validateCircle(fence: CircleFence): void {
  const { lat, lng } = fence.center;
  assertFinite(lat, `围栏 ${fence.id} 中心纬度`);
  assertFinite(lng, `围栏 ${fence.id} 中心经度`);
  if (lat < -90 || lat > 90) {
    throw new RangeError(`围栏 ${fence.id} 中心纬度超出 [-90, 90]：${lat}`);
  }
  assertFinite(fence.radiusMeters, `围栏 ${fence.id} 半径`);
  if (fence.radiusMeters < MIN_RADIUS_METERS || fence.radiusMeters > MAX_RADIUS_METERS) {
    throw new RangeError(
      `围栏 ${fence.id} 半径需在 ${MIN_RADIUS_METERS}~${MAX_RADIUS_METERS} 米内：${fence.radiusMeters}`,
    );
  }
}

function validatePolygon(fence: PolygonFence): void {
  const count = fence.vertices.length;
  if (count < MIN_POLYGON_VERTICES || count > MAX_POLYGON_VERTICES) {
    throw new RangeError(`围栏 ${fence.id} 顶点数需在 ${MIN_POLYGON_VERTICES}~${MAX_POLYGON_VERTICES} 内：${count}`);
  }
  const lngs: number[] = [];
  for (const v of fence.vertices) {
    assertFinite(v.lat, `围栏 ${fence.id} 顶点纬度`);
    assertFinite(v.lng, `围栏 ${fence.id} 顶点经度`);
    if (v.lat < -MAX_POLYGON_LAT || v.lat > MAX_POLYGON_LAT) {
      throw new RangeError(`围栏 ${fence.id} 顶点纬度超出 ±${MAX_POLYGON_LAT}：${v.lat}`);
    }
    lngs.push(normalizeLng(v.lng));
  }
  // 按较短方向展开相邻顶点经度，校验总跨度严格小于 180。
  const unwrapped = [lngs[0]!];
  for (let i = 1; i < lngs.length; i++) {
    let lng = lngs[i]!;
    const prev = unwrapped[i - 1]!;
    while (lng - prev > 180) lng -= 360;
    while (lng - prev < -180) lng += 360;
    unwrapped.push(lng);
  }
  const span = Math.max(...unwrapped) - Math.min(...unwrapped);
  if (span >= MAX_POLYGON_LNG_SPAN) {
    throw new RangeError(`围栏 ${fence.id} 展开后经度跨度需严格小于 ${MAX_POLYGON_LNG_SPAN}：${span}`);
  }
}

function validateFence(fence: Fence): void {
  if (typeof fence.id !== 'string' || fence.id.length === 0) {
    throw new TypeError('围栏标识必须是非空字符串');
  }
  if (fence.kind === 'circle') validateCircle(fence);
  else if (fence.kind === 'polygon') validatePolygon(fence);
  else throw new TypeError(`未知围栏类型：${String((fence as Fence).kind)}`);
}

function fenceContains(fence: Fence, point: LatLng): boolean {
  return fence.kind === 'circle'
    ? circleContains(fence.center, fence.radiusMeters, point)
    : polygonContains(fence.vertices, point);
}

/** 内存围栏集合：整体装载、按标识替换/删除、命中查询。 */
export class FenceStore {
  private fences = new Map<string, Fence>();

  /** 整体装载一份围栏集合，替换掉现有全部数据；标识在集合内必须唯一。 */
  loadAll(fences: Fence[]): void {
    const next = new Map<string, Fence>();
    for (const fence of fences) {
      validateFence(fence);
      if (next.has(fence.id)) {
        throw new Error(`围栏标识重复：${fence.id}`);
      }
      next.set(fence.id, fence);
    }
    this.fences = next;
  }

  /** 按标识替换（或新增）一个围栏，形状和位置都可以改变。 */
  replace(fence: Fence): void {
    validateFence(fence);
    this.fences.set(fence.id, fence);
  }

  /** 删除一个围栏，返回是否存在。 */
  remove(id: string): boolean {
    return this.fences.delete(id);
  }

  /** 返回命中该坐标的全部围栏标识（完整、无重复）。 */
  query(point: LatLng): string[] {
    assertFinite(point.lat, '查询点纬度');
    assertFinite(point.lng, '查询点经度');
    if (point.lat < -90 || point.lat > 90) {
      throw new RangeError(`查询点纬度超出 [-90, 90]：${point.lat}`);
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
