import type { Fence, LatLng } from '../src/index.js';

export const R = 6371008.8;
const TO_RAD = Math.PI / 180;

/** 可复现的伪随机数发生器。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 沿球面大圆从起点按方位角（弧度）前进指定距离后的终点。 */
export function destinationPoint(start: LatLng, bearingRad: number, distanceM: number): LatLng {
  const d = distanceM / R;
  const lat1 = start.lat * TO_RAD;
  const lng1 = start.lng * TO_RAD;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(bearingRad),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearingRad) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  let lng = (lng2 / TO_RAD) % 360;
  if (lng > 180) lng -= 360;
  if (lng <= -180) lng += 360;
  return { lat: lat2 / TO_RAD, lng };
}

// ---------- 基准实现：按业务规则独立、直接地逐个判定 ----------

function normLng(lng: number): number {
  let v = lng % 360;
  if (v <= -180) v += 360;
  else if (v > 180) v -= 360;
  return v;
}

/** 基准：圆 = 球面最短距离不超过半径（含边界）。 */
export function refCircleContains(center: LatLng, radiusMeters: number, point: LatLng): boolean {
  const lat1 = center.lat * TO_RAD;
  const lat2 = point.lat * TO_RAD;
  const dLat = (point.lat - center.lat) * TO_RAD;
  const dLng = (point.lng - center.lng) * TO_RAD;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const dist = 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  return dist <= radiusMeters * (1 + 1e-9) + 1e-9;
}

/** 基准：点到展开平面线段的距离（度）。 */
function segDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
  }
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * 基准：多边形包含判定。
 * 内部用转角和（winding）法，边界用点到线段距离，与库实现路径不同。
 */
export function refPolygonContains(vertices: LatLng[], point: LatLng): boolean {
  // 展开顶点经度。
  const xs: number[] = [normLng(vertices[0]!.lng)];
  const ys: number[] = [vertices[0]!.lat];
  for (let i = 1; i < vertices.length; i++) {
    let lng = normLng(vertices[i]!.lng);
    while (lng - xs[i - 1]! > 180) lng -= 360;
    while (lng - xs[i - 1]! < -180) lng += 360;
    xs.push(lng);
    ys.push(vertices[i]!.lat);
  }
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const mid = (minX + maxX) / 2;
  let px = normLng(point.lng);
  while (px - mid > 180) px -= 360;
  while (px - mid < -180) px += 360;
  const py = point.lat;

  const n = xs.length;
  // 边界：点到任一线段距离足够小即命中。
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (segDist(px, py, xs[i]!, ys[i]!, xs[j]!, ys[j]!) <= 1e-9) return true;
  }
  // 内部：绕点转角和，|sum| ≈ 2π 为内部。
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = xs[i]! - px;
    const ay = ys[i]! - py;
    const bx = xs[j]! - px;
    const by = ys[j]! - py;
    sum += Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
  }
  return Math.abs(sum) > Math.PI;
}

/** 基准：逐个围栏判定，返回全部命中标识。 */
export function refQuery(fences: Fence[], point: LatLng): string[] {
  const hits: string[] = [];
  for (const f of fences) {
    const hit =
      f.kind === 'circle'
        ? refCircleContains(f.center, f.radiusMeters, point)
        : refPolygonContains(f.vertices, point);
    if (hit) hits.push(f.id);
  }
  return hits;
}
