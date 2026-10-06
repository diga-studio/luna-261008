// Independent mesh verification helpers. These re-derive everything from
// the raw inputs instead of trusting the implementation under test.
import { Mesh, Point2, Polygon } from "../src/mesh";

export function shoelace(ring: Point2[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[(i + 1) % ring.length]!;
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

/** Analytic area of the polygon region (outer minus holes). */
export function regionArea(polygon: Polygon): number {
  let area = Math.abs(shoelace(polygon.outer));
  for (const hole of polygon.holes) area -= Math.abs(shoelace(hole));
  return area;
}

/** Test-local ring cleanup: drop zero-length edges and collinear runs. */
export function cleanRing(points: Point2[]): Point2[] {
  const ring: Point2[] = [];
  for (const [x, y] of points) {
    const last = ring[ring.length - 1];
    if (!last || last[0] !== x || last[1] !== y) ring.push([x, y]);
  }
  while (ring.length > 1) {
    const first = ring[0]!;
    const last = ring[ring.length - 1]!;
    if (first[0] !== last[0] || first[1] !== last[1]) break;
    ring.pop();
  }
  const out: Point2[] = [];
  for (let i = 0; i < ring.length; i++) {
    const prev = ring[(i + ring.length - 1) % ring.length]!;
    const cur = ring[i]!;
    const next = ring[(i + 1) % ring.length]!;
    const cross =
      (cur[0] - prev[0]) * (next[1] - prev[1]) -
      (cur[1] - prev[1]) * (next[0] - prev[0]);
    if (cross !== 0) out.push(cur);
  }
  return out;
}

export interface EdgeReport {
  ok: boolean;
  problems: string[];
}

/**
 * Every undirected index edge must belong to exactly two triangles,
 * traversed in opposite directions (closed, consistently oriented,
 * no cracks, dangling edges, or T-junctions).
 */
export function checkEdgeAdjacency(mesh: Mesh): EdgeReport {
  const directed = new Map<string, string[]>();
  mesh.triangles.forEach(([a, b, c], ti) => {
    const edges: [number, number][] = [
      [a, b],
      [b, c],
      [c, a],
    ];
    for (const [from, to] of edges) {
      const key = from < to ? `${from},${to}` : `${to},${from}`;
      let list = directed.get(key);
      if (!list) directed.set(key, (list = []));
      list.push(`${from}->${to} (tri ${ti})`);
    }
  });
  const problems: string[] = [];
  for (const [key, uses] of directed) {
    if (uses.length !== 2) {
      problems.push(`edge ${key} used ${uses.length}x: ${uses.join("; ")}`);
      continue;
    }
    const [u, v] = key.split(",").map(Number);
    const forward = uses.filter((s) => s.startsWith(`${u}->${v}`)).length;
    if (forward !== 1) {
      problems.push(`edge ${key} not traversed in opposite directions`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Smallest |cross product| over all triangles (0 would mean degenerate). */
export function minTriangleArea2(mesh: Mesh): number {
  let min = Infinity;
  for (const [ia, ib, ic] of mesh.triangles) {
    const a = mesh.vertices[ia]!;
    const b = mesh.vertices[ib]!;
    const c = mesh.vertices[ic]!;
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    min = Math.min(min, cx * cx + cy * cy + cz * cz);
  }
  return min;
}

export type TriClass = "top" | "bottom" | "wall";

export function classify(mesh: Mesh, height: number): TriClass[] {
  return mesh.triangles.map((t) => {
    const zs = t.map((i) => mesh.vertices[i]![2]);
    if (zs.every((z) => z === height)) return "top";
    if (zs.every((z) => z === 0)) return "bottom";
    return "wall";
  });
}

/** Signed 2D area of a triangle projected onto the xy plane. */
function projectedArea(mesh: Mesh, t: [number, number, number]): number {
  const a = mesh.vertices[t[0]]!;
  const b = mesh.vertices[t[1]]!;
  const c = mesh.vertices[t[2]]!;
  return (
    ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2
  );
}

/** Sum of projected signed areas for one class of triangles. */
export function projectedAreaSum(
  mesh: Mesh,
  classes: TriClass[],
  kind: TriClass,
): number {
  let sum = 0;
  mesh.triangles.forEach((t, i) => {
    if (classes[i] === kind) sum += projectedArea(mesh, t);
  });
  return sum;
}

/** 0 = outside, 1 = inside, 2 = on boundary. Ray casting on the raw ring. */
export function pointInRing(p: Point2, ring: Point2[]): number {
  const n = ring.length;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const cross =
      (p[0] - xi) * (yj - yi) - (p[1] - yi) * (xj - xi);
    const dot = (p[0] - xi) * (p[0] - xj) + (p[1] - yi) * (p[1] - yj);
    if (cross === 0 && dot <= 0 && (xi !== xj || yi !== yj)) return 2;
    if (yi > p[1] !== yj > p[1]) {
      const xInt = xi + ((p[1] - yi) / (yj - yi)) * (xj - xi);
      if (xInt > p[0]) inside = !inside;
    }
  }
  return inside ? 1 : 0;
}

/** Inside the outer ring and outside (or not on) every hole. */
export function pointInRegion(p: Point2, polygon: Polygon): boolean {
  if (pointInRing(p, polygon.outer) !== 1) return false;
  for (const hole of polygon.holes) {
    if (pointInRing(p, hole) !== 0) return false;
  }
  return true;
}

export function triangleCentroid2(
  mesh: Mesh,
  t: [number, number, number],
): Point2 {
  const a = mesh.vertices[t[0]]!;
  const b = mesh.vertices[t[1]]!;
  const c = mesh.vertices[t[2]]!;
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
}

/** Undirected segment key for a 2D segment, exact coordinate based. */
function segKey2(a: Point2, b: Point2): string {
  const s1 = `${a[0]},${a[1]}`;
  const s2 = `${b[0]},${b[1]}`;
  return s1 < s2 ? `${s1}|${s2}` : `${s2}|${s1}`;
}

function sortedKeys(keys: Iterable<string>): string[] {
  return [...keys].sort();
}

/**
 * Boundary segments (at z = level) contributed by wall triangles must
 * exactly match the cleaned input ring edges, as multisets.
 */
export function wallBoundaryEdges(mesh: Mesh, level: 0 | "top", height: number): string[] {
  const z = level === 0 ? 0 : height;
  const keys: string[] = [];
  mesh.triangles.forEach((t) => {
    const pts = t.map((i) => mesh.vertices[i]!);
    // Only wall triangles (mixed z) contribute boundary segments.
    if (pts.every((p) => p[2] === pts[0]![2])) return;
    for (let e = 0; e < 3; e++) {
      const p = pts[e]!;
      const q = pts[(e + 1) % 3]!;
      if (p[2] === z && q[2] === z) {
        keys.push(segKey2([p[0], p[1]], [q[0], q[1]]));
      }
    }
  });
  return keys;
}

export function ringEdgeKeys(polygon: Polygon): string[] {
  const keys: string[] = [];
  const rings = [polygon.outer, ...polygon.holes];
  for (const raw of rings) {
    const ring = cleanRing(raw);
    for (let i = 0; i < ring.length; i++) {
      keys.push(segKey2(ring[i]!, ring[(i + 1) % ring.length]!));
    }
  }
  return keys;
}

export { sortedKeys };
