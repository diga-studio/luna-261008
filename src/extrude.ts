import { Mesh, Point2, Polygon } from "./mesh";
import { ensureWinding, sanitizeRing } from "./ring";
import { triangulate } from "./triangulate";

/**
 * Extrude a polygon-with-holes along +z into a closed triangle mesh.
 *
 * The bottom face lies at z = 0, the top face at z = height. Outer walls
 * face outward, hole walls face into the holes, and every undirected
 * index edge is shared by exactly two oppositely directed triangles.
 *
 * Units are feet, right-handed coordinates, height must be positive.
 */
export function extrude(polygon: Polygon, height: number): Mesh {
  if (!(height > 0)) {
    throw new Error("extrude: height must be a positive number");
  }

  const outer = ensureWinding(sanitizeRing(polygon.outer), true);
  if (outer.length < 3) {
    throw new Error("extrude: outer ring needs at least 3 distinct corners");
  }
  const holes = polygon.holes.map((hole) => {
    const cleaned = ensureWinding(sanitizeRing(hole), false);
    if (cleaned.length < 3) {
      throw new Error("extrude: hole ring needs at least 3 distinct corners");
    }
    return cleaned;
  });

  const { vertices: footprint, triangles: capTriangles } = triangulate(outer, holes);

  const n = footprint.length;
  const vertices = [] as Mesh["vertices"];
  for (const p of footprint) vertices.push([p[0], p[1], 0]);
  for (const p of footprint) vertices.push([p[0], p[1], height]);

  const triangles = [] as Mesh["triangles"];
  // Top cap (normal +z) and bottom cap (normal -z).
  for (const [a, b, c] of capTriangles) {
    triangles.push([a + n, b + n, c + n]);
    triangles.push([a, c, b]);
  }

  // Side walls for every ring boundary edge.
  const rings: Point2[][] = [outer, ...holes];
  let ringStart = 0;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      const b0 = ringStart + i;
      const b1 = ringStart + j;
      const t0 = b0 + n;
      const t1 = b1 + n;
      triangles.push([b0, b1, t1]);
      triangles.push([b0, t1, t0]);
    }
    ringStart += ring.length;
  }

  return { vertices, triangles };
}
