import { test } from "node:test";
import * as assert from "node:assert/strict";
import { extrude } from "../src/extrude";
import { signedVolume } from "../src/volume";
import { Mesh, Point2, Polygon } from "../src/mesh";
import {
  checkEdgeAdjacency,
  classify,
  minTriangleArea2,
  pointInRegion,
  projectedAreaSum,
  regionArea,
  ringEdgeKeys,
  sortedKeys,
  triangleCentroid2,
  wallBoundaryEdges,
} from "./meshcheck";

const TOL = 1e-9;

function close(actual: number, expected: number, label: string): void {
  const scale = Math.max(1, Math.abs(expected));
  assert.ok(
    Math.abs(actual - expected) <= TOL * scale,
    `${label}: got ${actual}, expected ${expected}`,
  );
}

/** Full independent verification of an extruded mesh. */
function verifyMesh(mesh: Mesh, polygon: Polygon, height: number): void {
  // 1. Closed, consistently oriented manifold: every undirected edge is
  //    shared by exactly two oppositely directed triangles.
  const adjacency = checkEdgeAdjacency(mesh);
  assert.ok(adjacency.ok, adjacency.problems.join("\n"));

  // 2. No degenerate triangles.
  assert.ok(
    minTriangleArea2(mesh) > 1e-12,
    "mesh contains a degenerate triangle",
  );

  // 3. Cap coverage: projected signed area of top and bottom caps equals
  //    the analytic region area, with correct orientation.
  const classes = classify(mesh, height);
  const area = regionArea(polygon);
  close(projectedAreaSum(mesh, classes, "top"), area, "top cap area");
  close(projectedAreaSum(mesh, classes, "bottom"), -area, "bottom cap area");

  // 4. Every cap triangle centroid lies inside the polygon region.
  mesh.triangles.forEach((t, i) => {
    const kind = classes[i]!;
    if (kind === "wall") return;
    const centroid = triangleCentroid2(mesh, t);
    assert.ok(
      pointInRegion(centroid, polygon),
      `${kind} triangle ${i} centroid outside region`,
    );
  });

  // 5. Walls share their boundary edges with the caps: wall edges at
  //    z = 0 and z = height exactly match the cleaned input ring edges.
  const ringEdges = sortedKeys(ringEdgeKeys(polygon));
  assert.deepEqual(
    sortedKeys(wallBoundaryEdges(mesh, 0, height)),
    ringEdges,
    "wall/cap shared boundary at z = 0",
  );
  assert.deepEqual(
    sortedKeys(wallBoundaryEdges(mesh, "top", height)),
    ringEdges,
    "wall/cap shared boundary at z = height",
  );

  // 6. Volume equals analytic area times height.
  close(signedVolume(mesh), area * height, "signed volume");
}

function rotate<T>(ring: T[], k: number): T[] {
  const n = ring.length;
  return ring.map((_, i) => ring[(i + k) % n]!);
}

function reversed<T>(ring: T[]): T[] {
  return ring.slice().reverse();
}

// Concave outer ring (an L-shape with a notch) and two holes.
const OUTER: Point2[] = [
  [0, 0],
  [12, 0],
  [12, 5],
  [7, 5],
  [7, 3],
  [4, 3],
  [4, 8],
  [0, 8],
];
const HOLE_A: Point2[] = [
  [1, 1],
  [3, 1],
  [3, 2.5],
  [1, 2.5],
];
const HOLE_B: Point2[] = [
  [8, 1],
  [11, 1.5],
  [10, 4],
  [8.5, 3.5],
];
const HEIGHT = 6.5;

function basePolygon(): Polygon {
  return { outer: OUTER, holes: [HOLE_A, HOLE_B] };
}

test("concave outer ring with two holes: winding and start point invariance", () => {
  const variants: Polygon[] = [
    basePolygon(),
    { outer: reversed(OUTER), holes: [HOLE_A, HOLE_B] },
    { outer: rotate(OUTER, 3), holes: [rotate(HOLE_A, 2), HOLE_B] },
    { outer: OUTER, holes: [reversed(HOLE_A), reversed(HOLE_B)] },
    {
      outer: reversed(rotate(OUTER, 5)),
      holes: [reversed(rotate(HOLE_B, 1)), rotate(HOLE_A, 1)],
    },
  ];

  const expectedVolume = regionArea(basePolygon()) * HEIGHT;
  const volumes: number[] = [];
  for (const variant of variants) {
    const mesh = extrude(variant, HEIGHT);
    verifyMesh(mesh, variant, HEIGHT);
    volumes.push(signedVolume(mesh));
  }
  for (const v of volumes) {
    close(v, expectedVolume, "volume invariant under ring reparameterization");
  }
});

test("rings with collinear runs, duplicate points, and duplicate closing points", () => {
  const outer: Point2[] = [
    [0, 0],
    [0, 0], // consecutive duplicate
    [4, 0],
    [8, 0], // collinear with neighbours
    [12, 0],
    [12, 6],
    [12, 12], // collinear
    [12, 12], // consecutive duplicate
    [6, 12],
    [6, 12],
    [0, 12],
    [0, 6], // collinear
    [0, 3], // collinear
    [0, 0], // duplicate closing point
  ];
  const hole: Point2[] = [
    [3, 3],
    [3, 3],
    [6, 3],
    [9, 3], // collinear
    [9, 6],
    [9, 9],
    [6, 9], // collinear
    [3, 9],
    [3, 6], // collinear
    [3, 3], // duplicate closing point
  ];
  const polygon: Polygon = { outer, holes: [hole] };
  const height = 4;

  const mesh = extrude(polygon, height);
  verifyMesh(mesh, polygon, height);

  // Every ring edge is shared between a cap and a wall (no seams), which
  // verifyMesh checks via exact multiset equality of boundary segments.
  // Additionally the mesh must reference every vertex it declares.
  const used = new Set<number>();
  for (const t of mesh.triangles) for (const i of t) used.add(i);
  assert.equal(used.size, mesh.vertices.length, "no dangling vertices");
});

test("signedVolume flips sign when every triangle is reversed", () => {
  const mesh = extrude(basePolygon(), HEIGHT);
  const flipped: Mesh = {
    vertices: mesh.vertices,
    triangles: mesh.triangles.map(([a, b, c]) => [a, c, b]),
  };
  close(signedVolume(flipped), -signedVolume(mesh), "flipped volume");
  assert.ok(signedVolume(mesh) > 0, "outward orientation gives positive volume");
});

test("centered hole: bridge must not skim through hole vertices", () => {
  // Regression: the straight bridge from the hole's rightmost vertex to
  // the nearest outer corner would pass exactly through another hole
  // vertex; the bridge selection must avoid such degenerate channels.
  const polygon: Polygon = {
    outer: [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
    holes: [
      [
        [2, 2],
        [4, 2],
        [4, 4],
        [2, 4],
      ],
    ],
  };
  const mesh = extrude(polygon, 5);
  verifyMesh(mesh, polygon, 5);
});

test("rejects non-positive height", () => {
  assert.throws(() => extrude(basePolygon(), 0));
  assert.throws(() => extrude(basePolygon(), -2));
});
