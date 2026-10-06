import { sphericalDistanceMeters } from "./geo.js";
import type { CircleFence, GeoPoint } from "./types.js";

export const CIRCLE_MIN_RADIUS_METERS = 50;
export const CIRCLE_MAX_RADIUS_METERS = 5000;

/** 校验圆形围栏参数，非法时抛错。 */
export function validateCircle(fence: CircleFence): void {
  const { lat, lon } = fence.center;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new Error(`circle ${fence.id}: center lat out of range: ${lat}`);
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new Error(`circle ${fence.id}: center lon out of range: ${lon}`);
  }
  if (
    !Number.isFinite(fence.radiusMeters) ||
    fence.radiusMeters < CIRCLE_MIN_RADIUS_METERS ||
    fence.radiusMeters > CIRCLE_MAX_RADIUS_METERS
  ) {
    throw new Error(`circle ${fence.id}: radius out of range: ${fence.radiusMeters}`);
  }
}

/**
 * 判断点是否落在圆形围栏内（含边界），按球面最短距离。
 * 球面距离天然支持跨 180 度经线与覆盖极点的圆。
 */
export function circleContains(fence: CircleFence, point: GeoPoint): boolean {
  return sphericalDistanceMeters(fence.center, point) <= fence.radiusMeters;
}
