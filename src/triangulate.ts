import { Vec2 } from "./types";

export interface RingInfo {
  start: number;
  count: number;
}

export interface PreparedPolygon {
  /** Cleaned, oriented ring vertices flattened: outer (CCW) first, then holes (CW). */
  points: Vec2[];
  /** Slice info per ring; rings[0] is the outer ring. */
  rings: RingInfo[];
  /** CCW triangles over `points` indices covering outer minus holes. */
  triangles: [number, number, number][];
}

function cross3(a: Vec2, b: Vec2, c: Vec2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function eq(a: Vec2, b: Vec2): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function signedArea(ring: Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

/** Remove closing duplicates, consecutive duplicates and collinear points. */
function cleanRing(ring: Vec2[]): Vec2[] {
  let pts = ring.map((p) => [p[0], p[1]] as Vec2);
  while (pts.length > 1 && eq(pts[0]!, pts[pts.length - 1]!)) {
    pts.pop();
  }
  let changed = true;
  while (changed) {
    changed = false;
    const out: Vec2[] = [];
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[(i - 1 + pts.length) % pts.length]!;
      const curr = pts[i]!;
      const next = pts[(i + 1) % pts.length]!;
      if (eq(prev, curr)) {
        changed = true;
        continue;
      }
      if (!eq(curr, next) && cross3(prev, curr, next) === 0) {
        const dot =
          (curr[0] - prev[0]) * (next[0] - curr[0]) +
          (curr[1] - prev[1]) * (next[1] - curr[1]);
        if (dot >= 0) {
          changed = true;
          continue;
        }
      }
      out.push(curr);
    }
    pts = out;
  }
  if (pts.length < 3) {
    throw new Error("ring degenerates to fewer than 3 distinct points");
  }
  return pts;
}

function segmentsProperlyIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o1 = cross3(a, b, c);
  const o2 = cross3(a, b, d);
  const o3 = cross3(c, d, a);
  const o4 = cross3(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

function onOpenSegment(p: Vec2, a: Vec2, b: Vec2): boolean {
  if (eq(p, a) || eq(p, b)) return false;
  if (cross3(a, b, p) !== 0) return false;
  return (
    Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1])
  );
}

/** Ray-casting containment; point must not lie on the ring boundary. */
function pointInRing(p: Vec2, ring: Vec2[]): boolean {
  let inside = false;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    if (a[1] > p[1] !== b[1] > p[1]) {
      const x = a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
      if (x > p[0]) inside = !inside;
    }
  }
  return inside;
}

/**
 * A bridge segment may not cross any ring edge or previous bridge, and may
 * not pass through any vertex other than its own endpoints.
 */
function segmentClear(
  a: Vec2,
  b: Vec2,
  rings: Vec2[][],
  extraEdges: [Vec2, Vec2][]
): boolean {
  const edges: [Vec2, Vec2][] = extraEdges.slice();
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      edges.push([ring[i]!, ring[(i + 1) % ring.length]!]);
    }
  }
  for (const [c, d] of edges) {
    if (segmentsProperlyIntersect(a, b, c, d)) return false;
    if (onOpenSegment(c, a, b) || onOpenSegment(d, a, b)) return false;
  }
  return true;
}

/**
 * Merge holes into the outer ring via bridge edges, producing a single
 * weakly-simple CCW polygon as a list of indices into `pts`.
 */
