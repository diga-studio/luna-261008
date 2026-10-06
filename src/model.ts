import { DataRow, Label } from "./types";

export interface ClassMeans {
  means: [number[], number[]];
  dims: number;
}

export function squaredDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return sum;
}

/** feature means per class over the given labeled rows; both classes must be present */
export function classMeans(rows: Pick<DataRow, "features" | "label">[]): ClassMeans {
  if (rows.length === 0) throw new Error("cannot train on empty rows");
  const dims = rows[0].features.length;
  const sums: [number[], number[]] = [
    new Array<number>(dims).fill(0),
    new Array<number>(dims).fill(0),
  ];
  const counts: [number, number] = [0, 0];
  for (const row of rows) {
    if (row.features.length !== dims) throw new Error("inconsistent feature dimensions");
    for (let i = 0; i < dims; i++) sums[row.label][i] += row.features[i];
    counts[row.label]++;
  }
  if (counts[0] === 0 || counts[1] === 0) throw new Error("both classes must be present");
  const means = [0, 1].map((c) => sums[c as Label].map((s) => s / counts[c as Label])) as [number[], number[]];
  return { means, dims };
}

/** predicted class = smaller squared distance to class mean; ties resolve to 0 */
export function predict(model: ClassMeans, features: number[]): Label {
  const d0 = squaredDistance(features, model.means[0]);
  const d1 = squaredDistance(features, model.means[1]);
  return d0 <= d1 ? 0 : 1;
}

export function accuracy(model: ClassMeans, rows: Pick<DataRow, "features" | "label">[]): number {
  if (rows.length === 0) throw new Error("empty validation set");
  let correct = 0;
  for (const row of rows) if (predict(model, row.features) === row.label) correct++;
  return correct / rows.length;
}

/** ascending by |d0-d1|, ties by id ascending; returns up to k ids in selection order */
export function selectUncertainty(
  pool: Pick<DataRow, "id" | "features">[],
  model: ClassMeans,
  k: number
): number[] {
  const scored = pool.map((row) => {
    const d0 = squaredDistance(row.features, model.means[0]);
    const d1 = squaredDistance(row.features, model.means[1]);
    return { id: row.id, margin: Math.abs(d0 - d1) };
  });
  scored.sort((a, b) => (a.margin !== b.margin ? a.margin - b.margin : a.id - b.id));
  return scored.slice(0, k).map((s) => s.id);
}
