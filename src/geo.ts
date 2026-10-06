export const EARTH_RADIUS_M = 6371008.8;

const DEG_TO_RAD = Math.PI / 180;

/** 球面最短弧长（米），haversine 公式，自动处理跨 180 度经线。 */
export function haversineM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const phi1 = lat1 * DEG_TO_RAD;
  const phi2 = lat2 * DEG_TO_RAD;
  const dPhi = (lat2 - lat1) * DEG_TO_RAD;
  const dLambda = (lon2 - lon1) * DEG_TO_RAD;
  const sinHalfPhi = Math.sin(dPhi / 2);
  const sinHalfLambda = Math.sin(dLambda / 2);
  const a =
    sinHalfPhi * sinHalfPhi +
    Math.cos(phi1) * Math.cos(phi2) * sinHalfLambda * sinHalfLambda;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** 经纬度转单位球面三维坐标 [x, y, z]。 */
export function toXYZ(lat: number, lon: number): [number, number, number] {
  const phi = lat * DEG_TO_RAD;
  const lambda = lon * DEG_TO_RAD;
  const cosPhi = Math.cos(phi);
  return [
    cosPhi * Math.cos(lambda),
    cosPhi * Math.sin(lambda),
    Math.sin(phi),
  ];
}

/**
 * 查询点到三维轴对齐包围盒的最短弧长下界（米）。
 * 弦长 <= 弧长，包围盒包含球面区域，因此这是安全的剪枝下界。
 */
export function arcLowerBoundToBoxM(
  x: number,
  y: number,
  z: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): number {
  const dx = x < minX ? minX - x : x > maxX ? x - maxX : 0;
  const dy = y < minY ? minY - y : y > maxY ? y - maxY : 0;
  const dz = z < minZ ? minZ - z : z > maxZ ? z - maxZ : 0;
  const chord = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, chord / 2));
}
