export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

/** A polygon with holes: outer ring first, then zero or more hole rings. */
export interface Polygon {
  outer: Vec2[];
  holes: Vec2[][];
}

/** A triangle mesh: vertex positions plus triples of vertex indices. */
export interface Mesh {
  positions: Vec3[];
  triangles: [number, number, number][];
}
