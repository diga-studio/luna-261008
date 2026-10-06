import type { LatLng } from './types.js';

/** 地球平均半径（米）。 */
export const EARTH_RADIUS_METERS = 6371008.8;

const TO_RAD = Math.PI / 180;

/** 距离比较的相对容差，用于把边界点计入围栏。 */
const DIST_REL_EPS = 1e-9;
/** 平面（度）包含判定的绝对容差，约 0.0001 毫米量级。 */
const DEG_EPS = 1e-9;

/** 把经度规范化到 (-180, 180]。 */
export function normalizeLng(lng: number): number {
  let result = lng % 360;
  if (result <= -180) result += 360;
  else if (result > 180) result -= 360;
  return result;
}

/** 球面最短距离（米），haversine 公式，天然处理跨 180 经线与极点。 */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * TO_RAD;
  const dLng = (b.lng - a.lng) * TO_RAD;
  const lat1 = a.lat * TO_RAD;
  const lat2 = b.lat * TO_RAD;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 圆形围栏包含判定（含边界），允许圆覆盖极点。 */
export function circleContains(center: LatLng, radiusMeters: number, point: LatLng): boolean {
  const distance = haversineMeters(center, point);
  return distance <= radiusMeters * (1 + DIST_REL_EPS) + DIST_REL_EPS;
}

/**
 * 把多边形顶点经度按较短方向连续展开。
 * 输入保证相邻顶点经度差取较短方向，展开后总跨度 < 180。
 */
function unwrapVertices(vertices: LatLng[]): { xs: number[]; ys: number[] } {
  const xs: number[] = [normalizeLng(vertices[0]!.lng)];
  const ys: number[] = [vertices[0]!.lat];
  for (let i = 1; i < vertices.length; i++) {
    let lng = normalizeLng(vertices[i]!.lng);
    const prev = xs[i - 1]!;
    while (lng - prev > 180) lng -= 360;
    while (lng - prev < -180) lng += 360;
    xs.push(lng);
    ys.push(vertices[i]!.lat);
  }
  return { xs, ys };
}

/** 点是否落在展开平面的一条线段上（度坐标，含端点）。 */
function onSegment(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number,
): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const cross = (px - x1) * dy - (py - y1) * dx;
  const len = Math.hypot(dx, dy);
  if (len === 0) {
    return Math.hypot(px - x1, py - y1) <= DEG_EPS;
  }
  if (Math.abs(cross) / len > DEG_EPS) return false;
  const dot = (px - x1) * dx + (py - y1) * dy;
  return dot >= -DEG_EPS * len && dot <= len * len + DEG_EPS * len;
}

/**
 * 多边形围栏包含判定（含边界）。
 * 边界是展开后的经纬度平面直线段；跨 180 经线的多边形覆盖短跨度区域。
 */
export function polygonContains(vertices: LatLng[], point: LatLng): boolean {
  const { xs, ys } = unwrapVertices(vertices);
  const n = xs.length;

  let minX = Infinity;
  let maxX = -Infinity;
  for (const x of xs) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }

  // 把查询点经度展开到多边形所在的经度窗口内。
  const centerX = (minX + maxX) / 2;
  let px = normalizeLng(point.lng);
  while (px - centerX > 180) px -= 360;
  while (px - centerX < -180) px += 360;
  const py = point.lat;

  // 边界（含顶点）计入围栏。
  for (let i = 0, j = n - 1; i < n; j = i++) {
    if (onSegment(px, py, xs[j]!, ys[j]!, xs[i]!, ys[i]!)) return true;
  }

  // 奇偶射线法：向 +x 方向投射。
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = ys[i]!;
    const yj = ys[j]!;
    if (yi > py !== yj > py) {
      const xInt = xs[j]! + ((py - yj) / (yi - yj)) * (xs[i]! - xs[j]!);
      if (xInt > px) inside = !inside;
    }
  }
  return inside;
}
