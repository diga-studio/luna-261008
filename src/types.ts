/** 地理坐标点，经度范围 [-180, 180]，180 与 -180 表示同一条经线。 */
export interface GeoPoint {
  lat: number;
  lon: number;
}

/** 圆形围栏：中心 + 半径（米），半径范围 [50, 5000]。 */
export interface CircleFence {
  kind: "circle";
  id: string;
  center: GeoPoint;
  radiusMeters: number;
}

/** 多边形围栏：3 至 20 个顶点，无自交无孔，允许凹多边形。 */
export interface PolygonFence {
  kind: "polygon";
  id: string;
  vertices: GeoPoint[];
}

export type Fence = CircleFence | PolygonFence;