function mergeHoles(pts: Vec2[], rings: RingInfo[]): number[] {
  const outer = rings[0]!;
  let merged: number[] = [];
  for (let i = 0; i < outer.count; i++) merged.push(outer.start + i);

  const extraEdges: [Vec2, Vec2][] = [];
  const allRings = rings.map((r) => pts.slice(r.start, r.start + r.count));

  // Process holes rightmost-point-first, descending x.
  const holeOrder: { ring: number; hi: number }[] = [];
  for (let r = 1; r < rings.length; r++) {
    const info = rings[r]!;
    let hi = 0;
    for (let i = 1; i < info.count; i++) {
      const p = pts[info.start + i]!;
      const best = pts[info.start + hi]!;
      if (p[0] > best[0] || (p[0] === best[0] && p[1] > best[1])) hi = i;
    }
    holeOrder.push({ ring: r, hi });
  }
  holeOrder.sort((a, b) => {
    const pa = pts[rings[a.ring]!.start + a.hi]!;
    const pb = pts[rings[b.ring]!.start + b.hi]!;
    return pb[0] - pa[0];
  });

  for (const { ring, hi } of holeOrder) {
    const info = rings[ring]!;
    const holeId = info.start + hi;
    const hv = pts[holeId]!;

    let bestIdx = -1;
    let bestDist = Infinity;
    for (let k = 0; k < merged.length; k++) {
      const candId = merged[k]!;
      if (candId === holeId) continue;
      const cv = pts[candId]!;
      const mid: Vec2 = [(hv[0] + cv[0]) / 2, (hv[1] + cv[1]) / 2];
      if (!pointInRing(mid, allRings[0]!)) continue;
      let inHole = false;
      for (let r = 1; r < allRings.length; r++) {
        if (pointInRing(mid, allRings[r]!)) {
          inHole = true;
          break;
        }
      }
      if (inHole) continue;
      if (!segmentClear(hv, cv, allRings, extraEdges)) continue;
      const dist =
        (hv[0] - cv[0]) * (hv[0] - cv[0]) + (hv[1] - cv[1]) * (hv[1] - cv[1]);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = k;
      }
    }
    if (bestIdx < 0) {
      throw new Error("no visible bridge vertex found for hole");
    }

    const rotated: number[] = [];
    for (let i = 0; i < info.count; i++) {
      rotated.push(info.start + ((hi + i) % info.count));
    }
    merged = merged
      .slice(0, bestIdx + 1)
      .concat(rotated, [rotated[0]!], merged.slice(bestIdx));
    extraEdges.push([hv, pts[merged[bestIdx]!]!]);
  }
  return merged;
}

function inOrOnTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  return (
    cross3(a, b, p) >= 0 && cross3(b, c, p) >= 0 && cross3(c, a, p) >= 0
  );
}

/** Ear-clipping triangulation of a weakly-simple CCW polygon. */
function earClip(ids: number[], pts: Vec2[]): [number, number, number][] {
  let maxAbs = 1;
  for (const p of pts) {
    maxAbs = Math.max(maxAbs, Math.abs(p[0]), Math.abs(p[1]));
  }
  const eps = 1e-9 * maxAbs * maxAbs;

  const triangles: [number, number, number][] = [];
  const list = ids.slice();
  while (list.length > 3) {
    let clipped = false;
    for (let i = 0; i < list.length; i++) {
      const ia = list[(i - 1 + list.length) % list.length]!;
      const ib = list[i]!;
      const ic = list[(i + 1) % list.length]!;
      const a = pts[ia]!;
      const b = pts[ib]!;
      const c = pts[ic]!;
      if (cross3(a, b, c) <= eps) continue;
      let blocked = false;
      for (const iu of list) {
        if (iu === ia || iu === ib || iu === ic) continue;
        const u = pts[iu]!;
        // Bridge endpoints appear twice in the merged polygon; a duplicate
        // sitting exactly on an ear corner does not invalidate the ear.
        if (eq(u, a) || eq(u, b) || eq(u, c)) continue;
        // Inclusive test: a vertex on the ear boundary (e.g. collinear with
        // the closing edge) would become a crack or overlap if clipped.
        if (inOrOnTriangle(u, a, b, c)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      triangles.push([ia, ib, ic]);
      list.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      throw new Error("ear clipping failed: no ear found");
    }
  }
  if (list.length === 3) {
    const a = pts[list[0]!]!;
    const b = pts[list[1]!]!;
    const c = pts[list[2]!]!;
    if (cross3(a, b, c) > eps) {
      triangles.push([list[0]!, list[1]!, list[2]!]);
    }
  }
  return triangles;
}

/**
 * Clean, orient and triangulate a polygon with holes.
 * Outer ring is made CCW, holes CW; triangles are CCW (normal +Z).
 */
export function preparePolygon(outer: Vec2[], holes: Vec2[][]): PreparedPolygon {
  const rings2d: Vec2[][] = [];
  const outerClean = cleanRing(outer);
  rings2d.push(signedArea(outerClean) > 0 ? outerClean : outerClean.reverse());
  for (const hole of holes) {
    const h = cleanRing(hole);
    rings2d.push(signedArea(h) < 0 ? h : h.reverse());
  }

  const points: Vec2[] = [];
  const rings: RingInfo[] = [];
  for (const ring of rings2d) {
    rings.push({ start: points.length, count: ring.length });
    for (const p of ring) points.push(p);
  }

  const merged = mergeHoles(points, rings);
  const triangles = earClip(merged, points);
  return { points, rings, triangles };
}
