import { test } from "node:test";
import assert from "node:assert/strict";
import { extrude, signedVolume, Mesh, Polygon, Vec2, Vec3 } from "../src/index";

const EPS = 1e-9;

function ringArea(ring: Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

/** Analytic area of the region: |outer| - sum(|holes|). */
function regionArea(polygon: Polygon): number {
  let area = Math.abs(ringArea(polygon.outer));
  for (const hole of polygon.holes) area -= Math.abs(ringArea(hole));
  return area;
}

/** Every undirected edge must appear in exactly two triangles, traversed both ways. */
function assertManifold(mesh: Mesh): void {
  const edges = new Map<string, string[]>();
  for (const [a, b, c] of mesh.triangles) {
    for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
      const key = `${Math.min(p, q)}_${Math.max(p, q)}`;
      const list = edges.get(key) ?? [];
      list.push(`${p}>${q}`);
      edges.set(key, list);
    }
  }
  for (const [key, list] of edges) {
    assert.equal(list.length, 2, `edge ${key} belongs to ${list.length} triangles`);
    const [p1, q1] = list[0]!.split(">");
    const [p2, q2] = list[1]!.split(">");
    assert.ok(p1 === q2 && p2 === q1, `edge ${key} traversed twice in same direction`);
  }
}

function triangleNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

function assertNonDegenerate(mesh: Mesh): void {
  for (const [ia, ib, ic] of mesh.triangles) {
    const n = triangleNormal(mesh.positions[ia]!, mesh.positions[ib]!, mesh.positions[ic]!);
    const len = Math.hypot(n[0], n[1], n[2]);
    assert.ok(len > EPS, `degenerate triangle ${ia},${ib},${ic}`);
  }
}

function isTopVertex(p: Vec3, height: number): boolean {
  return p[2] === height;
}

/** Sum of absolute areas of all cap triangles at the given z level. */
function capArea(mesh: Mesh, z: number): number {
  let area = 0;
  for (const [ia, ib, ic] of mesh.triangles) {
    const a = mesh.positions[ia]!;
    const b = mesh.positions[ib]!;
    const c = mesh.positions[ic]!;
    if (a[2] === z && b[2] === z && c[2] === z) {
      const n = triangleNormal(a, b, c);
      area += Math.abs(n[2]) / 2;
    }
  }
  return area;
}

function pointInRing2d(p: Vec2, ring: Vec2[]): boolean {
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

function pointInTriangle2d(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const d1 = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  const d2 = (c[0] - b[0]) * (p[1] - b[1]) - (c[1] - b[1]) * (p[0] - b[0]);
  const d3 = (a[0] - c[0]) * (p[1] - c[1]) - (a[1] - c[1]) * (p[0] - c[0]);
  const hasNeg = d1 < -EPS || d2 < -EPS || d3 < -EPS;
  const hasPos = d1 > EPS || d2 > EPS || d3 > EPS;
  return !(hasNeg && hasPos);
}

/**
 * Sample a grid over the bounding box: a point strictly inside the region
 * must be covered by exactly one top-cap triangle, and a point outside the
 * region (including inside holes) by none.
 */
function assertTopCoverage(mesh: Mesh, polygon: Polygon, height: number): void {
  const topTris: [Vec2, Vec2, Vec2][] = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of polygon.outer) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  for (const [ia, ib, ic] of mesh.triangles) {
    const tri = [mesh.positions[ia]!, mesh.positions[ib]!, mesh.positions[ic]!];
    if (tri.every((p) => isTopVertex(p, height))) {
      topTris.push([
        [tri[0]![0], tri[0]![1]],
        [tri[1]![0], tri[1]![1]],
        [tri[2]![0], tri[2]![1]],
      ]);
    }
  }
  const steps = 60;
  for (let i = 1; i < steps; i++) {
    for (let j = 1; j < steps; j++) {
      const p: Vec2 = [
        minX + ((maxX - minX) * i) / steps,
        minY + ((maxY - minY) * j) / steps,
      ];
      // Skip points near any ring boundary to avoid ambiguous classification.
      let nearBoundary = false;
      for (const ring of [polygon.outer, ...polygon.holes]) {
        for (let k = 0; k < ring.length; k++) {
          const a = ring[k]!;
          const b = ring[(k + 1) % ring.length]!;
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const d =
            Math.abs(
              (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
            ) / len;
          const t =
            ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) /
            (len * len);
          if (d < 1e-6 && t > -1e-9 && t < 1 + 1e-9) nearBoundary = true;
        }
      }
      if (nearBoundary) continue;
      let inRegion = pointInRing2d(p, polygon.outer);
      for (const hole of polygon.holes) {
        if (pointInRing2d(p, hole)) inRegion = false;
      }
      let cover = 0;
      for (const [a, b, c] of topTris) {
        if (pointInTriangle2d(p, a, b, c)) cover++;
      }
      if (inRegion) {
        assert.ok(cover >= 1, `region point ${p} not covered by top cap`);
      } else {
        assert.equal(cover, 0, `void point ${p} covered by ${cover} top triangles`);
      }
    }
  }
}

