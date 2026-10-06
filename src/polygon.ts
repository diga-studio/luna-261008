import { unwrapLonNear } from "./geo.js";
import type { GeoPoint, PolygonFence } from "./types.js";

export const POLYGON_MIN_VERTICES = 3;
export const POLYGON_MAX_VERTICES = 20;
export const POLYGON_MAX_ABS_LAT = 85;
/** 展开后的总经度跨度必须严格小于 180 度。 */
export const POLYGON_MAX_LON_SPAN = 180;

/** 度数下的浮点容差，约对应地面 0.1 毫米量级。 */
const EPS = 1e-9;

interface PlanarPoint {
  x: number;
  y: number;
}

/** 校验多边形围栏参数，非法时抛错。 */
export function validatePolygon(fence: PolygonFence): void {
  const n = fence.vertices.length;
  if (n < POLYGON_MIN_VERTICES || n > POLYGON_MAX_VERTICES) {
    throw new Error(`polygon ${fence.id}: vertex count out of range: ${n}`);
  }
  for (const v of fence.vertices) {
    if (!Number.isFinite(v.lat) || Math.abs(v.lat) > POLYGON_MAX_ABS_LAT) {
      throw new Error(`polygon ${fence.id}: vertex lat out of range: ${v.lat}`);
    }
    if (!Number.isFinite(v.lon) || v.lon < -180 || v.lon > 180) {
      throw new Error(`polygon ${fence.id}: vertex lon out of range: ${v.lon}`);
    }
  }
  const unwrapped = unwrapVertices(fence.vertices);
  let min = unwrapped[0]!.x;
  let max = unwrapped[0]!.x;
  for (const p of unwrapped) {
    if (p.x < min) min = p.x;
    if (p.x > max) max = p.x;
  }
  if (max - min >= POLYGON_MAX_LON_SPAN) {
    throw new Error(`polygon ${fence.id}: unwrapped lon span must be < 180, got ${max - min}`);
  }
}

/**
 * 将顶点经度沿较短方向连续展开为平面坐标（x 为展开经度，y 为纬度）。
 * 展开锚定第一个顶点，后续顶点相对前一个顶点展开。
 */
function unwrapVertices(vertices: GeoPoint[]): PlanarPoint[] {
  const result: PlanarPoint[] = [{ x: vertices[0]!.lon, y: vertices[0]!.lat }];
  for (let i = 1; i < vertices.length; i++) {
    result.push({
      x: unwrapLonNear(vertices[i]!.lon, result[i - 1]!.x),
      y: vertices[i]!.lat,
    });
  }
  return result;
}

/** 判断点是否落在多边形围栏内（含边界），边界为展开经纬度平面上的直线段。 */
export function polygonContains(fence: PolygonFence, point: GeoPoint): boolean {
  const poly = unwrapVertices(fence.vertices);
  let min = poly[0]!.x;
  let max = poly[0]!.x;
  for (const p of poly) {
    if (p.x < min) min = p.x;
    if (p.x > max) max = p.x;
  }
  // 将查询点经度展开到多边形所在经度区间附近；跨度 < 180 保证不会误判到另一侧。
  const q: PlanarPoint = { x: unwrapLonNear(point.lon, (min + max) / 2), y: point.lat };

  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j]!;
    const b = poly[i]!;
    if (onSegment(a, b, q)) return true;
    // 射线法：统计向 +x 方向射线与边的交叉次数。
    if (a.y > q.y !== b.y > q.y) {
      const xCross = a.x + ((q.y - a.y) / (b.y - a.y)) * (b.x - a.x);
      if (xCross > q.x) inside = !inside;
    }
  }
  return inside;
}

/** 判断 q 是否落在线段 ab 上（含端点），带浮点容差。 */
function onSegment(a: PlanarPoint, b: PlanarPoint, q: PlanarPoint): boolean {
  const cross = (b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x);
  const scale = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), 1);
  if (Math.abs(cross) > EPS * scale * scale) return false;
  const dot = (q.x - a.x) * (b.x - a.x) + (q.y - a.y) * (b.y - a.y);
  if (dot < -EPS * scale * scale) return false;
  const lenSq = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  if (dot - lenSq > EPS * scale * scale) return false;
  return true;
}
