import { Point2 } from "./mesh";

function cross(o: Point2, a: Point2, b: Point2): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function samePoint(a: Point2, b: Point2): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** Strictly inside or on the boundary of triangle (a, b, c). */
function pointInTriangle(p: Point2, a: Point2, b: Point2, c: Point2): boolean {
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/** Proper intersection: segments cross in their interiors (endpoint touches ignored). */
function segmentsCross(p1: Point2, p2: Point2, q1: Point2, q2: Point2): boolean {
  const d1 = cross(q1, q2, p1);
  const d2 = cross(q1, q2, p2);
  const d3 = cross(p1, p2, q1);
  const d4 = cross(p1, p2, q2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function dist2(a: Point2, b: Point2): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

/** True if p lies strictly between a and b on the segment ab. */
function strictlyOnSegment(p: Point2, a: Point2, b: Point2): boolean {
  if (cross(a, b, p) !== 0) return false;
  return (p[0] - a[0]) * (p[0] - b[0]) + (p[1] - a[1]) * (p[1] - b[1]) < 0;
}

interface Ring {
  /** Indices into the shared vertex array. */
  indices: number[];
}

/**
 * Bridge every hole into the outer ring, producing one simple polygon
 * (a list of vertex indices, CCW) whose edges never cross.
 */
function bridgeHoles(vertices: Point2[], outer: Ring, holes: Ring[]): number[] {
  const polygon = outer.indices.slice();
  const remaining = holes.map((h) => h.indices.slice());

  while (remaining.length > 0) {
    // Process the hole whose rightmost vertex is largest in x first.
    let bestHole = 0;
    let bestM = 0;
    let bestKey = -Infinity;
    for (let h = 0; h < remaining.length; h++) {
      const idxs = remaining[h]!;
      for (let i = 0; i < idxs.length; i++) {
        const v = vertices[idxs[i]!]!;
        if (v[0] > bestKey) {
          bestKey = v[0];
          bestHole = h;
          bestM = i;
        }
      }
    }
    const holeIdxs = remaining.splice(bestHole, 1)[0]!;
    const mIdx = holeIdxs[bestM]!;
    const m = vertices[mIdx]!;

    // Visibility candidate: nearest vertex of the current merged polygon
    // whose connecting segment crosses nothing.
    const blockedBy: number[][] = [polygon, holeIdxs, ...remaining];
    let bridgeTo = -1;
    let bridgeDist = Infinity;
    for (const vi of polygon) {
      const v = vertices[vi]!;
      const d = dist2(m, v);
      if (d >= bridgeDist) continue;
      let visible = true;
      // The bridge segment must not skim through any other vertex,
      // otherwise the merged polygon gets a zero-width touch point.
      for (const ringIdxs of blockedBy) {
        if (!visible) break;
        for (const wi of ringIdxs) {
          if (wi === vi || wi === mIdx) continue;
          if (strictlyOnSegment(vertices[wi]!, m, v)) {
            visible = false;
            break;
          }
        }
      }
      for (const ringIdxs of blockedBy) {
        if (!visible) break;
        for (let i = 0; i < ringIdxs.length; i++) {
          const aI = ringIdxs[i]!;
          const bI = ringIdxs[(i + 1) % ringIdxs.length]!;
          if (aI === vi || bI === vi || aI === mIdx || bI === mIdx) continue;
          if (segmentsCross(m, v, vertices[aI]!, vertices[bI]!)) {
            visible = false;
            break;
          }
        }
      }
      if (visible) {
        bridgeTo = vi;
        bridgeDist = d;
      }
    }
    if (bridgeTo < 0) {
      throw new Error("triangulation: no visible bridge vertex for hole");
    }

    // Splice the hole (in its stored order, starting after M) plus the
    // return leg M -> bridgeTo into the polygon right after bridgeTo.
    const insertAt = polygon.indexOf(bridgeTo) + 1;
    const walk: number[] = [mIdx];
    for (let k = 1; k <= holeIdxs.length; k++) {
      walk.push(holeIdxs[(bestM + k) % holeIdxs.length]!);
    }
    walk.push(bridgeTo);
    polygon.splice(insertAt, 0, ...walk);
  }
  return polygon;
}

/** Ear-clipping triangulation of a simple polygon given as vertex indices. */
function earClip(vertices: Point2[], polygon: number[]): [number, number, number][] {
  const triangles: [number, number, number][] = [];
  const list = polygon.slice();

  let guard = list.length * list.length + 8;
  while (list.length > 3) {
    if (guard-- <= 0) {
      throw new Error("triangulation: ear clipping failed to converge");
    }
    let clipped = false;
    for (let i = 0; i < list.length; i++) {
      const prevI = list[(i + list.length - 1) % list.length]!;
      const curI = list[i]!;
      const nextI = list[(i + 1) % list.length]!;
      const a = vertices[prevI]!;
      const b = vertices[curI]!;
      const c = vertices[nextI]!;
      if (cross(a, b, c) <= 0) continue; // reflex or degenerate corner

      let isEar = true;
      for (const otherI of list) {
        if (otherI === prevI || otherI === curI || otherI === nextI) continue;
        const p = vertices[otherI]!;
        if (samePoint(p, a) || samePoint(p, b) || samePoint(p, c)) continue;
        if (pointInTriangle(p, a, b, c)) {
          isEar = false;
          break;
        }
      }
      if (isEar) {
        triangles.push([prevI, curI, nextI]);
        list.splice(i, 1);
        clipped = true;
        break;
      }
    }
    if (!clipped) {
      throw new Error("triangulation: no ear found (invalid polygon?)");
    }
  }
  triangles.push([list[0]!, list[1]!, list[2]!]);
  return triangles;
}

/**
 * Triangulate a polygon with holes.
 *
 * @param outer Sanitized outer ring, counter-clockwise.
 * @param holes Sanitized hole rings, clockwise.
 * @returns Vertices (outer first, then holes in order) and CCW triangles
 *          indexing into that vertex array.
 */
export function triangulate(
  outer: Point2[],
  holes: Point2[][],
): { vertices: Point2[]; triangles: [number, number, number][] } {
  const vertices: Point2[] = [];
  const outerRing: Ring = { indices: [] };
  for (const p of outer) {
    outerRing.indices.push(vertices.length);
    vertices.push([p[0], p[1]]);
  }
  const holeRings: Ring[] = holes.map((hole) => {
    const ring: Ring = { indices: [] };
    for (const p of hole) {
      ring.indices.push(vertices.length);
      vertices.push([p[0], p[1]]);
    }
    return ring;
  });

  const polygon = bridgeHoles(vertices, outerRing, holeRings);
  const triangles = earClip(vertices, polygon);
  return { vertices, triangles };
}
