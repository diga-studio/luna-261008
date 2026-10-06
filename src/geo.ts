import type { GeoPoint } from "./types.js";

/** 球面半径（米），按业务规定取值。 */
export const EARTH_RADIUS_METERS = 6371008.8;

const DEG_TO_RAD = Math.PI / 180;

/** 球面最短距离（haversine），单位米。 */
export function sphericalDistanceMeters(a: GeoPoint, b: GeoPoint): number {
  const lat1 = a.lat * DEG_TO_RAD;
  const lat2 = b.lat * DEG_TO_RAD;
  const dLat = (b.lat - a.lat) * DEG_TO_RAD;
  // 经度差取较短方向，180 与 -180 视为同一经线。
  const lonDiff = normalizeLon(b.lon - a.lon) * DEG_TO_RAD;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(lonDiff / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 将经度归一化到 (-180, 180]。 */
export function normalizeLon(lon: number): number {
  let result = lon % 360;
  if (result <= -180) result += 360;
  else if (result > 180) result -= 360;
  return result;
}

/**
 * 将 target 经度展开到 reference 附近，使两者差值落在 (-180, 180]，
 * 即沿较短方向连续展开。
 */
export function unwrapLonNear(target: number, reference: number): number {
  return reference + normalizeLon(target - reference);
}
