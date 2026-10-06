# SitePlan Studio — Building Footprint Extrusion

Extrude 2D polygons with holes along +Z into closed, outward-oriented
triangle meshes for rendering and volume accounting. Coordinates and height
are in feet, right-handed coordinate system, `height > 0`.

## API

```ts
import { extrude, signedVolume } from "./src";

const mesh = extrude(
  {
    outer: [[0, 0], [10, 0], [10, 10], [0, 10]],
    holes: [[[2, 2], [4, 2], [4, 4], [2, 4]]],
  },
  12
);
// mesh.positions: [x, y, z][] (bottom cap at z=0, top cap at z=height)
// mesh.triangles: [i, j, k][] index triples, outward-oriented

const volume = signedVolume(mesh); // positive for outward-oriented closed mesh
```

- `extrude(polygon, height)` — polygon is `{ outer, holes }`, each ring a
  list of `[x, y]` points. Rings may have any winding and start point, and
  may contain consecutive duplicate points, a repeated closing point, and
  consecutive collinear points (all normalized internally). The returned
  mesh is closed and manifold: every undirected edge belongs to exactly two
  triangles with opposite directions; outer walls face outward, hole walls
  face into the hole.
- `signedVolume(mesh)` — signed volume from vertices and triangle indices
  only (divergence theorem). Reversing every triangle flips the sign.

## Develop

```sh
npm install
npm test        # compiles with tsc and runs node:test suites
npm run build
```
