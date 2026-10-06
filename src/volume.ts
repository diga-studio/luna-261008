import { Mesh } from "./mesh";

/**
 * Signed volume of a triangle mesh, computed from vertices and triangle
 * indices only: sum of dot(a, cross(b, c)) / 6 over all triangles.
 * Positive for outward-oriented closed meshes; flipping every triangle
 * negates the result.
 */
export function signedVolume(mesh: Mesh): number {
  let sum = 0;
  for (const [ia, ib, ic] of mesh.triangles) {
    const a = mesh.vertices[ia]!;
    const b = mesh.vertices[ib]!;
    const c = mesh.vertices[ic]!;
    const crossX = b[1] * c[2] - b[2] * c[1];
    const crossY = b[2] * c[0] - b[0] * c[2];
    const crossZ = b[0] * c[1] - b[1] * c[0];
    sum += a[0] * crossX + a[1] * crossY + a[2] * crossZ;
  }
  return sum / 6;
}
