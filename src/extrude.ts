import { Mesh, Polygon } from "./types";
import { preparePolygon } from "./triangulate";

/**
 * Extrude a polygon-with-holes along +Z into a closed, outward-oriented
 * triangle mesh. Bottom cap at z=0, top cap at z=height.
 */
export function extrude(polygon: Polygon, height: number): Mesh {
  if (!(height > 0)) {
    throw new Error("height must be positive");
  }
  const prepared = preparePolygon(polygon.outer, polygon.holes);
  const { points, rings, triangles } = prepared;
  const n = points.length;

  const positions: Mesh["positions"] = [];
  for (const [x, y] of points) positions.push([x, y, 0]);
  for (const [x, y] of points) positions.push([x, y, height]);

  const tris: Mesh["triangles"] = [];
  // Bottom cap faces -Z, top cap faces +Z.
  for (const [a, b, c] of triangles) {
    tris.push([a, c, b]);
    tris.push([n + a, n + b, n + c]);
  }
  // Side walls: outer ring is CCW, hole rings are CW, so the region
  // interior is always left of each directed edge and the wall normal
  // produced here points away from the interior (into the hole void for
  // hole rings).
  for (const ring of rings) {
    for (let i = 0; i < ring.count; i++) {
      const a = ring.start + i;
      const b = ring.start + ((i + 1) % ring.count);
      tris.push([a, b, n + b]);
      tris.push([a, n + b, n + a]);
    }
  }
  return { positions, triangles: tris };
}

/**
 * Signed volume of a triangle mesh via the divergence theorem.
 * Positive for a closed, outward-oriented mesh; flips sign if every
 * triangle is reversed.
 */
export function signedVolume(mesh: Mesh): number {
  let sum = 0;
  for (const [ia, ib, ic] of mesh.triangles) {
    const a = mesh.positions[ia]!;
    const b = mesh.positions[ib]!;
    const c = mesh.positions[ic]!;
    sum +=
      a[0] * (b[1] * c[2] - b[2] * c[1]) +
      a[1] * (b[2] * c[0] - b[0] * c[2]) +
      a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return sum / 6;
}
