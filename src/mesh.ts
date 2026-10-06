/** 2D point in feet, [x, y]. */
export type Point2 = [number, number];

/** 3D point in feet, [x, y, z]. */
export type Point3 = [number, number, number];

/**
 * Building footprint: an outer ring plus zero or more hole rings.
 * Rings are lists of 2D points; winding direction and start point are
 * arbitrary, and rings may contain consecutive duplicate points, a
 * duplicated closing point, and consecutive collinear points.
 */
export interface Polygon {
  outer: Point2[];
  holes: Point2[][];
}

/**
 * Closed triangle mesh: vertex positions plus triangle index triples.
 * Outward-oriented closed meshes have positive signed volume.
 */
export interface Mesh {
  vertices: Point3[];
  triangles: [number, number, number][];
}
