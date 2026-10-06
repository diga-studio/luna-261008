/**
 * Deterministic per-step duration sampler.
 *
 * The raw sample for a step depends only on (seed, round, caseId, stepIndex)
 * and the activity's sample multiset. It never depends on capacity, removals,
 * scheduling, or input ordering of cases/samples.
 */
export interface DurationSampler {
  /** Pick a raw sample from `samples` (uniform by index => weighted by occurrence count). */
  sample(caseId: string, stepIndex: number, samples: number[]): number;
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const TWO_POW_53 = 9007199254740992;

interface WeightedTable {
  /** Distinct sample values, ascending. */
  values: number[];
  /** Cumulative occurrence counts, aligned with `values`. */
  cum: number[];
  total: number;
}

const tableCache = new WeakMap<number[], WeightedTable>();

/**
 * Build an order-independent weighted view of a sample multiset: identical
 * multisets produce identical tables regardless of input order, so shuffling
 * the caller's sample array cannot change sampling outcomes.
 */
function tableFor(samples: number[]): WeightedTable {
  let table = tableCache.get(samples);
  if (table === undefined) {
    const counts = new Map<number, number>();
    for (const s of samples) counts.set(s, (counts.get(s) ?? 0) + 1);
    const values = [...counts.keys()].sort((a, b) => a - b);
    const cum: number[] = [];
    let acc = 0;
    for (const v of values) {
      acc += counts.get(v) ?? 0;
      cum.push(acc);
    }
    table = { values, cum, total: acc };
    tableCache.set(samples, table);
  }
  return table;
}

/** FNV-1a 64-bit over UTF-16 code units, finished with a splitmix64-style mixer. */
function hashKey(key: string): bigint {
  let h = FNV_OFFSET;
  for (let i = 0; i < key.length; i++) {
    h ^= BigInt(key.charCodeAt(i));
    h = BigInt.asUintN(64, h * FNV_PRIME);
  }
  h = BigInt.asUintN(64, h + 0x9e3779b97f4a7c15n);
  h = BigInt.asUintN(64, (h ^ (h >> 30n)) * 0xbf58476d1ce4e5b9n);
  h = BigInt.asUintN(64, (h ^ (h >> 27n)) * 0x94d049bb133111ebn);
  h ^= h >> 31n;
  return h;
}

/** Create a sampler bound to a seed and round. */
export function createSampler(seed: number | string, round: number): DurationSampler {
  const prefix = `${String(seed)}|${round}|`;
  return {
    sample(caseId: string, stepIndex: number, samples: number[]): number {
      // JSON.stringify of the case id makes the key unambiguous for any ASCII id.
      const key = prefix + caseId.length + ":" + caseId + "|" + stepIndex;
      const h = hashKey(key);
      const u = Number(h >> 11n) / TWO_POW_53;
      const table = tableFor(samples);
      const target = u * table.total;
      // First index whose cumulative count strictly exceeds the target.
      let lo = 0;
      let hi = table.cum.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((table.cum[mid] as number) > target) hi = mid;
        else lo = mid + 1;
      }
      return table.values[lo] ?? 0;
    },
  };
}
