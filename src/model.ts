import type { LabeledRow, Model } from "./types.js";

function mean(rows: number[][]): number[] {
  const dim = rows[0].length;
  const acc = new Array<number>(dim).fill(0);
  for (const f of rows) for (let i = 0; i < dim; i++) acc[i] += f[i];
  return acc.map((v) => v / rows.length);
}

export function trainModel(rows: LabeledRow[]): Model {
  const class0 = rows.filter((r) => r.label === 0).map((r) => r.features);
  const class1 = rows.filter((r) => r.label === 1).map((r) => r.features);
  if (class0.length === 0 || class1.length === 0) {
    throw new Error("training set must contain both classes");
  }
  return { mean0: mean(class0), mean1: mean(class1) };
}

export function squaredDistance(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

export function predict(model: Model, features: number[]): 0 | 1 {
  const d0 = squaredDistance(features, model.mean0);
  const d1 = squaredDistance(features, model.mean1);
  return d0 <= d1 ? 0 : 1;
}

export function uncertaintyScore(model: Model, features: number[]): number {
  const d0 = squaredDistance(features, model.mean0);
  const d1 = squaredDistance(features, model.mean1);
  return Math.abs(d0 - d1);
}