function reverseRing(ring: Vec2[]): Vec2[] {
  return ring.slice().reverse();
}

function rotateRing(ring: Vec2[], shift: number): Vec2[] {
  const n = ring.length;
  return ring.map((_, i) => ring[(i + shift) % n]!);
}

function flipMesh(mesh: Mesh): Mesh {
  return {
    positions: mesh.positions,
    triangles: mesh.triangles.map(([a, b, c]) => [a, c, b] as [number, number, number]),
  };
}

const CONCAVE_OUTER: Vec2[] = [
  [0, 0], [10, 0], [10, 10], [7, 10], [7, 4], [3, 4], [3, 10], [0, 10],
];
const HOLE_RECT: Vec2[] = [[1, 6], [2, 6], [2, 9], [1, 9]];
const HOLE_QUAD: Vec2[] = [[8, 1], [9.5, 1], [9, 3], [8, 2]];
const HEIGHT = 5;

test("concave outer ring with two holes: closed, covered, correct volume", () => {
  const polygon: Polygon = { outer: CONCAVE_OUTER, holes: [HOLE_RECT, HOLE_QUAD] };
  const mesh = extrude(polygon, HEIGHT);
  const expected = regionArea(polygon) * HEIGHT;

  assertManifold(mesh);
  assertNonDegenerate(mesh);
  assertTopCoverage(mesh, polygon, HEIGHT);
  assert.ok(Math.abs(capArea(mesh, 0) - regionArea(polygon)) < EPS);
  assert.ok(Math.abs(capArea(mesh, HEIGHT) - regionArea(polygon)) < EPS);
  assert.ok(Math.abs(signedVolume(mesh) - expected) < EPS * expected);

  const flipped = flipMesh(mesh);
  assert.ok(Math.abs(signedVolume(flipped) + expected) < EPS * expected);
});

test("winding direction and start point do not change the result", () => {
  const base: Polygon = { outer: CONCAVE_OUTER, holes: [HOLE_RECT, HOLE_QUAD] };
  const expected = regionArea(base) * HEIGHT;
  const variants: Polygon[] = [
    { outer: reverseRing(CONCAVE_OUTER), holes: [HOLE_RECT, HOLE_QUAD] },
    { outer: CONCAVE_OUTER, holes: [reverseRing(HOLE_RECT), reverseRing(HOLE_QUAD)] },
    { outer: rotateRing(CONCAVE_OUTER, 3), holes: [rotateRing(HOLE_RECT, 2), HOLE_QUAD] },
    {
      outer: rotateRing(reverseRing(CONCAVE_OUTER), 5),
      holes: [rotateRing(reverseRing(HOLE_RECT), 1), rotateRing(reverseRing(HOLE_QUAD), 3)],
    },
  ];
  for (const variant of variants) {
    const mesh = extrude(variant, HEIGHT);
    assertManifold(mesh);
    assertNonDegenerate(mesh);
    assertTopCoverage(mesh, variant, HEIGHT);
    assert.ok(Math.abs(signedVolume(mesh) - expected) < EPS * expected);
  }
});

test("rings with collinear runs, duplicate points and closing duplicates produce a seam-free closed mesh", () => {
  // Outer square with collinear runs, consecutive duplicates and a closing
  // duplicate; hole likewise, both with arbitrary (here CW) winding.
  const messyOuter: Vec2[] = [
    [0, 0], [0, 0], [2, 0], [4, 0], [4, 0], [4, 0], [6, 0],
    [6, 2], [6, 4], [6, 6], [4, 6], [2, 6], [2, 6], [0, 6],
    [0, 4], [0, 2], [0, 0],
  ];
  const messyHole: Vec2[] = [
    [2, 2], [2, 4], [2, 4], [3, 4], [4, 4], [4, 3], [4, 2], [3, 2], [2, 2],
  ];
  const polygon: Polygon = { outer: messyOuter, holes: [messyHole] };
  const mesh = extrude(polygon, HEIGHT);
  const expected = regionArea(polygon) * HEIGHT;

  assertManifold(mesh);
  assertNonDegenerate(mesh);
  assertTopCoverage(mesh, polygon, HEIGHT);
  assert.ok(Math.abs(signedVolume(mesh) - expected) < EPS * expected);
});

test("signedVolume only depends on vertices and indices", () => {
  const polygon: Polygon = { outer: CONCAVE_OUTER, holes: [HOLE_RECT, HOLE_QUAD] };
  const mesh = extrude(polygon, HEIGHT);
  const expected = regionArea(polygon) * HEIGHT;
  // Translating the mesh must not change its signed volume.
  const shifted: Mesh = {
    positions: mesh.positions.map(([x, y, z]) => [x + 100, y - 40, z + 7] as Vec3),
    triangles: mesh.triangles,
  };
  assert.ok(Math.abs(signedVolume(shifted) - expected) < 1e-6 * expected);
});

test("extrude rejects non-positive height", () => {
  const polygon: Polygon = { outer: CONCAVE_OUTER, holes: [] };
  assert.throws(() => extrude(polygon, 0));
  assert.throws(() => extrude(polygon, -3));
});
