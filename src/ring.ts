import { Point2 } from "./mesh";

function cross(o: Point2, a: Point2, b: Point2): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Signed area of a ring; positive means counter-clockwise. */
export function signedArea(ring: Point2[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    sum += p[0] * q[1] - q[0] * p[1];
  }
  return sum / 2;
}

/**
 * Clean a raw input ring:
 * - drop consecutive duplicate points and a duplicated closing point,
 * - drop points that lie on the straight segment between their neighbours
 *   (consecutive collinear points).
 * Returns a new array; the input is not modified.
 */
export function sanitizeRing(points: Point2[]): Point2[] {
  const ring: Point2[] = [];
  for (const p of points) {
    const last = ring[ring.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) {
      ring.push([p[0], p[1]]);
    }
  }
  while (
    ring.length > 1 &&
    ring[0]![0] === ring[ring.length - 1]![0] &&
    ring[0]![1] === ring[ring.length - 1]![1]
  ) {
    ring.pop();
  }

  let changed = true;
  while (changed && ring.length > 2) {
    changed = false;
    for (let i = 0; i < ring.length; i++) {
      const prev = ring[(i + ring.length - 1) % ring.length]!;
      const cur = ring[i]!;
      const next = ring[(i + 1) % ring.length]!;
      if (cross(prev, cur, next) !== 0) continue;
      const dot =
        (cur[0] - prev[0]) * (cur[0] - next[0]) +
        (cur[1] - prev[1]) * (cur[1] - next[1]);
      if (dot <= 0) {
        ring.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return ring;
}

/** Return a ring with the requested winding (copy; input untouched). */
export function ensureWinding(ring: Point2[], ccw: boolean): Point2[] {
  const isCcw = signedArea(ring) > 0;
  if (isCcw === ccw) return ring.slice();
  return ring.slice().reverse();
}
