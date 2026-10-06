import type { ExperimentData } from "../src/index.js";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeData(opts: {
  genSeed?: number;
  seedRows?: number;
  poolRows?: number;
  valRows?: number;
  dim?: number;
}): ExperimentData {
  const { genSeed = 42, seedRows = 6, poolRows = 200, valRows = 40, dim = 8 } = opts;
  const rand = mulberry32(genSeed);
  let nextId = 1;
  const row = (label: 0 | 1) => {
    const center = label === 0 ? 0 : 1;
    const features = Array.from({ length: dim }, () => center + (rand() - 0.5) * 1.5);
    return { id: nextId++, features, label };
  };
  const seed = Array.from({ length: seedRows }, (_, i) => row((i % 2) as 0 | 1));
  const pool = Array.from({ length: poolRows }, () => {
    const r = row((rand() < 0.5 ? 0 : 1) as 0 | 1);
    return { id: r.id, features: r.features, truth: r.label };
  });
  const validation = Array.from({ length: valRows }, () => row((rand() < 0.5 ? 0 : 1) as 0 | 1));
  return { seed, pool, validation };
}
