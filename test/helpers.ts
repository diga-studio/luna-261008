import { DataRow, ExperimentData, Kernel, RoundResult, Strategy } from "../src/types";
import { mulberry32 } from "../src/prng";

export const DATA_SEED = 20261006;
export const EXP_SEED = 424242;

export const DIMS = 8;
export const SEED_ROWS = 20;
export const POOL_ROWS = 100;
export const VAL_ROWS = 40;

function makeRows(startId: number, count: number, rand: () => number): DataRow[] {
  const rows: DataRow[] = [];
  for (let i = 0; i < count; i++) {
    const label = i % 2 === 0 ? 0 : 1;
    const features: number[] = [];
    for (let d = 0; d < DIMS; d++) {
      const center = label === 0 ? 0 : 1;
      features.push(center + (rand() - 0.5) * 1.4);
    }
    rows.push({ id: startId + i, features, label: label as 0 | 1 });
  }
  return rows;
}

/** deterministic synthetic dataset; pool labels act as the hidden truth */
export function makeData(dataSeed: number = DATA_SEED): ExperimentData {
  const rand = mulberry32(dataSeed);
  const seed = makeRows(1, SEED_ROWS, rand);
  const pool = makeRows(1001, POOL_ROWS, rand);
  const validation = makeRows(5001, VAL_ROWS, rand);
  return { seed, pool, validation };
}

/** run rounds 1..20 for a strategy until the pool is exhausted */
export function runToCompletion(kernel: Kernel, experimentId: string, strategy: Strategy): RoundResult[] {
  const results: RoundResult[] = [];
  for (let round = 1; round <= 20; round++) {
    try {
      results.push(kernel.runRound(experimentId, strategy, round));
    } catch (err) {
      if (err instanceof Error && err.message === "pool exhausted") break;
      throw err;
    }
  }
  return results;
}
