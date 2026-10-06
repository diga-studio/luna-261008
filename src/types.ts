/** 地理坐标，纬度 [-90, 90]，经度 [-180, 180]。 */
export interface LatLng {
  lat: number;
  lng: number;
}

/** 圆形围栏：中心 + 半径（米）。 */
export interface CircleFence {
  kind: 'circle';
  id: string;
  center: LatLng;
  radiusMeters: number;
}

/** 多边形围栏：3~20 个顶点，边界为经纬度平面直线段。 */
export interface PolygonFence {
  kind: 'polygon';
  id: string;
  vertices: LatLng[];
}

export type Fence = CircleFence | PolygonFence;
